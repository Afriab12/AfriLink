# AfriLink Moderation Database Design

**Status:** DESIGN ONLY — proposed for owner review. No `moderation` schema, migration, or dependency has been created. `schema.prisma` and `database/migrations/` are unmodified by this document.
**Date:** 2026-09-23
**Scope:** Concrete database design for `moderation.reports`, `moderation.cases`, `moderation.case_reports`, `moderation.actions`, `moderation.appeals`, `moderation.sanctions` — at the same level of detail `database.md` §11 (Media) had before that schema was implemented, and matching the level of detail `docs/04-database/media.md` was written at.
**Not in scope:** any implementation (Prisma models, migration SQL, dependencies, API, workers), audit (`audit.events` — §13 of `database.md`, a separate module), feed, search, admin dashboard UI, legal escalation process, exact sanction durations/SLA tiers as numeric policy, or changes to any other module's schema (gaps found in other modules' schemas during this review are flagged in §13, not fixed here).

Source documents read for this design: `CLAUDE.md`; `docs/01-product/PRD.md` §3 (personas), §7 (goals), §17/§19 (post/comment reporting), §22 (messaging moderation), §25 (community moderation), §26–29 (Reporting, Blocking, Moderation, Admin dashboard), §33 (approved decision log); `docs/03-architecture/architecture.md` §7 (module table), §11 (RBAC), §13 (feed invalidation), §20 (Moderation architecture), §24 (risk table); `docs/04-database/database.md` §2, §3, §12, §17, §18, §20; `docs/04-database/media.md` (structure/format precedent, and its own `AssetModerationState`); `docs/10-decisions/decisions.md` ADR-001 §2 (Moderation) and §3 (Retention); the current `database/schema.prisma` in full, specifically `UserStatus`, `ContentStatus`, `MessageModerationState`, `AssetModerationState`, `CommunityMembershipStatus`, `Block`, `Notification` (its `targetType`/`targetId` polymorphic pattern), `Share`, `Conversation`, and `Community.status`.

---

## 1. Moderation database overview

Moderation is a new PostgreSQL schema, `moderation`, owned exclusively by the Moderation module. Unlike Media (which introduced entirely new state — nothing tracked upload/asset lifecycle before it existed), **every module Moderation acts on already carries its own enforcement-state field**, added in earlier phases specifically to receive moderation outcomes:

| Module / table | Field | Values |
|---|---|---|
| `identity.users` | `status` (`UserStatus`) | `active, restricted, suspended, banned, pending_deletion, deleted` |
| `content.posts` / `content.comments` | `status` (`ContentStatus`) | `published, hidden, removed` |
| `messaging.messages` | `moderationState` (`MessageModerationState`) | `active, hidden, removed` |
| `media.assets` | `moderationState` (`AssetModerationState`) | `active, hidden, removed` |
| `community.memberships` | `status` (`CommunityMembershipStatus`) | `pending, active, rejected, left, removed, banned` |

This is the central architectural fact this design is built around: **`moderation.*` is a workflow, audit-trail, and current-restriction-index schema — it does not duplicate enforcement state.** The enforcement flag other modules actually check at read/write time (auth guards, visibility filters, send/post authorization) lives on the target's own row, in the target's own schema, exactly as `architecture.md` §1's ownership principle requires. `moderation.actions` is the append-only record of *what happened and why*; `moderation.sanctions` is a queryable *current-state index* of active restrictions (so "is this user currently suspended" doesn't require scanning `moderation.actions` history) — see §5 and §7's cross-module contract for exactly how an action reaches the target's own field.

`moderation.reports` and `moderation.cases` handle intake and triage and have no equivalent existing state anywhere else — those are genuinely new, same as Media's tables were.

## 2. Entity model

```
moderation.reports        — user-submitted reports (intake)
moderation.cases          — moderator work queue (triage)
moderation.case_reports   — join: which reports belong to which case
moderation.actions        — append-only record of enforcement taken
moderation.appeals        — user appeal of an action
moderation.sanctions      — current-state index of active restrictions
```

Reports feed cases (many reports can describe the same underlying problem and get triaged together — `database.md` §12: "link reports through `moderation.case_reports`"). A case produces zero or more actions. An action may produce a sanction (an ongoing restriction) and may be appealed. This mirrors ADR-001 §2's flow: report → queue → human review → action → (optional) appeal.

## 3. `moderation.reports`

| Field | Type | Notes |
|---|---|---|
| `id` | uuid7 PK | |
| `reporterUserId` | uuid, FK → `identity.users.id`, `onDelete: Restrict` | Matches `Message.senderId`'s existing precedent — user rows are never hard-deleted (deletion is modeled as `UserStatus.deleted` + anonymization elsewhere), so `Restrict` is safe and consistent, not a new pattern. |
| `targetType` | `ReportTargetType` enum | `profile, post, comment, share, message, conversation, community` — see target-reference strategy below. |
| `targetId` | uuid | No FK — deliberately polymorphic, same pattern `Notification.targetType`/`targetId` already uses in this exact schema (`schema.prisma` lines ~1020–1024, "deliberately no FK"). `database.md` §12 names this exact tradeoff explicitly ("PostgreSQL cannot enforce a foreign key to multiple target tables") and this design adopts the same resolution Notification already shipped with, for consistency rather than inventing a second pattern. |
| `reasonCode` | `ReportReasonCode` enum | `spam, harassment, hate, impersonation, scam_fraud, violence, sexual_content, misinformation, other` — **already approved**, PRD §33's decision log lists this exact taxonomy verbatim (cited there as ADR-002; see §14 note on that citation). |
| `description` | text, nullable | Optional supporting context, PRD §26. |
| `status` | `ReportStatus` enum | **Proposed, §15: `open, under_review, closed, duplicate`** (4 values) — the report's own intake lifecycle only; the actual outcome (action taken or not) lives on the case/action, not duplicated here. |
| `dedupKey` | text, nullable | Computed app-side (hash of `reporterUserId + targetType + targetId + reasonCode`); a partial unique index `WHERE status IN ('open','under_review')` prevents the *same reporter* filing duplicate active reports on the same target/reason. **Deliberately scoped to the same reporter only** — see §15 item 4 for why cross-reporter reports are not collapsed this way. |
| `priority` | nullable, same as `cases.priority` (§4) | Optional at intake; a case's priority is authoritative. |
| `createdAt`, `updatedAt` | timestamptz | |
| `resolvedAt` | timestamptz, nullable | Set when `status` leaves `open`/`under_review`. |

Indexes: `(status, priority, createdAt)` and `(targetType, targetId)`, exactly as `database.md` §12 specifies.

### Target-reference strategy (resolves the open tradeoff `database.md` §12 names)

`database.md` §12 explicitly poses the choice: polymorphic app-resolved target vs. a separate report table per target type. This design recommends **polymorphic**, for one concrete reason beyond convenience: `Notification` already made this exact choice in the current, applied schema, for the same underlying problem (one row needs to reference any of several unrelated tables). Introducing a second, different pattern (six separate report tables) for a structurally identical problem would be inconsistent without a documented reason to diverge, and `case_reports`/`actions` would inherit the same fan-out. The cost — no DB-level referential integrity, and a periodic integrity-check job to catch orphaned `targetId`s — is the same cost already accepted for `Notification` and is proposed to be paid once, the same way.

`targetType = profile` resolves to `identity.users.id` (not a separate `social.profiles.id` lookup) — moderation actions on a profile (suspend/ban/restrict) act on the user, and `social.profiles` is 1:1 with `identity.users` with no independent lifecycle of its own.

## 4. `moderation.cases`

| Field | Type | Notes |
|---|---|---|
| `id` | uuid7 PK | |
| `queue` | **`ModerationScope` enum (reused, §6)** | **Proposed, §15 item 5: reuse `ModerationScope` (`platform, community, content, messaging`) instead of a new taxonomy** — a case's triage queue and its eventual action's enforcement scope are the same underlying concept, so one enum serves both rather than inventing a second, parallel vocabulary. |
| `assignedModeratorId` | uuid, FK → `identity.users.id`, nullable, `onDelete: Restrict` | Null = unassigned/in the shared pool. |
| `status` | `CaseStatus` enum | **Proposed, §15: `open, in_review, closed`** (3 values — simplified from an earlier 4-value draft; see §15 item 1). |
| `priority` | `CasePriority` enum | **Proposed, §15: `low, normal, high, critical`** (4 values) — `critical` is not invented: PRD §28/`architecture.md` §20 use that exact word ("critical safety/security cases prioritized faster"). Tier *definitions* (what makes a case critical) remain deferred policy, per `architecture.md` §20; only the label set is proposed here. |
| `slaDueAt` | timestamptz, nullable | Structural placeholder for whatever SLA policy is eventually approved; not computed by this design. |
| `source` | `CaseSource` enum | **Proposed, §15: `user_report, automated_signal, escalation`** (3 values) — each already named in an approved document: "user reporting" and "automated filtering" (ADR-001 §2), "escalation" (`architecture.md` §17: "Serious cases escalate to platform Moderation"). |
| `createdAt`, `updatedAt`, `closedAt` | timestamptz | |

## 5. `moderation.case_reports`

Composite PK `(caseId, reportId)`, matching the existing `PostMedia`/`MessageAttachment` composite-PK join-table pattern already used twice in this schema for "many-to-many, no independent lifecycle" relationships:

```
caseId   uuid  FK -> moderation.cases.id   onDelete: Cascade
reportId uuid  FK -> moderation.reports.id onDelete: Restrict
```

`Cascade` on the case side (deleting a case's join rows is meaningless without the case) but `Restrict` on the report side (a report is evidence; it must not silently vanish because a case row was removed) — same asymmetric-cascade reasoning already applied to `PostMedia`/`MessageAttachment` (`assetId` is `Restrict`, the owning row's FK is `Cascade`).

## 6. `moderation.actions`

| Field | Type | Notes |
|---|---|---|
| `id` | uuid7 PK | |
| `caseId` | uuid, FK → `moderation.cases.id`, `onDelete: Restrict` | Every action traces to a case — no case-less actions, so triage is always auditable to its source. |
| `actorId` | uuid, FK → `identity.users.id`, `onDelete: Restrict`, nullable | Nullable for system/automated actions (mirrors `Notification.actorUserId`'s exact reasoning: "Null for system-originated ... that have no acting user"). |
| `targetType` / `targetId` | same `ReportTargetType` polymorphic pair as `reports` | An action's target may differ in *type* from the triggering report(s) in edge cases (e.g. a report against a post results in an account-level action) — kept as its own pair, not inherited from the case, for that reason. |
| `actionType` | `ModerationActionType` enum | `remove_content, restrict_content, warn_user, suspend_account, ban_account, restrict_community_participation` — **already approved**, ADR-001 §2's exact list ("Moderators may: Remove content / Restrict content / Warn users / Suspend accounts / Ban accounts / Restrict community participation"), adopted verbatim, not invented here. |
| `scope` | `ModerationScope` enum | `platform, community, content, messaging` — **already approved**, `database.md` §12 states this exact requirement verbatim for sanctions ("Scope must distinguish platform, community, content, and messaging restrictions"); reused here since an action and the sanction it may produce share the same scope vocabulary. |
| `reasonCode` | reuses `ReportReasonCode` | Keeps action reasons in the same closed vocabulary as report reasons rather than a second free-form field. |
| `duration` / `startsAt` / `endsAt` | interval or nullable timestamptz pair | Null `endsAt` = indefinite (e.g. a ban). |
| `reversalOfActionId` | uuid, FK → `moderation.actions.id`, nullable, self-referential | `database.md` §12: "corrections are compensating actions, not destructive updates" — a correction is a new row pointing back at the action it reverses, never an `UPDATE`/`DELETE` on the original. |
| `createdAt` | timestamptz | No `updatedAt` — table is append-only by design, matching `database.md` §12's explicit instruction. |

## 7. Cross-module enforcement contract

This is the part `database.md` §12's prose doesn't specify and this design must propose concretely, since it's the mechanism that makes §1's "no duplicated state" claim actually true.

**Recommended shape:**

1. **Immediate, synchronous enforcement.** When an action is recorded, the Moderation module calls a narrow method the *target's own module* exposes for exactly this purpose, inside the same transaction as the `moderation.actions` insert, so enforcement is never "recorded but not yet applied." This is the same shape `MediaAccessService` already established for Media: a narrow, purpose-built cross-module contract method, not raw cross-schema table access (`architecture.md` §1: "a module may query another module through a repository/application contract, not by reaching into another module's tables from arbitrary code").
2. **Downstream/secondary effects go through the existing outbox**, not the synchronous path — notifying the actioned user, feed/search invalidation (`architecture.md` §13: "Deletions, hides, blocks, sanctions, and privacy changes trigger invalidation or rebuild work"), and any other at-least-once, replay-safe downstream work. This reuses `integration.outbox_events`, already built, rather than inventing a second event mechanism.
3. **`moderation.sanctions` is the queryable current-state index**, updated in the same transaction as the target's own field, so "does this user currently have an active platform sanction" is one indexed lookup against `moderation.sanctions`, not a scan of `moderation.actions` history or a cross-module call into five different services on every authorization check.

### Proposed method signatures (§15 item 6)

Illustrative, for early alignment — final parameter/return shapes are each target module's own decision when actually implemented, the same way `MediaAccessService`'s final shape was only fixed during Media's own implementation, not dictated by an earlier module's design document. Each apply method is idempotent (safe to call twice with the same target+state) and each has a matching lift method for reversal/expiry:

| Module | Method | Effect |
|---|---|---|
| Identity (Users) | `applyAccountSanction(userId, status: 'suspended' \| 'banned', sanctionId): Promise<void>` | Sets `User.status`. **Must also invalidate active sessions** (`identity.sessions`) — `UserStatus` alone does not revoke an already-issued JWT access token; the auth guard must additionally re-check current `User.status` on every request (not only at login), otherwise a suspended user keeps working until their access token naturally expires. This session-revocation detail is new information this design surfaces; it is not decided elsewhere and needs its own confirmation when Identity/Auth's own code is touched. |
| Identity (Users) | `liftAccountSanction(userId): Promise<void>` | Reverts `User.status` to `active`. Used by sanction expiry and by appeal-overturned reversal. |
| Content | `applyContentModerationStatus(targetType: 'post' \| 'comment', targetId, status: 'hidden' \| 'removed'): Promise<void>` | Sets `Post.status`/`Comment.status` (`ContentStatus`). One method, `targetType`-dispatched, rather than two near-identical methods. |
| Content | `applyShareModerationStatus(shareId, status): Promise<void>` | Only if §17's `Share.moderationState` addition is approved — see §17. |
| Messaging | `applyMessageModerationStatus(messageId, state: 'hidden' \| 'removed'): Promise<void>` | Sets `Message.moderationState`. |
| Messaging | `applyConversationModerationStatus(conversationId, state): Promise<void>` | Only if §17's `Conversation.moderationState` addition is approved — see §17. |
| Media | `applyAssetModerationStatus(assetId, state: 'hidden' \| 'removed'): Promise<void>` | Sets `Asset.moderationState` — a new method on the existing `MediaAccessService`, not a new service. |
| Community | `applyMembershipSanction(membershipId, status: 'removed' \| 'banned'): Promise<void>` | Sets `CommunityMembership.status`. |
| Community | `liftMembershipSanction(membershipId): Promise<void>` | Reverts to `active` on reversal/expiry. Whether a lifted member must be re-invited or is simply reactivated is Community's own membership-lifecycle decision, not resolved here. |

`warn_user` has no corresponding apply method — a warning is communication only (delivered via the existing Notifications path), never a state change on any target row.

## 8. `moderation.appeals`

| Field | Type | Notes |
|---|---|---|
| `id` | uuid7 PK | |
| `actionId` | uuid, FK → `moderation.actions.id`, `onDelete: Restrict` | |
| `appellantUserId` | uuid, FK → `identity.users.id`, `onDelete: Restrict` | |
| `statement` | text | The user's appeal text. |
| `state` | `AppealState` enum | **Proposed, §15: `submitted, under_review, upheld, overturned`** (4 values — dropped a `withdrawn` value from an earlier draft: nothing in the PRD describes user-initiated appeal withdrawal as an MVP feature, so it isn't included without a concrete need). |
| `reviewerId` | uuid, FK → `identity.users.id`, nullable, `onDelete: Restrict` | Must differ from the original action's `actorId` — a reviewer-differs-from-actor rule is an application-layer check (no DB constraint can express "different moderator"); flagged as a judgment call to confirm when the API/authorization layer is built, not a schema-level concern. |
| `decision` | text, nullable | Reviewer's written decision/rationale. |
| `appealDeadline` | timestamptz | Computed at creation from the 72-hour target (ADR-001 §2 / PRD §28), but stored as a concrete timestamp, not derived at read time, so the deadline is stable even if the policy number changes later. |
| `createdAt`, `updatedAt`, `decidedAt` | timestamptz | |

One active appeal per action is enforced via a partial unique index `(actionId) WHERE state IN ('submitted','under_review')`, per `database.md` §12: "Enforce one active appeal per applicable action unless policy allows multiple levels." No multi-level appeal policy is approved anywhere, so this design assumes single-level only.

**Appeal eligibility, §15 item 3 — proposed: every `actionType` except `warn_user` is appeal-eligible.** ADR-001 §2 says "Appeal *eligible* moderation decisions," implying some aren't; `warn_user` is the one clean exclusion because it has no enforcement consequence to reverse — there is nothing an overturned appeal would undo. `remove_content`/`restrict_content` are included even though they don't produce an ongoing `moderation.sanctions` row (§9) — losing a post or having it hidden is a real, reversible-in-principle consequence to the affected user regardless of whether Moderation tracks it as an ongoing "sanction," and nothing in the PRD excludes content actions from appeal rights. This is enforced at the application layer when an appeal is created (reject appeal creation where `action.actionType = 'warn_user'`), not by a DB constraint.

## 9. `moderation.sanctions`

| Field | Type | Notes |
|---|---|---|
| `id` | uuid7 PK | |
| `subjectType` | enum | `user, community` — a sanction's subject is narrower than a report/action's target: only account- and community-level restrictions are *ongoing* states; content removal/restriction is a one-time action with no ongoing "sanction" row (the content's own `status` already reflects it permanently). See §15 item 2. |
| `subjectId` | uuid | Paired with `subjectType`, same polymorphic reasoning as `reports.targetType`/`targetId`, narrowed to the two subject kinds that actually have ongoing restriction states. |
| `scope` | `ModerationScope` (reused from §6) | `platform, community, content, messaging` — matches `database.md` §12 verbatim. |
| `sanctionType` | `SanctionType` enum | **Proposed, §15 item 2: `account_suspended, account_banned, community_restricted`** (3 values — see the action→sanction mapping reasoning below). |
| `reasonCode` | reuses `ReportReasonCode` | |
| `sourceActionId` | uuid, FK → `moderation.actions.id`, `onDelete: Restrict` | Every sanction traces to the action that created it. |
| `startsAt` / `endsAt` | timestamptz, `endsAt` nullable | Null = indefinite. |
| `state` | `SanctionState` enum | **Proposed, §15: `active, expired, revoked, superseded`** (4 values, unchanged from the first draft — all four are load-bearing, see reasoning below). |
| `createdAt`, `updatedAt` | timestamptz | |

Index: `(subjectType, subjectId, state)` for the "is this subject currently sanctioned" lookup §7 depends on; partial index `WHERE state = 'active'` recommended, following the same "partial indexes exclude non-active rows" convention `database.md` §18 already states as a general standard.

### Action → sanction mapping (§15 item 2) — confirming the proposed reasoning

Your reasoning is correct: `suspend_account`, `ban_account`, and `restrict_community_participation` are the three action types that produce an ongoing `moderation.sanctions` row; `remove_content`, `restrict_content`, and `warn_user` do not, because they're one-time — the target's own field (`ContentStatus`, or nothing at all for a warning) already carries the outcome permanently, with no separate "is this still in effect" question to answer later.

One correction this review surfaced while confirming it: `restrict_community_participation` is a single approved action type, but `CommunityMembershipStatus` has two terminal outcomes it can drive — `removed` (may rejoin later, per community policy) and `banned` (permanent). This design does not split `restrict_community_participation` into two action types for that — the specific outcome (`removed` vs `banned`) is a parameter of the action, not a second `actionType`, and `sanctionType = community_restricted` covers both uniformly (the authoritative removed-vs-banned detail lives on `CommunityMembership.status` itself, per §7's ownership principle). An earlier draft of this document had `community_restricted` and `community_banned` as two separate sanction types plus an `account_restricted` type with no action type that could ever produce it — all three were dropped in this revision as unreachable/unnecessary once checked against the actual six approved action types.

All four `SanctionState` values are load-bearing, not just filling out a round number: `active` (in effect), `expired` (`endsAt` reached naturally), `revoked` (a deliberate early reversal — most notably, an appeal overturning the action that created the sanction transitions it to `revoked`, not `expired`), `superseded` (a new action on the same subject+scope replaces this one, e.g. a suspension escalated to a ban — keeps history instead of deleting the earlier row).

## 10. Reporter anonymity & evidence access

`PRD` §26: "Reporting must avoid exposing reporter identity or sensitive case details unnecessarily." This is an application-layer authorization rule, not a schema feature — `moderation.reports.reporterUserId` is a normal FK column; the enforcement is that no API surface returns it to the reported party, and access to it (and to case evidence generally) is restricted to authorized moderator/admin roles (`architecture.md` §11 RBAC: "Platform roles ... least privilege ... support, moderator, senior moderator, operations, security administrator"). This document records the requirement; it does not (and structurally cannot) enforce it — that belongs to the eventual API/authorization implementation, same division of responsibility Media used between its schema design and its later storage/API design.

## 11. Retention

ADR-001 §3 gives two relevant, already-approved rules: general deleted-content retention (90 days) does **not** govern moderation/audit records — "Moderation and security records may be retained as necessary for safety, appeals, abuse prevention and legal obligations," with no specific numeric duration approved. This document does **not** invent one, matching the explicit instruction this task and Media's design both operated under (don't invent policy numbers). `moderation.reports`, `.cases`, `.actions`, `.appeals`, `.sanctions` are therefore designed with no automatic purge path — `deletedAt`-style soft delete is deliberately absent from `moderation.actions` (append-only, §6) and not proposed for the others either, since nothing approved says moderation records are ever user-facing-deletable the way a post or message is.

## 12. Indexing and constraints

- `reports`: `(status, priority, createdAt)`, `(targetType, targetId)`, partial unique `dedupKey` index as in §3.
- `cases`: `(status, priority, createdAt)` for queue listing (cursor-paginated per `decisions.md` ADR-004 §5's already-approved shape), `(assignedModeratorId, status)`.
- `case_reports`: composite PK covers both directions; no extra index needed at MVP volume.
- `actions`: `(caseId)`, `(targetType, targetId, createdAt)` for "history of actions against this target."
- `appeals`: partial unique `(actionId) WHERE state IN ('submitted','under_review')` (§8); `(state, appealDeadline)` for SLA-tracking queries.
- `sanctions`: `(subjectType, subjectId, state)` with a partial index `WHERE state='active'` (§9); `(endsAt) WHERE state='active'` to support an eventual expiry sweep, mirroring the pattern `media.md` used for upload expiry (though — same as Media's M-1 — designing the index now does not imply a sweep job exists yet; that would be its own tracked follow-up if approved).

All foreign keys used in filtering/joins are indexed, per `database.md` §18's general standard.

## 13. Security

- Evidence (report descriptions, case notes, appeal statements) is standard PostgreSQL row data, access-gated at the application/RBAC layer (§10) — no column-level encryption is proposed beyond what already applies platform-wide.
- `reasonCode`/`actionType`/`scope` closed enums prevent free-text injection into fields that drive authorization/enforcement logic — same reasoning `database.md` §17 rule 4 already states generally ("Check constraints prevent invalid state combinations").
- No moderation table stores passwords, tokens, or message bodies (`CLAUDE.md` security section) — `targetId` pointing at a message references it by ID only; the message body itself is never copied into `moderation.reports`/`actions`.
- Appeal `reviewerId != action.actorId` (§8) is a fraud/conflict-of-interest control (a moderator should not review their own action's appeal) — flagged as app-layer, not DB-enforced, since Postgres cannot compare across two different tables' rows in a CHECK constraint.

## 14. Migration / existing-schema impact

No changes to any other module's schema are made by Moderation's own migration. Three gaps were found while checking what Moderation would need to target; §17 below proposes two of them as their own separate, small change requests (owner-approved direction, not yet implemented), and records the third as a documentation-only convention.

No FK is added from any other schema's tables to `moderation.*` in this design (matching Media's own choice not to add FKs the other direction into `media.assets` from every possible attaching table) — all cross-references are the polymorphic `targetType`/`targetId`/`subjectType`/`subjectId` pattern from §3/§9.

## 15. Decisions — proposed resolutions (owner review requested)

Each item below was genuinely open after the first draft of this document; concrete resolutions are proposed here for approval before the schema diff is drafted.

1. **Exact enum value sets.** Proposed throughout §3–§9, summarized: `ReportStatus: open, under_review, closed, duplicate` (4) · `CaseStatus: open, in_review, closed` (3) · `CasePriority: low, normal, high, critical` (4, `critical` grounded in PRD §28/`architecture.md` §20's own wording) · `CaseSource: user_report, automated_signal, escalation` (3, each grounded in ADR-001 §2 / `architecture.md` §17) · `AppealState: submitted, under_review, upheld, overturned` (4) · `SanctionState: active, expired, revoked, superseded` (4) · `SanctionType: account_suspended, account_banned, community_restricted` (3). Each set was deliberately kept to the smallest number of values that covers a real, named distinction — nothing was added "to be safe."
2. **Action → sanction mapping — confirmed as you proposed**, with one correction: `suspend_account`/`ban_account`/`restrict_community_participation` produce sanctions, `remove_content`/`restrict_content`/`warn_user` don't (full reasoning in §9). The correction: `restrict_community_participation` doesn't need two sanction types for "removed" vs "banned" — one `community_restricted` type covers both, with the specific outcome living on `CommunityMembership.status` itself. **Resolved separately, after the Community callee was implemented (K.1 — see §16):** of the two `CommunityMembership.status` values this action type can write, only `banned` is an actual enforcement outcome; `removed` is the ordinary staff/owner removal value and does not restrict re-entry. This is an application-layer calling-convention decision, not a schema change — `SanctionType.community_restricted` and this table's own mapping are unaffected.
3. **Appeal eligibility — proposed: every action type except `warn_user`.** Full reasoning in §8.
4. **Cross-reporter deduplication scope — recommend against collapsing reports from *different* reporters via the `dedupKey` mechanism at all.** `dedupKey` prevents one reporter mechanically spamming duplicate rows; independent reports from different users about the same target are a real signal (more reporters can mean higher severity/urgency) that a literal-duplicate constraint would destroy if it collapsed them. The correct mechanism for "these five reports are about the same underlying problem" is triage-time **consolidation**, not intake-time **deduplication** — `moderation.case_reports` already exists for exactly this (§5): a moderator (or an automated pre-triage step) links multiple independent reports to one `moderation.cases` row, keeping every report intact while working them together. No schema change needed beyond what §5 already has; this closes the question by using an existing mechanism rather than adding a new one.
5. **Case `queue`/`source` taxonomies — proposed: `queue` reuses `ModerationScope` (§4, no new enum needed); `source` is its own small `CaseSource` enum (item 1 above).**
6. **Cross-module enforcement contract methods — proposed in §7's table.** Structural shape (synchronous apply + outbox for secondary effects) is fixed; each method's exact final signature remains that target module's own call when it's actually implemented, same as `MediaAccessService`'s precedent.

**Note on ADR-002:** PRD §33 and `architecture.md` cite "ADR-002" repeatedly as the source of the approved report taxonomy, appeal SLA target, and several other already-resolved items — but no `ADR-002-*.md` file exists in `docs/10-decisions/` (only ADR-001, ADR-003, ADR-004, plus the two untracked/unapproved ADR-005/007 and the tracked ADR-006). The content itself *is* present, inline, in PRD.md's "approved decision log" section, so this design treats those specific items (report taxonomy, action list, appeal target, scope vocabulary) as genuinely approved and cites them directly — but the missing standalone ADR-002 file is a pre-existing documentation gap this design did not create and does not fix.

No ADR is proposed for the items above, following the same precedent `media.md` §14 recorded: these are schema-level judgment calls, resolved here by proposal and recorded for owner approval, not escalated to a new ADR.

## 16. Reviewer-differs-from-actor & other residual judgment calls

One item remains genuinely deferred, not because it's undecided but because it belongs to a later phase, not this schema document; two others below were resolved once the Community callee was actually implemented and reviewed:

- **Session invalidation on account sanction** (§7's `applyAccountSanction` note) — the auth guard must re-check `User.status` per-request, not only at login; this is new information surfaced by this review, to be confirmed when Identity/Auth code is actually touched, not decided in a database design document.
- **Resolved — whether a lifted community member is auto-reactivated or must be re-invited** (§7's `liftMembershipSanction` note): auto-reactivated. `liftMembershipSanction` restores the *same* `CommunityMembership` row directly to `active`, never creates a new row, and never re-evaluates `community.membershipPolicy` — an overturned/reversed moderation action restores the prior relationship rather than treating the member as a fresh join request. Implemented and mutation-tested in `CommunityModerationService` (commit `11826fc`).
- **Resolved — K.1: which `CommunityMembership.status` value actually enforces `restrict_community_participation`.** Not identified until the Community callee was implemented and reviewed against `MembershipsService.join()`'s existing re-entry guard, which only blocks `banned`, not `removed`. **Decision:** `restrict_community_participation` must always resolve to `status: 'banned'` when it calls `applyMembershipSanction` — `removed` remains exclusively the ordinary, non-moderation staff/owner "kick" outcome, which stays rejoinable exactly as it already is. `CommunityMembership.status` remains the sole per-member enforcement state; no schema change, no new column, no new relationship, and `moderation.sanctions`/`moderation.actions` continue to represent the moderation action exactly per the already-approved schema in this document (a `community_restricted` sanction's `subjectType`/`subjectId` remain community-level, per §9/§15 item 2 — this decision does not change that shape, it only fixes which membership-status value the *action*, executed via Community's own callee, must write).

## 17. Related, separately-approved schema additions (not part of Moderation's own migration)

Per your approval, these two are proposed as their own small, separate change requests — each needs its own review and its own migration when actually implemented, owned by Content and Messaging respectively, not bundled into `moderation`'s migration. The third item needs no schema change at all.

### 17a. `content.shares.moderationState` (Content module)

**Proposed:** add one field to `Share`, reusing the existing `ContentStatus` enum verbatim (not a new type) — `Post` and `Comment` already use it, and a share is content-schema too:

```prisma
model Share {
  ...
  status ContentStatus @default(published)
  ...
}
```

Distinguishes "removed by moderator" from an ordinary user-initiated unshare (`deletedAt`, already present), the same distinction `ContentStatus` already draws for posts/comments. `Share.status` would use the identical `published/hidden/removed` vocabulary — no separate enum, no separate migration pattern to learn. This is Content's own schema change; it needs Content-module review and its own migration, not Moderation's.

### 17b. `messaging.conversations.moderationState` (Messaging module)

**Proposed:** add one field to `Conversation`, reusing the existing `MessageModerationState` enum verbatim (not a new type) — `Message` already uses it:

```prisma
model Conversation {
  ...
  moderationState MessageModerationState @default(active) @map("moderation_state")
  ...
}
```

Gives a whole conversation the same `active/hidden/removed` state its individual messages already have, closing the gap §14 (prior draft) identified: PRD §22 lists conversations as reportable, but only per-message state existed. This is Messaging's own schema change; it needs Messaging-module review and its own migration, not Moderation's.

### 17c. `community.communities.status` — documentation only, no schema change

Per your direction: leave as free text (unchanged from today). This document records `"removed"` as the conventional value a `restrict_community_participation`-class action against an entire community (not just one member) should write into that field, for consistency if/when Communities' own module gives it a real enum later. No `schema.prisma` edit accompanies this item.

## 18. Recommended implementation sequence

1. Approve or amend §15's proposed resolutions and §17's two separate schema-change proposals.
2. Draft the concrete Prisma models for `moderation.reports`, `.cases`, `.case_reports`, `.actions`, `.appeals`, `.sanctions` — for review, the same way this document was.
3. Separately: Content-module review and migration for §17a; Messaging-module review and migration for §17b — each its own small, independently reviewed change, not bundled into Moderation's migration.
4. Moderation's own migration, applied to local dev only, verified against existing conventions (partial-unique/CHECK patterns in raw SQL, matching every prior migration).
5. Decide and get explicit approval for the §7 cross-module contract's concrete method shapes, module by module, before any target module's own code changes.
6. Moderation API implementation (`/reports`, `/moderation/cases`, appeals per `api.md` §15/§17), following the same tests-first, mutation-checked, EXPLAIN-verified process used for Communities and Media.
