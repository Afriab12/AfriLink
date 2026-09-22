# AfriLink Media Database Design

**Status:** DESIGN ONLY — proposed for owner review. No `media` schema, migration, or dependency has been created. `schema.prisma` and `database/migrations/` are unmodified by this document.
**Date:** 2026-09-22
**Scope:** Concrete database design for `media.assets`, `media.variants`, `media.uploads`, the content/message attachment relationships, and the `social.profiles`/`community.communities` avatar/cover foreign keys — at the same level of detail `database.md` §8 (Communities) had before that schema was implemented.
**Not in scope:** any implementation (Prisma models, migration SQL, dependencies, API, storage integration, workers), moderation, audit, feed, search, payments, advanced video processing, video editing, or CDN optimization beyond `architecture.md` §16's already-approved pipeline shape.

Source documents read for this design: `CLAUDE.md`; `docs/01-product/PRD.md` §15, §17, §19, §31; `docs/03-architecture/architecture.md` §16; `docs/03-architecture/approval-gate.md` §7; `docs/04-database/database.md` §2, §3, §6, §9, §11, §12; `docs/05-api/api.md` §15–17; `docs/10-decisions/decisions.md` (ADR-001, ADR-003); the current `database/schema.prisma`; and the four applied migrations under `database/migrations/`.

---

## 1. Media database overview

Media is a new PostgreSQL schema, `media`, owned exclusively by the Media module (`architecture.md` principle: each module owns its persistence boundary). It holds **metadata and references only** — binary bytes live in S3-compatible object storage, never in PostgreSQL (`database.md` §3: "Do not store media bytes ... in the database").

Three tables carry the design `database.md` §11 already named in prose (`media.assets`, `media.variants`, `media.uploads`); this document makes their fields, types, states, and constraints concrete. Two new join tables (`content.post_media`, `messaging.message_attachments`) connect approved media assets to content and messages, per the "design intent" `database.md` §6 already recorded. Two existing placeholder columns (`social.profiles.avatar_media_id`, `community.communities.avatar_media_id`/`cover_media_id`) gain real foreign keys.

This design follows the upload pipeline already approved in `architecture.md` §16 (authorize → reserve → direct-to-storage upload → validate/process → variant creation → referenceable) without changing its shape, and the MVP scope already approved in ADR-002 §7 (profile images, post images, limited video uploads, image-only message attachments) without expanding it.

## 2. Entity model

```
identity.users
      │ ownerUserId (Cascade)
      ▼
 media.assets ──┬── media.variants  (assetId, Cascade)
      │         └── media.uploads   (assetId, Cascade, 1:1)
      │
      │ assetId (Restrict — see §4/§8)
      ├── content.post_media ───── content.posts     (postId, Cascade)
      └── messaging.message_attachments ── messaging.messages (messageId, Cascade)

social.profiles.avatarMediaId ────────► media.assets   (SetNull)
community.communities.avatarMediaId ──► media.assets   (SetNull)
community.communities.coverMediaId ───► media.assets   (SetNull)
```

`content.comment_media` is **not** part of this design — see §4.

## 3. Asset taxonomy

Three separate concepts were conflated in the prose design (`architecture.md` §16 step 1: "authorizes owner, purpose, type, size, and quota"). This design keeps them as three distinct fields rather than collapsing any of them, for a documented reason each:

| Field | Values | Enum or text? | Why |
|---|---|---|---|
| `kind` | `image`, `video` | **Enum** | A closed, stable, product-approved 2-value set (ADR-002 §7 / PRD §31 name exactly these two media technologies for MVP; nothing else is approved). It determines the *processing pipeline* (image transform vs. video transcode), not where the asset is used. Same reasoning already applied to `CommunityVisibility`'s closed 2-value set. |
| `purpose` | `avatar`, `cover`, `post`, `message_attachment` (starter list; see below) | **Validated text** | `architecture.md` §16 says explicitly: *"the pipeline below is intentionally generic so those formats can be added later as new asset purposes/variants rather than a new pipeline."* That is direct, documented evidence `purpose` is expected to grow (community banners, business logos, etc. are all plausible future purposes) — the opposite of a closed set. Matches the treatment already given to `Post.visibility` and `CommunityMembership.role` for the same reason: named but not exhaustively enumerated. |
| `declaredMimeType` / `verifiedMimeType` | any valid MIME string | **Text, always** | MIME types are an open, IANA-scale namespace — never a candidate for a Postgres enum. Two separate columns exist because `architecture.md` §16 and PRD §31 both say **"never trust filenames or client MIME declarations"** — the client's claim at reservation time and the worker's verified result after inspection must be distinguishable. `verifiedMimeType` is nullable until a worker checks it; only `verifiedMimeType` is authoritative for anything security- or processing-relevant. |

**Why `kind` and `purpose` stay separate fields (not collapsed into one), per the task's explicit instruction to justify this:** a `post` can be either `kind` (image or video); `avatar`, `cover`, and `message_attachment` are image-only *by product rule*, not by any structural constraint that would need a different `kind` value per purpose. Collapsing them into one field (e.g. `avatar_image`, `post_video`) would (a) duplicate every `kind` value once per purpose, (b) make "avatar/cover/message_attachment must be image" impossible to express as a simple per-purpose rule (it would instead require excluding specific compound values), and (c) prevent adding a new `kind` later (e.g. a future audio format, explicitly out of MVP scope but the docs anticipate this kind of growth) without touching every existing purpose value. The two-field, purpose-vs-kind authorization matrix is enforced at the application layer (which purposes accept which kinds is not itself a database constraint — see §11).

Starter `purpose` vocabulary (documented convention, not a blocking decision — `architecture.md` §16 explicitly frames exact parameters like this as implementation detail that "do not change this pipeline's shape"):

| Purpose | Allowed `kind` | Attaches to |
|---|---|---|
| `avatar` | image | `social.profiles.avatarMediaId` |
| `cover` | image | `community.communities.coverMediaId` |
| `post` | image or video | `content.post_media` |
| `message_attachment` | image only | `messaging.message_attachments` (PRD §19 / `architecture.md` §14: "image attachments only for MVP") |

## 4. Attachment model

**Question:** one shared polymorphic `media.attachments` table (target_type/target_id) vs. separate per-content-type join tables?

| Criterion | A. Polymorphic table | B. Separate join tables |
|---|---|---|
| Referential integrity | No real FK possible — `database.md` §12 says this outright for an identical problem (`moderation.reports`): *"Because PostgreSQL cannot enforce a foreign key to multiple target tables, target references require an application-level target resolver... If strict referential integrity is required, use separate report tables per target type."* | Real FK to `content.posts` / `messaging.messages`. |
| DB constraints | Type-specific columns (ordering, alt text) become nullable "column soup" or JSON. | Ordering/alt-text/display columns are scoped and `NOT NULL` where appropriate. |
| Prisma support | No native polymorphic relation; still needs a bare `target_id` the way `notification.notifications` already does, with no type safety. | Full typed Prisma relations, matching every other join table in this schema (`CommunityMembership`, `Participant`). |
| Query performance | `WHERE target_type = 'post' AND target_id = ...` — fine at MVP scale, not a real differentiator. | Same, scoped to one small table per content type. |
| Ownership/security | Media would need to branch on target type to know how to authorize — violates "each module owns its business rules" (the same principle that already justified `messaging.messages` having its own `moderation_state` instead of reusing `content.ContentStatus`). | Authorization for "can I attach to this post/message" stays entirely inside Content/Messaging's existing ownership checks. |
| Deletion behavior | One FK-less column can't express different `ON DELETE` behavior per logical target — cleanup becomes application-job-only, no DB guarantee. | Each join table picks the `ON DELETE` behavior appropriate to its own parent (see below). |
| Future extensibility | Adding a new target type needs no migration. | Adding a new target type needs one small new table. |

**Recommendation: B, separate join tables.** This codebase already rejects the polymorphic approach for a structurally identical case: `PostReaction` and `CommentReaction` are two separate tables, not one shared `reactions` table, despite being nearly identical in shape. `database.md` §6's own design intent for this exact feature already says "join approved media assets to content with an explicit ordering, alt text, and display metadata" — singular, content-type-scoped tables, matching what's proposed here.

### `content.post_media`

| Field | Type | Notes |
|---|---|---|
| `postId` | uuid, FK → `content.posts.id` | `ON DELETE CASCADE` — an attachment row is meaningless once its post is gone (mirrors every other post-owned child table: comments, reactions, shares). |
| `assetId` | uuid, FK → `media.assets.id` | `ON DELETE RESTRICT` — see §8 for why: the asset's own retention job, not an unrelated post-delete cascade, governs when it is actually purged. |
| `displayOrder` | int, default 0 | "Explicit ordering" per `database.md` §6. |
| `altText` | text, nullable | PRD §31: "Preserve appropriate attribution and accessibility information such as alternative text where supported." |
| `createdAt` | timestamptz | |

`@@unique(postId, assetId)`; `@@index(postId, displayOrder)` for ordered reads; `@@index(assetId)` for the orphan-cleanup lookup in §8.

### `messaging.message_attachments`

Same shape, `messageId` instead of `postId`, same `ON DELETE CASCADE` on the message side (mirrors `messaging.messages`' existing child-table pattern) and `ON DELETE RESTRICT` on `assetId`. **Image only** (PRD §19, `architecture.md` §14) — enforced at the application write path, not a DB `CHECK`, because a `CHECK` cannot read another table's column without a trigger, and no trigger is used elsewhere in this schema for a cross-table invariant (the same reasoning `database.md` §12 already gives for polymorphic targets applies here: application-level resolvers, not triggers). No `altText` column — PRD does not describe alt text for message images.

### `content.comment_media` — **not designed, OPEN DECISION**

PRD §17 (Comments) lists what users may do with comments and does not include attaching media. PRD §31's approved MVP media scope is "profile images, post images, and limited video uploads" — comments are not named. `database.md` §6 and `schema.prisma`'s own header comment mention `content.comment_media` only as a *deferred placeholder name*, alongside `post_media`, not as approved product scope. **This is not the same as approval.** No table is proposed here. If comment media is approved later, it would mirror `content.post_media` exactly (same columns, `commentId` instead of `postId`, `ON DELETE CASCADE` from `content.comments`).

## 5. Quota model

`architecture.md` §16 step 1 and PRD §31 both require quota checking but give no numbers, and the task explicitly forbids inventing them. What *can* be resolved from the docs:

- **DB vs. application responsibility:** application. `architecture.md` step 1's own wording — "the API authorizes owner, purpose, type, size, and quota" — places this at the API layer. The database's job is to hold the queryable facts (owner, state, byte size, kind) a quota check reads; a Postgres `CHECK` cannot express "no more than N active assets for this owner" without a trigger, which nothing else in this schema uses for a business rule.
- **Persistent counter vs. calculated:** **calculated**, by default. This mirrors the same choice already made for `memberCount` in Communities (`COUNT` over `community.memberships` rather than a maintained counter column), and that decision's own follow-up note from this session: a counter is an opt-in optimization once a real number and measured cost justify it, not a default. A maintained counter table is not proposed now.
- **One avatar / one cover is not a quota mechanism.** It falls out of the column shape itself — `social.profiles.avatarMediaId` and `community.communities.avatarMediaId`/`coverMediaId` are single nullable columns, so "current avatar" is inherently capped at one without any counting logic.
- **How deleted/rejected media affects quota:** recommend excluding `deletedAt IS NOT NULL` and `state = 'rejected'` assets from any future count, consistent with the "only count what's actually active" pattern used throughout this codebase (active memberships, active follows, active blocks).

**OPEN DECISION** (product numbers/scope, not resolvable from any approved document):
- What is actually counted (asset count? total bytes? both?) and at what scope (per user? per post? per time window, i.e. rate-limit-like?).
- Whether an in-flight reservation (`media.uploads.status = 'reserved'`, not yet completed) should count against quota to prevent a reservation-flooding abuse pattern, or only completed/ready assets count.

## 6. Variant model

| Field | Type | Notes |
|---|---|---|
| `id` | uuid7, PK | |
| `assetId` | uuid, FK → `media.assets.id`, `ON DELETE CASCADE` | A variant cannot outlive its source asset. |
| `variantName` | text, app-validated | See vocabulary below. Not an enum — `architecture.md` §16 explicitly anticipates new "variants" being added later without a new pipeline, the same expansion reasoning as `purpose`. |
| `storageKey` | text | Private object key. |
| `mimeType` | text | |
| `widthPx` / `heightPx` | int, nullable | Set for image variants and video poster-frame thumbnails. |
| `durationSeconds` | numeric, nullable | Set only for a playable video variant. |
| `byteSize` | bigint | |
| `checksum` | text | |
| `state` | enum: `pending`, `ready`, `failed` | Small, closed, stable set — a single variant's own generation outcome, independent of sibling variants (a thumbnail can succeed while a medium resize fails). Matches ADR-003's rule: "any table with a meaningful lifecycle... enumerates its status values explicitly." |
| `createdAt` | timestamptz | Per `database.md` §11's literal field list (no `updatedAt`/`deletedAt` given). |

`@@unique(assetId, variantName)` — given directly by `database.md` §11 ("unique (asset_id, variant_name)"). This unique index's leftmost prefix already serves "variants by asset," so no separate index is added.

**Original is preserved, and is never served directly.** `media.assets` holds exactly one storage reference — the verified source file workers check `checksum`/dimensions/duration against. `architecture.md` §16 step 5 says *"Only ready and policy-approved variants become referenceable"* — the raw uploaded object is never what content links to. Every servable representation, including a full-quality one, is a `media.variants` row. This also means an unprocessed/un-scanned original is never accidentally exposed: nothing is servable until at least one variant reaches `ready`.

**Ordering:** variants are **not ordered relative to each other** — they are alternate representations of one asset (thumbnail vs. medium vs. playable), distinguished by name, not sequence. This is different from `post_media`/`message_attachments`, where *different assets* attached to one post/message genuinely need a display order.

**Starter variant vocabulary** (documented convention, non-blocking per the same `architecture.md` §16 reasoning as §3's purpose list):

| Purpose | Variants |
|---|---|
| `avatar`, `cover` | `thumbnail`, `medium` |
| `post` (image) | `thumbnail`, `medium`, `display` |
| `post` (video) | `thumbnail` (poster frame), `playable` (single normalized encode — no resolution ladder/adaptive bitrate, which would be the "advanced video processing" this phase explicitly excludes) |
| `message_attachment` | `thumbnail`, `medium` |

**Minor open item:** `database.md` §11's field list has no `updatedAt` for variants, but a variant regenerated in place (same `variantName`, reprocessed) would not otherwise have a timestamp reflecting that. Flagged as **OPEN DECISION** (minor) rather than silently added, since it wasn't in the original field list.

## 7. Avatar/cover foreign-key strategy

| | `social.profiles.avatarMediaId` | `community.communities.avatarMediaId` / `coverMediaId` |
|---|---|---|
| **Direction** | Profile → asset (profile "has an avatar") | Community → asset |
| **`ON DELETE`** | `SetNull` | `SetNull` |
| **Nullable** | Already nullable — unchanged | Already nullable — unchanged |

**Why `SetNull`, not `Restrict` or `Cascade`:** an avatar/cover is a *reference* to a media asset, not ownership of the profile/community row itself. If the underlying asset is ever hard-purged (end of its own retention window, per §8), the profile or community must not be destroyed or blocked from being deleted as a side effect — it simply loses its avatar/cover, the same reasoning already used for `Notification.actor` (`SetNull`: "who triggered it is display metadata; a hard actor deletion must not delete the recipient's notification").

**Circular dependency risk: none.** `media.assets.ownerUserId` references only `identity.users`. Nothing in `media` references `social.profiles` or `community.communities` back. The relationship is one-directional.

**Migration ordering:** the `media` schema and its tables must be created before the two `ALTER TABLE ... ADD CONSTRAINT` statements that add the foreign keys to the already-existing `social.profiles`/`community.communities` columns — the same ordering already used when `content.posts.communityId` got its foreign key in the Communities migration (create the referenced table first, then alter the pre-existing table in the same migration file).

**Backfill: none required.** Verified against the current dev database: `social.profiles.avatar_media_id` and `community.communities.avatar_media_id`/`cover_media_id` are **100% NULL** today (`SELECT COUNT(*) ... WHERE avatar_media_id IS NOT NULL` returns 0 for both tables) — the feature was never functional, so adding the constraint is a pure additive `ALTER TABLE`, no data migration.

## 8. Retention / deletion

Applying ADR-001's already-approved rules, not inventing new ones:

| State | Rule | Basis |
|---|---|---|
| **Uploaded but incomplete** (`media.uploads` past `expiresAt`, never completed) | Cleanup job marks the upload `expired`; the corresponding asset transitions `pending → rejected`. Never became visible content, so it does not need the full 90-day content window. | `database.md` §11: "Cleanup jobs remove abandoned reservations." Exact cadence: **OPEN DECISION** (implementation parameter). |
| **Rejected** (failed validation, or the above) | Never published/visible. | Same reasoning. **OPEN DECISION** whether to apply the general 90-day window anyway for consistency (recommended, mirroring ADR-003 §5's "messages get no bespoke retention tier" reasoning) or a shorter operational window — not resolved by any approved document. |
| **Moderation-rejected** (was `ready`, then actioned) | Follows the standard ADR-001 rule for deleted/actioned content: may be retained up to 90 days for moderation/abuse investigation; moderation evidence may be retained longer under the separate moderation/audit rule. | ADR-001 §"Deleted content" / "Moderation/audit records," applied unchanged — no new policy. |
| **Deleted** (owner-initiated) | Hidden immediately (`deletedAt` set); row purged/anonymized within 90 days. | ADR-001, identical to posts/messages. |
| **Detached** (attachment row removed, asset not explicitly deleted) | Not soft-deleted immediately (the owner might reattach it). An orphan-cleanup job identifies assets with **zero** attachment references and not set as an active avatar/cover, past a grace period, and marks them `deleted`, entering the same 90-day purge window. | `architecture.md` §16 step 6: "Deletion **and orphan cleanup** follow reference and retention policy" — explicitly names orphan cleanup as its own path. Grace period length: **OPEN DECISION**. |
| **Variants** | No independent retention timer — cascade-deleted with their parent asset. Derived/rebuildable state (architecture principle #5), not separately retained. | |
| **Attachments** (`post_media` / `message_attachments` rows) | Cascade-deleted when their parent post/message is purged (`ON DELETE CASCADE` on `postId`/`messageId`). This is also the trigger that makes an asset orphaned (see "Detached" above): deleting a post removes its `post_media` rows automatically, and the media module's own async cleanup job then picks up the now-unreferenced asset — decoupled, not a DB trigger, matching `architecture.md` principle #8 ("async where appropriate"). | |

**Why `assetId` is `RESTRICT` (§4) does not conflict with cleanup:** a raw `DELETE` on `media.assets` while an attachment row still references it is correctly blocked. The actual deletion flow always removes the attachment row first (as part of the parent post/message's own cascade), which is precisely what makes the asset orphaned and eligible for the media module's own retention job to act on independently. No asset is ever purged while a live post or message still displays it.

## 9. Storage boundary

Restating `architecture.md` §16 in database-design terms, changing nothing about the pipeline's shape and selecting no vendor:

1. **PostgreSQL stores metadata and references only** — owner, purpose, kind, declared/verified MIME, byte size, checksum, dimensions, duration, state, storage key (a private, opaque reference string, never a public URL). No binary bytes.
2. **Object storage stores binaries** — a private, S3-compatible bucket. Vendor is explicitly unselected (ADR-002 §13: deferred to the deployment/infrastructure phase).
3. **Signed upload flow:** the API authorizes and creates a `pending` asset + a `media.uploads` reservation row, then hands the client short-lived signed upload instructions. The client never chooses its own storage key.
4. **Completion/finalization:** the client's completion signal (or a provider webhook — vendor-specific, not modeled here) marks `media.uploads.completedAt` and moves the asset to `processing`.
5. **Processing state:** `media.assets.state` (`pending → processing → ready | rejected`) is the single source of truth for whether an asset may ever be referenced.
6. **Validation/scan state:** `media.assets.scanState` records the pre-publish automated check (`architecture.md` step 4: "scan where available") — a *gate* on reaching `ready`, distinct from `moderationState`, which records post-publish moderation outcomes on an already-`ready` asset (mirrors `messaging.messages.moderationState`'s existing `active`/`hidden`/`removed` pattern).
7. **Variant generation:** workers write `media.variants` rows once processing succeeds; only `ready` variants of a `ready` asset are ever referenceable (§6).
8. **Cleanup:** abandoned uploads and orphaned assets are found via the indexes in §10 and removed by an async job, per §8.

## 10. Indexing and constraints

| Table | PK | FKs | Unique | Indexes | `ON DELETE` | Timestamps |
|---|---|---|---|---|---|---|
| `media.assets` | `id` (uuid7) | `ownerUserId → identity.users` | — | `(ownerUserId, purpose, state, createdAt desc, id desc)`; `(deletedAt)` | Cascade (owner) | `createdAt`, `updatedAt`, `readyAt`, `rejectedAt`, `deletedAt` |
| `media.variants` | `id` (uuid7) | `assetId → media.assets` | `(assetId, variantName)` | *(unique index above serves "variants by asset")* | Cascade (asset) | `createdAt` |
| `media.uploads` | `id` (uuid7) | `ownerUserId → identity.users`; `assetId → media.assets` | `(assetId)` (1:1) | `(status, expiresAt)` | Cascade (owner, asset) | `createdAt`, `completedAt` |
| `content.post_media` | — (composite) | `postId → content.posts`; `assetId → media.assets` | `(postId, assetId)` | `(postId, displayOrder)`; `(assetId)` | Cascade (post); Restrict (asset) | `createdAt` |
| `messaging.message_attachments` | — (composite) | `messageId → messaging.messages`; `assetId → media.assets` | `(messageId, assetId)` | `(messageId, displayOrder)`; `(assetId)` | Cascade (message); Restrict (asset) | `createdAt` |

**Query patterns and how they're served:**
- *Assets by owner*, *assets by purpose*, *assets by status* — one compound index `(ownerUserId, purpose, state, createdAt desc, id desc)` covers all three via leftmost-prefix matching, the same cursor-pagination index shape used everywhere else in this schema (posts, shares, communities, memberships). A *global* "all pending assets regardless of owner" query (an admin/moderation pattern) is not indexed — out of scope, since Moderation is explicitly excluded from this phase.
- *Variants by asset* — the `(assetId, variantName)` unique index.
- *Uploads by asset* — the `(assetId)` unique index.
- *Uploads by status* / *cleanup of expired uploads* — one compound index `(status, expiresAt)` serves both.
- *Attachments by post* / *by message* — `(postId, displayOrder)` / `(messageId, displayOrder)`, pre-sorted so no runtime sort is needed at read time (the same lesson the Communities `mine=true` fix demonstrated this session: anchor a compound index on the actual scoping column rather than relying on a low-selectivity filter alone).

**Deliberately not added** (avoiding excessive indexes): a standalone index on `purpose` or `state` alone (never queried without an owner/asset scope in the app's normal paths); a standalone index on `uploads.ownerUserId` (not a named query pattern); a separate `assets by purpose` index (covered by the compound index's leftmost prefix once owner is also in scope).

## 11. Security

- **Ownership:** `media.assets.ownerUserId` is the single source of authorization truth for every asset; every read/write path checks it.
- **Signed upload authorization:** only the API mints a signed upload instruction, scoped to exactly one pre-created `pending` asset + reservation. The client never supplies or chooses its own storage key.
- **Private object references:** `storageKey`/`storageProvider` are never returned to a client directly; the API controls how (and whether) a ready, authorized variant is served (signed GET, controlled redirect, or proxy — an implementation choice, not a schema concern).
- **Prevention of unauthorized attachment:** creating a `post_media`/`message_attachments` row requires the caller to own *both* the asset (`assetId.ownerUserId`) *and* the parent content row (`postId.authorId` / `messageId.senderId`) — an application-layer check, since Postgres cannot express a constraint across three tables without a trigger (none is used elsewhere in this schema for a business rule).
- **Abandoned uploads:** covered by the reservation lifecycle and cleanup job (§6 uploads table, §8).
- **Protection of unpublished media:** any asset with `state != ready`, or whose only variants are not `ready`, must never be servable to a non-owner — `architecture.md` step 5's rule, enforced at the API's read/serving boundary (the database only records state; the API must check it on every read, not just at write time).
- **Interaction with blocked users:** Media does not duplicate block logic. Visibility of an asset *through* its attachment (a post's image, a message's image) inherits the block enforcement Content/Messaging already implement (`PostAccessService`, conversation participant checks). Avatar/cover visibility inherits the existing profile-visibility rule (`ProfileVisibilityService`) the same way. No new block logic is introduced by this design.
- **Moderation state before referenceable:** an asset must pass `scanState` (pre-publish automated check) before it can reach `state = ready`; `moderationState` (post-publish) can later move a `ready` asset out of public visibility without deleting it, mirroring `messaging.messages.moderationState`.

## 12. Performance

- **Large media metadata volume:** `media.assets` will be one of the largest tables in the system (every image/video ever uploaded). UUIDv7 keeps insert locality reasonable — the same time-sortable-identifier convention `database.md` §3 already mandates everywhere.
- **High upload frequency:** `media.uploads` is high-churn and short-lived (most rows resolve within minutes/hours). The `(status, expiresAt)` index directly serves its dominant query (the cleanup job); terminal rows should be periodically purged once past any debugging-retention need — an operational, not schema, decision.
- **Cleanup queries:** served by `(status, expiresAt)` on uploads and `(deletedAt)` on assets, matching the two cleanup-job query shapes.
- **Attachment lookups:** `(postId, displayOrder)` / `(messageId, displayOrder)` make "this post/message's images, in order" a single pre-sorted index scan.
- **Variant lookup:** `(assetId, variantName)` is a point lookup.
- **Ownership lookup:** the compound `(ownerUserId, purpose, state, createdAt desc, id desc)` index serves "my assets" with the same cursor-pagination shape as every other list in this codebase.
- **Index selectivity:** `state`/`purpose`/`kind` are individually low-cardinality, but only ever appear as secondary components of a compound index anchored on a high-cardinality column (`ownerUserId`, `postId`, `assetId`) — exactly the lesson the Communities `mine=true` EXPLAIN work demonstrated this session: an OR/low-selectivity predicate scans nearly everything on its own, but anchoring the index on the real scoping column avoids that.
- **No sharding or distributed design** — out of scope, per `database.md` §21's own non-goal ("no premature partitioning, sharding, or read replicas") and this task's explicit instruction.

## 13. Migration / existing-schema impact

**New tables** (all in a new `media` schema, plus two new tables in already-existing schemas):
- `media.assets`, `media.variants`, `media.uploads` (new `media` schema)
- `content.post_media` (new table in the existing `content` schema — no column added to `content.posts` itself)
- `messaging.message_attachments` (new table in the existing `messaging` schema — no column added to `messaging.messages` itself)

**Altered existing tables** (additive only — no column type change, no data touched):
- `social.profiles`: add `FOREIGN KEY (avatar_media_id) REFERENCES media.assets(id) ON DELETE SET NULL`.
- `community.communities`: add the same for `avatar_media_id` and `cover_media_id` (two constraints).

**Migration ordering:** the `media` schema/tables must be created before the two `ALTER TABLE ... ADD CONSTRAINT` statements — same file, referenced-table-first ordering already used when `content.posts.communityId` got its FK in the Communities migration.

**Circular dependency risk:** none. `media.assets.ownerUserId → identity.users` is the only cross-schema reference *out of* `media`; nothing in `media` references `social` or `community` back.

**Backfill:** none required — verified both placeholder columns are 100% NULL in the current dev database (§7).

No other Phase 1/Phase 2 table is touched.

## 14. Open decisions

1. **Comment media** — not approved product scope (PRD §17/§31 do not name it). No table designed; would mirror `post_media` if approved later.
2. **Quota numbers and scope** — what is counted (asset count, total bytes, or both) and at what scope (per user, per post, per time window) is not specified anywhere approved, and this task explicitly forbids inventing numbers.
3. **Whether in-flight reservations count against quota** — to prevent reservation-flooding abuse, or only completed/ready assets count.
4. **Retention cadence for expired uploads / rejected assets** — recommend reusing the general 90-day window for consistency (mirroring ADR-003 §5's reasoning for messages), but not resolved by any approved document.
5. **Orphan-detection grace period** — how long an unreferenced asset waits before cleanup marks it deleted; not specified anywhere.
6. **(Minor) `media.variants.updatedAt`** — `database.md` §11's literal field list omits it; flagged in case in-place variant regeneration needs a timestamp.

No ADR is proposed for these. Precedent: Communities' own schema-level judgment calls (enum-vs-text choices, `ON DELETE` direction, etc.) were resolved and recorded directly in `database.md`'s implementation-status notes, not a new ADR — this document follows the same pattern. Items 2–5 above are product-policy gaps of the kind ADR-001/ADR-002 exist to close, but since this task asks that they be marked open rather than resolved by me, there is no decision yet to enshrine in a new ADR. If the owner resolves them, they belong in a future ADR at that point, not this one.

### Tracked follow-ups

Known gaps that are **not** open design decisions (those are §14 above) — settled, but not yet built. Follows the same tracked-item convention as `api.md` §18's T-1/T-2/T-3.

- [ ] **M-1 — Retention/cleanup parameters are documented but not enforced.**
  - **State:** the owner-approved parameters (2026-09-22) — 7-day purge for expired uploads and rejected assets (§8), 48-hour orphan-detection grace period (§8) — exist only as `schema.prisma` code comments and the `(status, expiresAt)` / `(deletedAt)` indexes those future jobs would read. No scheduled job reads or enforces either number yet; nothing currently purges, expires, or orphan-detects anything.
  - **Fix direction:** implement the cleanup job(s) alongside the storage/API implementation phase (`media.md` §15 step 4), not as part of the schema/migration work. Each job needs its own test-first change and approval, the same as every other tracked item.
  - **Risk of not tracking this:** without this entry, a reviewer reading the schema comments alone could reasonably assume the 7-day/48-hour numbers are already active — they are not.

## 15. Recommended implementation sequence

Once the open decisions above are resolved (or explicitly deferred by the owner):

1. Draft the concrete Prisma models for `media.assets`, `media.variants`, `media.uploads`, `content.post_media`, `messaging.message_attachments`, plus the two FK additions to `social.profiles`/`community.communities` — for review, the same way this document was.
2. Migration, applied to local dev only, verified against `database/schema.prisma`'s existing conventions (partial-unique/CHECK patterns in raw SQL where Prisma's DSL can't express them, matching every prior migration in this repo).
3. Choose and get explicit approval for the storage-access dependency needed for local/dev implementation (not vendor selection — an S3-compatible client library) before installing anything, per the standing "no new dependencies without approval" rule.
4. Media API implementation (`/media/uploads`, `/media/{id}` per `api.md` §15), following the same tests-first, mutation-checked, EXPLAIN-verified process used for Communities.
5. Only after the Media API exists: wire `avatarMediaId` into `PATCH /me/profile` (`api.md` §16 finding 1), `mediaIds`/`communityId`... into post creation (finding 3), and message image attachments — each its own reviewed increment, not bundled into the Media module itself.
