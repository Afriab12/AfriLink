# AfriLink Moderation API Design

**Status:** DESIGN ONLY — proposed for owner review. No controller, service, DTO, module, guard, or route exists. No `schema.prisma`, migration, or dependency change accompanies this document. **Patched 2026-09-24 (same day, later revision):** `JwtAuthGuard`/`OptionalJwtAuthGuard` request-time session/account-status enforcement shipped (commit `a267312`, CI green) — §9 below is updated to reflect this as done, not proposed. All 13 original open questions plus the account-sanction appeal-reachability question (previously "#14") are now resolved by owner decision or existing-convention evidence — see **Decisions recorded** at the end of this document, which replaces the old "Open questions" section. Two items remain genuinely open (conversation-level appeal standing; exact message-removal-placeholder wording) and are marked as such there, not silently closed.
**Date:** 2026-09-24 (patched same day — see Status above)
**Scope:** REST API design for `moderation.reports`, `.cases`, `.case_reports`, `.actions`, `.appeals`, `.sanctions` (schema committed `42fe6dd6`, applied to `afrilink_dev`), at the same level of detail `docs/05-api/media.md` was written at before Media's API was implemented.
**Not in scope:** application code, DTOs-as-code, guards-as-code, schema/migration changes, dependency installs, Admin dashboard UI, Audit (`audit.events`), Feed, Search.

Source documents read: `CLAUDE.md`; `database/schema.prisma` (`moderation.*` models, `identity.UserRole`/`Role`/`Permission`); `docs/04-database/moderation.md`; `docs/04-database/database.md` §12/§17; `docs/05-api/api.md` (full — versioning §3, auth §4, authorization §5, error model §6, envelope §7, pagination §9, filtering §10, rate limiting §11, idempotency §12, security §17, Phase 2 contracts §15); `docs/03-architecture/architecture.md` §11 (RBAC), §20 (Moderation architecture); `docs/10-decisions/decisions.md` ADR-001 §2, ADR-004 §5/§8; and the current implementation of `services/api/src/communities/*`, `notifications/*`, `media/*`, `common/*` for conventions (guard order, `AccessService` pattern, cursor utility, exception vocabulary).

**Load-bearing finding, still current as of the 2026-09-24 patch:** no platform-role authorization mechanism exists anywhere in the codebase today. `identity.roles`/`identity.permissions`/`identity.user_roles` exist in the schema (Phase 1) but have zero seeded rows and zero application-code consumers — reconfirmed against current `main` (commit `a267312`): `grep -rn "UserRole" services/api/src` still returns nothing outside `Community`-scoped role checks (which `architecture.md` §11 explicitly says "cannot grant platform authority"), and JWT claims are still exactly `{ sub, sid }` — no role claim, unaffected by the auth-guard changes that same commit shipped. **Nearly every moderator-facing endpoint below depends on this not existing yet being resolved first** — see §8.

---

## 1. API module structure

New NestJS module `ModerationModule`, mirroring `MediaModule`'s shape (a handful of focused controllers over one module, one access service):

```
src/moderation/
  moderation.module.ts
  reports.controller.ts        # /reports, /me/reports, /moderation/reports
  cases.controller.ts          # /moderation/cases
  actions.controller.ts        # /moderation/cases/{caseId}/actions, /moderation/actions/{id}
  appeals.controller.ts        # /moderation/actions/{id}/appeal, /me/appeals, /moderation/appeals
  sanctions.controller.ts      # /me/sanctions, /moderation/sanctions
  reports.service.ts
  cases.service.ts
  actions.service.ts
  appeals.service.ts
  sanctions.service.ts
  moderation-access.service.ts # exported — the cross-module contract surface (§7)
  dto/...
```

Five controllers over five thin resource services, matching the one-controller-per-resource-family pattern already used by Communities (`communities.controller.ts`, `memberships.service.ts`, `invitations.service.ts` as separate files under one module). `ModerationAccessService` is exported from `ModerationModule`, the same role `MediaAccessService` plays for Media — the one thing other modules are allowed to import from Moderation.

## 2. Reports

| Method | Path | Purpose | Auth |
|---|---|---|---|
| `POST` | `/reports` | Submit a report | Authenticated, CSRF, `Idempotency-Key` |
| `GET` | `/me/reports` | The caller's own submitted reports (cursor) | Authenticated, self-scoped |
| `GET` | `/reports/{reportId}` | Read one report | Authenticated — reporter (own) or moderator |
| `GET` | `/moderation/reports` | Moderator queue/list of all reports (cursor, filterable) | Moderator |

**`POST /reports` body:**
```json
{ "targetType": "post", "targetId": "01J...", "reasonCode": "spam", "description": "optional, ≤1000 chars" }
```
`targetType` ∈ the 7 `ReportTargetType` values currently in `database/schema.prisma` (an 8th, `media_asset`, is approved per Decision #11 but not yet applied to the schema — see Cross-module integration §7); `reasonCode` ∈ the 9 approved values. Validation: both enums via `@IsIn`; `targetId` via `@IsUUID`; `description` optional, length-capped, no HTML/markdown interpretation (plain text stored, plain text ever returned). Response `201`:
```json
{ "data": { "id": "01J...", "targetType": "post", "targetId": "01J...", "reasonCode": "spam", "status": "open", "createdAt": "..." } }
```
Never echoes `reporterUserId` back beyond what the caller already knows they are. Self-report (`targetType=profile`, `targetId=caller.id`) is `422 POLICY_REJECTED` (mirrors the DB's own `reports_no_self_report_check`, checked in the service before insert so the error is clean, not a raw constraint violation). A same-reporter duplicate (identical `dedupKey`) on an already-active report is `409 CONFLICT` (existing `ConflictException`, no new code) — **not** silently deduped into 200/201, so the caller learns their earlier report is still pending, per §15 item 4 of the DB design (cross-reporter reports are never merged this way; only literal same-reporter repeats are rejected).

**`GET /me/reports`:** cursor per §11 below; filters: none for MVP (mirrors `GET /users/{userId}/posts`'s "no filters beyond pagination" precedent). Item fields: `id, targetType, targetId, reasonCode, description, status, createdAt, resolvedAt`. Never includes `dedupKey`.

**`GET /reports/{reportId}`:** `404 RESOURCE_NOT_FOUND` for "does not exist" and "exists but caller is neither the reporter nor a moderator" — identical response, no enumeration signal (matches `api.md` §17's existing rule, applied here to reports for the first time).

**`GET /moderation/reports`:** moderator-only. Filters: `status`, `priority`, `targetType`, `reasonCode` (allowlisted query params per §10's existing rule — never arbitrary). Sort: recency only (see §11 cursor note). Includes `reporterUserId` — moderators are the one audience `api.md` §26/§10 of the DB design allows to see it.

**Report status transitions — no direct endpoint.** `status` moves `open → under_review` when the report is linked into a case (§3), and `under_review → closed` when its case closes. **Decided:** derived-only, no direct moderator mutation endpoint — see Decisions recorded, item 1.

## 3. Moderation cases / queue

| Method | Path | Purpose | Auth |
|---|---|---|---|
| `GET` | `/moderation/cases` | Queue/list (cursor, filterable) | Moderator |
| `GET` | `/moderation/cases/{caseId}` | Case detail, including linked reports and actions | Moderator |
| `POST` | `/moderation/cases` | Create a case from one or more existing reports | Moderator |
| `POST` | `/moderation/cases/{caseId}/assign` | Assign to self or another moderator | Moderator |
| `PATCH` | `/moderation/cases/{caseId}` | Update `priority` only (allowlisted) | Moderator |
| `POST` | `/moderation/cases/{caseId}/close` | Close the case | Moderator |

**`GET /moderation/cases`:** filters — `queue` (the `ModerationScope` reused enum), `status`, `priority`, `assignedModeratorId` (including a `assignedModeratorId=me` convenience value). Item fields: `id, queue, status, priority, assignedModeratorId, source, slaDueAt, createdAt, closedAt`, plus `reportCount` (derived, `count(case_reports)`, labeled as such per `api.md` §7's "counts are labeled as derived" rule).

**`POST /moderation/cases` body:** `{ "reportIds": ["01J...", ...], "queue": "content", "priority": "normal"?, "source": "user_report" }`. Every `reportId` must exist, be `status=open`, and not already belong to another case (the `case_reports_report_id_key` unique constraint is the backstop; the service checks first for a clean `409 CONFLICT` rather than a raw constraint error). On success: creates the case, links every report via `case_reports`, transitions each linked report to `under_review`. `priority` defaults to `normal` (DB default); `source` required (no default — every case must declare where it came from, matching the DB design's own "always explicit" choice).

**`POST /moderation/cases/{caseId}/assign` body:** `{ "moderatorId": "01J..." }`, or omitted to self-assign. **Decided (Decisions recorded, item 2):** assigning a moderator automatically sets `status = in_review` — matches the DB's own `cases_in_review_requires_assignee_check` coupling rather than fighting it.

**`PATCH /moderation/cases/{caseId}`:** `{ "priority": "high" }` only — an allowlisted single-field update, matching `api.md` §17's mass-assignment rule. `status`/`assignedModeratorId`/`queue` are never settable through this route; they have their own action endpoints or are set once at creation.

**`POST /moderation/cases/{caseId}/close`:** sets `status=closed`, `closedAt=now()`. Does **not** require every linked report to have a terminal action — a case can close with "no violation found." On close, every linked report still `under_review` transitions to `closed`. Closing an already-closed case is a `200` no-op (idempotent, matching the repeat-action-is-a-no-op convention used throughout Communities/Notifications/Media). **Closing is not a hard lock** — `POST .../actions` on a closed case still succeeds (per the approved DB decision); the response for that case includes no special flag, since nothing in the schema distinguishes it.

## 4. Moderation actions

One endpoint, discriminated by `actionType`, not six separate routes — the six types share one table and one audit trail, and a per-type route would fragment authorization/validation logic that's 90% identical:

| Method | Path | Purpose | Auth |
|---|---|---|---|
| `POST` | `/moderation/cases/{caseId}/actions` | Record an action | Moderator — flat, no tiering (Decisions recorded, item 4) |
| `GET` | `/moderation/actions/{actionId}` | Read one action | Moderator |
| `GET` | `/moderation/actions?targetType=&targetId=` | Target-scoped action history (Decisions recorded, item 7) | Moderator |
| `POST` | `/moderation/actions/{actionId}/reverse` | Record a compensating action | Moderator, and **not** the original action's `actorId` (Decisions recorded, item 5) |

**Request body**, common envelope + a `details` object shaped by `actionType`:

```json
{
  "targetType": "post",
  "targetId": "01J...",
  "actionType": "remove_content",
  "scope": "content",
  "reasonCode": "spam",
  "details": {}
}
```

Per-type `details` and validation:

| `actionType` | `targetType` allowed | `details` shape | Notes |
|---|---|---|---|
| `remove_content` | `post`, `comment`, `share` | `{}` | Calls `ContentService`/`MessagingService` equivalent to set `ContentStatus.removed` |
| `restrict_content` | `post`, `comment`, `share` | `{}` | Sets `ContentStatus.hidden` |
| `warn_user` | `profile` | `{ "message"?: string }` | No target-module call at all — delivered via Notifications only (§9 of the DB design) |
| `suspend_account` | `profile` | `{ "durationSeconds"?: number }` | Omitted `durationSeconds` = indefinite. Produces a `sanctions` row |
| `ban_account` | `profile` | `{}` | Always indefinite — `durationSeconds` rejected with `422` if supplied | 
| `restrict_community_participation` | `profile` (member being restricted, in the context of a given `communityId`) | `{ "communityId": "01J...", "durationSeconds"?: number }` | **Decided (Decisions recorded, item 6):** `communityId` in `details`, resolved server-side against `CommunityMembership` via `(communityId, targetId)`, reusing `CommunityAccessService`'s existing lookup shape; `404`/`422` if no active membership |

**Moderator-removed message UX — decided (Decisions recorded, item 15/Q5):** when `remove_content`/`restrict_content` targets a `message`, the other conversation participant(s) must see a distinct "message removed by moderator" placeholder, not something indistinguishable from an ordinary user deletion. Exact copy/accessibility wording is **not** finalized by this document — tracked as an implementation/design detail for whichever increment builds Messaging's `applyMessageModerationStatus` (§7), the same way Media's M-1 tracks a settled-but-unbuilt parameter.

`scope` is **not** client-free-text — it's derived server-side from `actionType` (`remove_content`/`restrict_content` → `content`; `suspend_account`/`ban_account` → `platform`; `restrict_community_participation` → `community`; `warn_user` → whatever scope the underlying report was, informational only). Accepting a client-supplied `scope` that disagreed with `actionType` would be meaningless (nothing in the DB ties them together beyond both being stored), so the API removes that possibility entirely rather than validating it after the fact.

**Response `201`:** the created action row (`id, caseId, actorId, targetType, targetId, actionType, scope, reasonCode, startsAt, endsAt, createdAt`), plus `sanctionId` when one was produced.

**Audit/history:** `GET /moderation/actions/{actionId}`, the target-scoped history route above, and the case-detail read (§3) are the read surfaces — there is no `PATCH`/`DELETE` on an action, matching the DB's append-only design exactly.

**`POST /moderation/actions/{actionId}/reverse`:** `{ "reasonCode": "...", "notes"? }`. Creates a new action row with `reversalOfActionId` set, targeting the same `targetType`/`targetId`, and — if the original action produced a `sanctions` row — transitions that sanction to `revoked` and calls the target module's lift method (§7). Not restricted to appeal-triggered use; a moderator can self-correct directly. **Decided:** reviewer≠actor applies here too (Decisions recorded, item 5), enforced the same way appeals already enforce it.

## 5. Appeals

| Method | Path | Purpose | Auth |
|---|---|---|---|
| `POST` | `/moderation/actions/{actionId}/appeal` | Submit an appeal | Authenticated, CSRF — must be the affected party (see the table below) |
| `POST` | `/moderation/account-appeals` | Submit an appeal for an account-level sanction (`suspend_account`/`ban_account`) using a one-time identity-only credential instead of a session | **Public route — no `JwtAuthGuard`.** The credential itself is the proof of identity (Decisions recorded, item 14/Q1–Q2). See the dedicated subsection below. |
| `GET` | `/me/appeals` | Caller's own appeals (cursor) | Authenticated, self-scoped |
| `GET` | `/moderation/appeals` | Moderator queue (cursor, filterable by `state`) | Moderator |
| `GET` | `/moderation/appeals/{appealId}` | Detail | Moderator, or the original appellant |
| `POST` | `/moderation/appeals/{appealId}/decide` | Record the review outcome | Moderator, and **not** the original action's `actorId` |

**`POST /moderation/actions/{actionId}/appeal` body:** `{ "statement": "..." }` (required, length-capped). Server sets `actionType` from the referenced action (never client-supplied — this is exactly the field the composite FK pins, so the API must derive it, not trust a client value that could disagree). `422 POLICY_REJECTED` if `actionType='warn_user'` (checked in the service before insert, same clean-error-before-raw-constraint pattern as self-report above). `409 CONFLICT` if an active appeal already exists for this action. `appealDeadline` computed server-side as `now() + 72h` (ADR-001 §2/PRD §28) — never client-supplied.

**Affected-party check** (who may appeal): resolved per `targetType`, per Decision #8 (Decisions recorded):

| `targetType` | Affected party | Status |
|---|---|---|
| `profile` | `targetId` must equal the caller | Resolved — but see the account-appeal subsection below: for `suspend_account`/`ban_account` specifically, the caller usually **cannot** reach this route normally (§9) |
| `post`, `comment` | The content's `authorId` must equal the caller (a call into Content) | Resolved. **Gap, not a decision:** Content needs a privileged, removal-agnostic author lookup — `PostAccessService`'s existing method won't resolve a `removed`/`hidden` post. Content's own future increment. |
| `message` | The message's `senderId` must equal the caller (a call into Messaging) | Resolved. Same removal-agnostic-lookup gap as above, Messaging's own increment. See also the moderator-removal placeholder decision (§4). |
| `share` | The sharer's `userId` must equal the caller | Resolved, mirrors post/comment. |
| `community` | The community's `ownerUserId` must equal the caller — **community staff/moderators do not get appeal standing merely by being staff** | **Decided (Decisions recorded, item 8/Q4).** |
| `conversation` | No single affected party exists structurally | **Still genuinely open** — no existing convention to borrow (Messaging's checks are symmetric per-participant, no "conversation author" concept), and `Conversation` still has no moderation-state field at all (`docs/04-database/moderation.md` §14 item 2, unresolved). Not decided by Q1–Q5. |
| membership (`restrict_community_participation`) | The specific restricted member, via the resolved `CommunityMembership` row | Resolved, no gap. |

**`POST /moderation/appeals/{appealId}/decide` body:** `{ "decision": "upheld" | "overturned", "notes"? }`. **Decided:** no separate claim step — combines "claim as reviewer" and "decide" into one call (Decisions recorded, item 9); a `409` on double-decide is the race-safety mechanism. Enforces `reviewerId ≠ action.actorId` — application-layer, per your approved decision — as a `403 FORBIDDEN` (existing `ForbiddenActionException`, no new code), checked before any write. On `overturned`: creates a reversal action (§4) and transitions any linked sanction to `revoked`, same effect as calling `/reverse` directly. On `upheld`: no side effect beyond recording the decision. Deciding an already-decided appeal is `409 CONFLICT`, not a silent no-op (unlike case-closing) — a moderator overwriting a prior decision is consequential enough that idempotent-retry semantics are wrong here. **How the appellant learns the outcome differs by appeal type — see "Decision-outcome delivery" immediately below.**

### Account-sanction appeal initiation (`suspend_account`/`ban_account` only)

**The problem, resolved as Decision #14 (Decisions recorded):** `JwtAuthGuard` now rejects any non-`active`-status request, and `applyAccountSanction` (§7, §9) is expected to revoke every session for the sanctioned user. A suspended/banned user therefore cannot reach `POST /moderation/actions/{actionId}/appeal` through the normal authenticated path — no live session survives, and `AuthService.login` independently rejects non-`active` accounts. `@SkipAccountStatusCheck()` alone does **not** fix this: it only exempts the account-status half of `JwtAuthGuard`'s checks, never the session-revocation check, which runs first and unconditionally and would already have failed.

**Chosen architecture: Option B — a separate, non-session-based, identity-only appeal credential**, built on the existing `identity.verification_challenges` mechanism (the same table/pattern already backing email/phone verification and password reset) rather than a new one:

- **Issuance:** system-initiated, as a side effect of `applyAccountSanction` — not user-requested (unlike password reset, there is no "request a code for this email" step to expose, so the enumeration concern password-reset's generic response exists for doesn't transfer the same way here). Delivered via the existing `channel`/`destinationHash` credential-resolution path (`requestVerification`'s exact pattern) — **no dependency on the Notifications producer**, which still doesn't exist.
- **Scope, per your explicit security boundary (Decision #14/Q2):**
  - Proves only the identity of the affected user — nothing more.
  - Is **not** a general-purpose login/session credential; consuming it never sets a session cookie or populates `request.user` for any other route.
  - May be used only to initiate an appeal — the `POST /moderation/account-appeals` route is its sole valid destination.
  - The request body must explicitly name the action being appealed (`{ "credential": "...", "actionId": "01J...", "statement": "..." }`) — **the credential itself is not bound to a specific action or sanction** (no new FK field on `VerificationChallenge`, per your explicit instruction not to add one unless later implementation proves it's required).
  - The server independently verifies the named `actionId` is actually appealable (not `warn_user`, not already appealed, within `appealDeadline`) and that it belongs to the credential-verified user, using the exact same affected-party resolution table above — the credential only answers "who," never "which action, is that allowed."
  - Consumed atomically (`consumedAt` set in the same transaction as the `Appeal` row insert), matching `verify()`'s existing consume-and-act pattern exactly.
  - A single credential cannot be reused to gain any broader authenticated access — it has no session-issuing capability at all.
- **Response:** identical shape to the normal appeal-creation response (`201`, the created `Appeal` row) — from the caller's perspective past this one entry point, everything else about appeals (moderator review, `decide`) is unchanged. **How the decision itself reaches the appellant is not the same for every appeal type — see the subsection immediately below.**
- **Ruled out for MVP (Decision #14/Q3):** Option C (preserving a scoped session for appeal-only access) — would require reopening `JwtAuthGuard`/`Session` semantics, which this document does not propose and which was explicitly excluded from this decision round.

### Decision-outcome delivery — account-level appeals need the credential-channel, not in-app Notifications

**The gap:** `.../decide` (above) records the outcome, but *reaching* the appellant with it is not the same problem for every appeal type, and treating them identically would silently break for the one case that matters most.

- **Account-level appeals (`suspend_account`/`ban_account`) — must use the same credential-channel (email/SMS) the original appeal-initiation link used, never in-app Notifications.** The appellant is, by construction, still non-`active` at decision time unless and until the decision is `overturned` — meaning `JwtAuthGuard` still rejects them, so `GET /notifications` (once that producer exists) is exactly as unreachable to them as `GET /me/appeals` already is (§5 above). An in-app notification they structurally cannot read is not a delivery mechanism. `applyAccountSanction`'s side-effect credential issuance (above) already resolves the user's `channel`/`destinationHash`; `.../decide` reuses that same resolution to send the outcome directly, with **no dependency on the Notifications producer**.
- **Every other appeal type (`post`, `comment`, `share`, `message`, `community`, membership) does not have this problem.** None of these actions touch `identity.users.status` — the appellant's own account remains `active` throughout, `JwtAuthGuard` never rejects them, and `GET /me/appeals`/`GET /notifications` (once built) work normally. These stay on the ordinary in-app Notifications path once that producer exists — no credential-channel fallback needed or proposed for them.

This distinction is why `POST /moderation/actions/{actionId}/appeal` (the normal, session-based route, §5) and `POST /moderation/account-appeals` (the credential-based route) lead to the *same* `Appeal` row and the *same* `.../decide` endpoint, but only the latter's outcome needs the credential-channel escape hatch — the fork is in how the *decision* is delivered, not in how the appeal itself is processed or stored.

## 6. Sanctions

| Method | Path | Purpose | Auth |
|---|---|---|---|
| `GET` | `/me/sanctions` | Caller's own sanctions, current + historical | Authenticated, self-scoped |
| `GET` | `/moderation/sanctions` | Moderator view (cursor, filterable by `subjectType`/`subjectId`/`scope`/`state`) | Moderator |

**No `POST /sanctions` — deliberately.** Every sanction is `sourceActionId`-required (`NOT NULL` in the schema), so it can only ever be created as a side effect of `POST .../actions` (§4). Adding a direct creation route would contradict the approved schema.

**`GET /me/sanctions`:** lets a suspended/banned user see *why* — item fields: `sanctionType, scope, reasonCode, startsAt, endsAt, state, createdAt`. Deliberately excludes `sourceActionId` (would let the subject navigate to the moderator's internal action/case record) and `subjectId` (redundant — it's always the caller).

**Expiry handling — decided (Decisions recorded, item 10):** no automatic expiry job for MVP — `state` only transitions to `expired` when something actually runs that (not designed here). `isCurrentlySanctioned` (§7) lazily checks `endsAt < now()` at call time, matching Media's already-shipped lazy-expiry pattern, so a stale `active`-but-past-`endsAt` row is still correctly unenforced regardless of whether a sweep has run.

## 7. Cross-module integration

Implements the contract `moderation.md` §7 proposed, with concrete call directions:

| Direction | Caller → Callee | Purpose |
|---|---|---|
| Moderation → Identity | `applyAccountSanction(userId, status, sanctionId)` / `liftAccountSanction(userId)` | `suspend_account`/`ban_account` execution and reversal |
| Moderation → Identity | issue a `verification_challenges` row with a new `purpose` (e.g. `account_appeal`), delivered via the existing email/phone channel | Account-sanction appeal credential (§5, Decision #14/Option B) — a side effect of `applyAccountSanction`, not a separate call site |
| Moderation → Identity | validate/consume the same credential | Backing `POST /moderation/account-appeals` (§5) |
| Moderation → Identity | resolve the appellant's `channel`/`destinationHash` again, send the decision outcome directly | Account-level appeal `.../decide` only (§5, "Decision-outcome delivery") — every other appeal type uses in-app Notifications instead, once that producer exists |
| Moderation → Content | `applyContentModerationStatus(targetType, targetId, status)` | `remove_content`/`restrict_content` on posts/comments |
| Moderation → Content | resolve a post/comment/share's `authorId`/`userId` | Appeal affected-party check (§5) |
| Moderation → Messaging | `applyMessageModerationStatus(messageId, state)` | `remove_content`/`restrict_content` on messages |
| Moderation → Messaging | resolve a message's `senderId` | Appeal affected-party check |
| Moderation → Media | `applyAssetModerationStatus(assetId, state)` — **decided (Decisions recorded, item 11): media is approved as a directly reportable target** (`media_asset` to be added to `ReportTargetType`), but that enum change has not yet been applied to `database/schema.prisma` — tracked as a known gap between this decision and the current schema | Not wired by this design until the schema change lands, its own separately-reviewed increment |
| Moderation → Communities | `applyMembershipSanction(membershipId, status)` / `liftMembershipSanction(membershipId)` | `restrict_community_participation` |
| Identity/Content/Messaging/Communities → Moderation | `ModerationAccessService.isCurrentlySanctioned(subjectType, subjectId, scope)` | Every other module's own authorization checks (post creation, messaging, community actions) need to ask Moderation this, not query `moderation.sanctions` directly |

**This design does not implement any of the callee-side methods** — each is that target module's own future increment, exactly as `moderation.md` §7 already stated. What's new here is nailing down which direction Moderation is a *caller* (executing sanctions) versus a *callee* (other modules checking `isCurrentlySanctioned`) — both directions exist, and neither should be built by guessing the other module's internals; each needs its own reviewed increment when touched.

## 8. Authorization model

**Full design owner-approved and recorded separately: `docs/05-api/platform-role-authorization.md`** (2026-09-24). Summary, settled, not proposed:

- A caller is "a moderator" if they hold an active (`revoked_at IS NULL`, not expired) `identity.user_roles` row whose `identity.roles.key = 'moderator'` — **exactly one platform role for MVP**, no `admin`/`senior_moderator`/`security_administrator` (`architecture.md` §11's full matrix remains a deferred, separate future decision, not pre-empted here). Reuses the existing, currently-empty RBAC tables unchanged — no schema change.
- Enforced by a new, shared `PlatformRoleGuard` + `@RequireRole('moderator')`, composed *after* `JwtAuthGuard` (authentication + account/session enforcement) and *before* `ModerationAccessService` (resource-level checks) — a fixed four-layer sequence, no layer merged into another. No JWT role claim; a fresh database lookup on every role-gated request, so revocation takes effect on the very next request.
- Role assignment: operator-only for MVP, no in-app grant/revoke API at all (not just for the first grant) — the role's *existence* is seeded (`database/seeds/roles.seed.ts`), but every actual *grant* is a trusted operator's direct database action, per `platform-role-authorization.md` §5.

**None of this is implementable today** — the guard, decorator, and seed script don't exist yet. This is the single largest blocker to actual Moderation API implementation — see Implementation Dependencies §15.

## 9. Account sanctions — session/request-time behavior

### Done (commit `a267312`, CI green — no longer a Moderation dependency)

**Request-time status check.** `JwtAuthGuard`/`OptionalJwtAuthGuard` now re-check `identity.users.status` on every request (one indexed round trip, `Session` PK joined to `User` PK), not just at login. A `suspend_account`/`ban_account` action takes effect immediately once `User.status` is actually changed — `JwtAuthGuard` rejects with `403 ACCOUNT_RESTRICTED`, `OptionalJwtAuthGuard` falls back to anonymous. **Session-tied invalidation is also done**: a revoked session's token is rejected (`401 TOKEN_INVALID`) regardless of the JWT's own remaining lifetime. Both shipped test-first, mutation-tested, `EXPLAIN`-verified (sub-millisecond, indexed). This closes the "just-banned user keeps acting for up to 15 minutes" gap this section originally flagged.

### Still required (unchanged — not implemented by the guard fix, still Moderation's dependency)

**`applyAccountSanction(userId, status, sanctionId)` / `liftAccountSanction(userId)` do not exist yet.** The guard now *enforces* `User.status` and session revocation correctly — but nothing outside Auth can *set* `User.status` or *trigger* `AuthService.logoutAll(userId)` (which exists, unchanged, and is directly reusable). This is still Identity/Auth's own future increment, not Moderation's, and not resolved by the guard commit.

### Account-sanction appeal reachability — resolved (Decision #14, Decisions recorded)

The guard fix, once combined with the still-unbuilt `applyAccountSanction`'s session revocation, would leave a suspended/banned user with **no way to reach the normal appeal route** — see the dedicated subsection in §5 for the full architecture (Option B: a separate, identity-only, non-session-based appeal credential, built on the existing `verification_challenges` mechanism). Option C (preserving a scoped session) is ruled out for MVP — it would require reopening `JwtAuthGuard`/`Session` semantics, which neither this document nor the guard-fix commit proposes.

## 10. Privacy / security

- **Reporter privacy:** `reporterUserId` never appears in any response the reported party (or the general public) can read — only `GET /moderation/reports` (moderator-only) and `GET /me/reports` (the reporter's own view of their own report) include it.
- **Target privacy:** the reported/actioned party is never told a report exists against them, who reported it, or how many reports exist — they learn only that an *action* was taken against them (via existing Notifications, once that producer exists) and, if eligible, may appeal it.
- **Moderator-only information:** case notes, `assignedModeratorId`, `slaDueAt`, and cross-report linkage are visible only through the `/moderation/*` routes, never through `/me/*` or public routes.
- **Enumeration prevention:** every id-based lookup (`GET /reports/{id}`, `/moderation/cases/{id}`, `/moderation/actions/{id}`, `/moderation/appeals/{id}`) returns `404 RESOURCE_NOT_FOUND` uniformly for "does not exist" and "exists but unauthorized," matching the existing Notifications/Communities precedent exactly.
- **Idempotency:** `POST /reports` takes `Idempotency-Key` (matches follow/friend-request precedent — a retry-prone create). `POST .../decide`, `.../close`, `.../assign` are naturally idempotent or intentionally non-idempotent as specified per-endpoint above (§3/§5) rather than needing the key mechanism.
- **Rate limiting: contract only, not enforced**, matching `api.md` §11's current, honest state for every module except the six auth routes. Proposed contract values (illustrative, not binding): `POST /reports` — 10/hour/account (reports are the one Moderation surface an ordinary, non-moderator user can call, and it's the one most exposed to abuse — mass-reporting as harassment); `POST .../appeal` — 5/day/account. Moderator-facing routes are not rate-limited by account (a moderator's own throughput is a staffing question, not an abuse vector) but should inherit whatever general authenticated-route protection exists platform-wide (none does yet, per §11's own admission).
- **Abuse prevention beyond rate limiting:** mass/false reporting is a real, named risk. **Decided (Decisions recorded, item 12):** rate limiting + same-reporter dedup only for MVP; revisit only if real abuse patterns emerge in practice. `dedupKey` stops one reporter repeating themselves; cross-reporter consolidation (`docs/04-database/moderation.md` §5) is a *triage* tool, not an abuse *deterrent* — no additional mechanism proposed now.

## 11. Pagination / filtering

Every list endpoint reuses the **exact existing** `common/pagination/cursor.ts` utility unchanged — `(createdAt, id)` cursor, opaque base64url, default 20/max 50, **server clamps an out-of-range `limit`, never rejects it** (deliberately correct from the start, given the existing T-2 tracked bug in `api.md` §18 where five other endpoints get this wrong).

| Endpoint | Cursor sort | Filters (allowlisted) |
|---|---|---|
| `GET /me/reports` | `(createdAt, id)` desc | none |
| `GET /moderation/reports` | `(createdAt, id)` desc | `status`, `priority`, `targetType`, `reasonCode` |
| `GET /moderation/cases` | `(createdAt, id)` desc | `queue`, `status`, `priority`, `assignedModeratorId` |
| `GET /me/appeals` | `(createdAt, id)` desc | none |
| `GET /moderation/appeals` | `(createdAt, id)` desc | `state` |
| `GET /me/sanctions` | `(createdAt, id)` desc | none |
| `GET /moderation/sanctions` | `(createdAt, id)` desc | `subjectType`, `subjectId`, `scope`, `state` |

**Not priority-ordered — decided (Decisions recorded, item 13): recency-sort for MVP, defer priority-sort.** `cases_status_priority_created_at_id_idx` and the `CasePriority` enum exist for a future increment, but the existing cursor utility only supports a `(timestamp, id)` tuple, and no other endpoint in this codebase has ever needed a third sort key — a priority-first queue would need a new, three-key cursor shape with no precedent elsewhere in the API. Not built now.

## 12. Error contract

**No new error codes are needed.** Every Moderation condition maps onto the existing 10-code taxonomy (`api.md` §6):

| Condition | Code |
|---|---|
| Self-report | `422 POLICY_REJECTED` |
| Same-reporter duplicate report | `409 CONFLICT` |
| Report/case/action/appeal not found or not visible | `404 RESOURCE_NOT_FOUND` |
| Not a moderator | `403 FORBIDDEN` |
| Reviewer is the original actor | `403 FORBIDDEN` |
| Appeal on `warn_user` action | `422 POLICY_REJECTED` |
| Duplicate active appeal | `409 CONFLICT` |
| Appeal after deadline | `422 POLICY_REJECTED` |
| Re-deciding a decided appeal | `409 CONFLICT` |
| Malformed body field | `422 VALIDATION_FAILED` |
| Malformed path UUID | `422 VALIDATION_FAILED` (`ParseUuidPipe`, mandatory — see Test Plan) |
| Malformed cursor | `400 INVALID_CURSOR` |
| Caller's own account currently sanctioned, blocking an unrelated write elsewhere | `403 ACCOUNT_RESTRICTED` (already exists; a Moderation *consumer*, not something Moderation's own routes return about themselves) |
| Invalid/expired/already-consumed account-appeal credential | `401 TOKEN_INVALID` (reused — matches how an invalid/expired verification code already responds today) |
| Account-appeal credential valid, but the named `actionId` isn't appealable or doesn't belong to that user | `404 RESOURCE_NOT_FOUND` (same enumeration-safe treatment as every other cross-ownership case) |

## 13. OpenAPI

Generated the same way as every other module — `buildOpenApiDocument()` picks up `@ApiTags('Moderation')`-decorated controllers automatically at boot (`main.ts`/`generate-openapi.ts`), no separate authoring. Example shapes to include once implemented:

```json
// POST /reports response
{ "data": { "id": "01J...", "targetType": "post", "targetId": "01J...", "reasonCode": "spam", "status": "open", "createdAt": "2026-09-24T00:00:00Z" } }

// GET /moderation/cases/{id} response
{ "data": { "id": "01J...", "queue": "content", "status": "in_review", "priority": "high",
  "assignedModeratorId": "01J...", "reportCount": 3, "reports": [...], "actions": [...] } }
```

## 14. API versioning

`/api/v1/...` throughout, per the already-decided, unchanged convention (`api.md` §3) — no versioning decision needed here.

## 15. Implementation dependencies

In dependency order — nothing below can be skipped by implementing Moderation "around" it:

1. **Platform role mechanism** (§8, full design `docs/05-api/platform-role-authorization.md`) — the `moderator` `Role` seed and `PlatformRoleGuard`/`@RequireRole()` are both **done and shipped** (commits `6292334`, `af359b2`). **Still blocking:** no user holds the `moderator` role yet — role assignment is operator-only for MVP (no in-app grant/revoke API, per `platform-role-authorization.md` §5), so this requires a trusted operator's direct database action, not more application code.
2. ~~`JwtAuthGuard` request-time status re-check~~ — **done** (commit `a267312`). No longer a blocker.
3. **`applyAccountSanction`/`liftAccountSanction`** (§9) — the guard now enforces status/session correctly, but nothing sets `User.status` or triggers `logoutAll` from outside Auth yet.
4. **The account-appeal credential mechanism** (§5, Decision #14/Option B) — a new `verification_challenges` `purpose` + a small issue/consume service + `POST /moderation/account-appeals`. Blocks `suspend_account`/`ban_account` from being *appealable*, even once item 3 makes them *enforceable*.
5. **Content/Messaging/Communities callee-side methods** (§7) — each action type is only as real as its target module's willingness to apply it; `remove_content` etc. cannot execute against nothing. Messaging's method additionally needs the moderator-removal placeholder (§4, Decision #15/Q5).
6. **Notifications producer** — currently nothing creates notifications at all (`api.md` §15: "Nothing creates notifications yet"); `warn_user` and appeal-decision communication depend on this existing. **Not** a dependency of the account-appeal credential itself (§5 reuses the existing email/phone channel directly).

None of these are Moderation-module work — each is a small, separate, reviewed increment in its owning module, matching exactly how `docs/04-database/moderation.md` §17 already treated `Share.status`/`Conversation.moderationState` as separate requests.

## 16. Test plan

Required before implementation is considered complete, mirroring the rigor already applied to Communities/Media (tests-first, mutation-tested, `ParseUuidPipe`-covered):

- **Authorization:** every `/moderation/*` route rejects a non-moderator with `403`; every `/me/*` route rejects an unauthenticated caller with `401`; reviewer≠actor enforced and tested with a real "same person" attempt.
- **Ownership/privacy:** a report/appeal/sanction is invisible (`404`) to a third party who is neither its owner nor a moderator; `reporterUserId` never appears in a non-moderator response; a suspended user's `/me/sanctions` never leaks `sourceActionId`.
- **Validation:** every enum field rejects an out-of-set value with `422`; `details` shape enforced per `actionType`; self-report rejected.
- **State transitions:** report `open→under_review→closed` only via case linkage/closure, never directly; case `open→in_review→closed`, closing a closed case is a no-op; appeal `submitted→{upheld|overturned}`, re-deciding is `409`; sanction `active→revoked` on overturn.
- **Duplicate protection:** same-reporter duplicate report is `409`; duplicate active appeal on one action is `409`; the DB's partial-unique constraints are the backstop — write a test that bypasses the service's own pre-check (direct repository call) to prove the constraint itself still holds, the same "does the DB actually enforce this, not just the service" rigor Media's mutation testing used.
- **Sanctions:** action→sanction mapping produces exactly the approved `sanctionType` per `actionType`; `warn_user`/`remove_content`/`restrict_content` never produce a sanction row.
- **Appeals:** `warn_user` appeal rejected with `422`; appeal past `appealDeadline` rejected; affected-party resolution correct for each `targetType` (profile/post/comment/message), including the cross-module call.
- **Cross-module access:** `ModerationAccessService.isCurrentlySanctioned` returns correct results for `active`/`expired`/`revoked`/`superseded` states — a stub/mock target-module test, since the actual callee methods aren't built yet.
- **Pagination/filtering:** every list endpoint's `limit` is clamped, never rejected (explicitly guards against repeating T-2); malformed cursor is `400`; every filter is allowlist-validated, an unknown filter key is ignored or rejected consistently (decide which — flagged nowhere yet, minor, worth a one-line decision at implementation time).
- **Security cases:** IDOR attempts on every id-based route; mass-assignment attempt on `PATCH /moderation/cases/{id}` (extra fields ignored, not silently accepted); malformed path UUIDs added to `test/path-params.e2e-spec.ts`'s route table (mandatory per the existing "fails if a route with a path parameter is added without being covered" completeness test).
- **Database constraint interaction:** at least one mutation test per hand-added CHECK/partial-unique constraint (14 total, per the migration), proving the service's pre-check AND the raw constraint both independently reject the same bad input — matching the rigor already applied when the schema itself was verified.
- **Account-appeal credential (§5):** a valid, unconsumed, unexpired credential succeeds exactly once; reuse after consumption is `401`; expiry is enforced; a credential for one user cannot appeal another user's action; the credential never sets `request.user` or grants access to any other route (proving the "not a general-purpose login credential" boundary holds); a named `actionId` that isn't appealable (`warn_user`, already-appealed, past deadline, or belonging to a different user) is rejected with the same checks the normal appeal route uses.

## 17. Documentation

Proposed updates, **not made by this document**:

1. **`docs/05-api/api.md` §15** — the Moderation row's "does not exist" DB-dependency note is now stale (schema is committed and migrated); update to "schema implemented (commit `42fe6dd6`); no API yet" and add a "Detailed design: `docs/05-api/moderation.md`" pointer, matching Media's row exactly.
2. **`docs/05-api/api.md` §18** — the "Feed/Media/Moderation/Admin/Search implementation" open-decision row should split Moderation out once this design is approved, noting its specific blocker (§15 above: platform-role mechanism) rather than the generic "blocked on Database Phase 2" reason, which no longer applies to Moderation.
3. **`docs/05-api/api.md` §5 Authorization** — item (5) "moderation sanctions — not yet enforceable in Phase 1, since moderation schema doesn't exist" is now doubly stale: the schema exists, **and** the guard-level enforcement mechanism (`JwtAuthGuard`'s status check) now exists too. What's still accurate: nothing can actually *set* a sanction yet (`applyAccountSanction` doesn't exist, §9) — the wording should reflect "enforcement mechanism exists; nothing produces a sanction yet," not "not yet enforceable."
4. **`docs/03-architecture/architecture.md` §20** — could note that a concrete API design now exists, mirroring how it already references `media.md`.

## Decisions recorded

Replaces the original "Open questions" section — every item below was a genuine fork when first raised; each now has an owner decision or is resolved by existing-convention evidence, as marked. Two items remain genuinely open (15 and 16) and are not silently closed.

**1. Report status — derived-only, no direct moderator mutation.** Resolved by existing-convention evidence (report status has no independent enforcement meaning; a "dismiss individually" need is served by a one-report case closed immediately).

**2. Case `in_review` — set automatically by assignment, no separate transition endpoint.** Resolved by existing-convention evidence (the DB's own `cases_in_review_requires_assignee_check` already couples the two facts).

**3. Case creation model — hybrid.** **Owner decision.** Auto-create by default; moderators can merge/split afterward. (Supersedes the original manual-only draft in §3 — the exact merge/split endpoint shapes are an implementation detail for whoever builds this, not specified further here.)

**4. Moderator tiering — flat, no tiers, for MVP.** **Owner decision.** Revisit only once `architecture.md` §11's role matrix itself is approved.

**5. `POST .../reverse` authorization — reviewer≠actor applies, same as appeals.** Resolved by existing-convention evidence (consistent with the appeal-review rule already approved).

**6. `restrict_community_participation` → `communityId` supply.** Resolved by existing-convention evidence — `communityId` in `details`, resolved server-side via `CommunityAccessService`'s existing `(userId, communityId)` lookup shape.

**7. Target-scoped action history route — added.** Resolved by existing-convention evidence (the supporting index already existed; the route was simply missing).

**8. Conversation/community-level appeals — split into two, one resolved, one still open:**
  - **Community: owner-only appeal standing.** **Owner decision (Q4).** Community staff/moderators do not receive appeal standing merely by being staff.
  - **Conversation: still genuinely open** (item 16 below) — no existing convention to borrow, and the underlying schema gap (`Conversation` has no moderation-state field) is unresolved at the database level.

**9. Appeal decide — no separate claim step.** **Owner-endorsed** (carried through unchanged from the original recommendation) — a `409` on double-decide is the race-safety mechanism.

**10. Sanction expiry — lazy check at read time, no sweep job for MVP.** Resolved by existing-convention evidence (matches Media's already-shipped lazy-expiry pattern).

**11. Media as a reportable target — approved.** **Owner decision.** Add `media_asset` to `ReportTargetType` — low priority, small addition. **Not yet applied to `database/schema.prisma`** (would require its own schema-change review, out of scope for this documentation step) or reflected in `docs/04-database/moderation.md`'s enum table — tracked here as a known gap between this decision and the current schema, to close in a future, separately-reviewed increment.

**12. Mass/false-reporting abuse prevention — rate limiting + same-reporter dedup only for MVP.** **Owner decision.** Revisit only if real abuse patterns emerge in practice; no additional mechanism designed now.

**13. Moderator queue sort order — recency only for MVP, priority-sort deferred.** **Owner decision.** Would need a new, three-key cursor shape with no precedent elsewhere in the API; not built now.

**14. Account-sanction appeal reachability — Option B (separate, identity-only appeal credential).** **Owner decision.** Full architecture in §5/§9 above. Sub-decisions:
  - **Q2 — credential is identity-only, not action-bound.** No FK field added to `VerificationChallenge` unless a later implementation proves it's actually required.
  - **Q3 — Option C (scoped session preservation) ruled out for MVP.** `JwtAuthGuard`/`Session` semantics are not reopened by this decision.

**15. Moderator-removed message UX — a distinct placeholder, not indistinguishable from ordinary deletion.** **Owner decision (Q5).** Exact copy/accessibility wording **not finalized** — tracked as an implementation/design detail for Messaging's `applyMessageModerationStatus` increment, the same way Media's M-1 tracks a settled-but-unbuilt parameter.

### Still genuinely open

**16. Conversation-level appeal affected party.** No existing convention to borrow from (Messaging's access checks are symmetric per-participant, no "conversation author" concept), and the underlying gap — `Conversation` has no moderation-state field at all — is unresolved at the database level (`docs/04-database/moderation.md` §14 item 2). Not addressed by Q1–Q5. Resolution depends on how that database-level gap is eventually closed, which is Messaging's own future decision, not Moderation's.
