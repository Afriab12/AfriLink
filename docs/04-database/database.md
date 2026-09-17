# AfriLink PostgreSQL Database Design

**Status:** Logical design complete for all modules below (identity, social/reference, content, feed, community, messaging, notification, media, moderation, admin/audit, search, integration). Every design decision this document depends on is now resolved via ADR-001, ADR-002, and ADR-003 (`docs/10-decisions/decisions.md`) — identifier format, lifecycle conventions, feed/search persistence, message retention, reaction cardinality and taxonomy, and reference-data seed content. Two items remain intentionally open as product content, not architecture: business-identity tables (deferred, not required for Phase 1) and any country/interest/reaction list content beyond the approved starter seed. **No executable schema exists yet** — `database/migrations/` and `database/seeds/` are present but empty, and no `schema.prisma` file exists anywhere in this repository. Phase 1 (identity, social, content, integration) in §25 is the recommended *first* implementation slice; it has not been started.
**Date:** 2026-09-13 (patched 2026-09-14 to add `social.friendships` and `content.shares`, approved MVP scope per `architecture.md` §7/§12 and ADR-002 §4 missing from the original draft; patched 2026-09-14 to add `reference.countries`/`reference.interests` and correct status claims that previously and incorrectly stated Phase 1 was implemented; patched 2026-09-14 on ADR-003 approval to resolve message retention, reaction cardinality, and reference-data seed content; patched 2026-09-14 on ADR-003 §8 approval to resolve the reaction type taxonomy)
**Database:** PostgreSQL
**ORM/migrations:** Prisma (planned), versioned migrations to be created under `database/migrations/` once implementation begins

> PostgreSQL, Prisma, Redis, and the modular-monolith constraint are defined in `CLAUDE.md`. Product scope (`docs/01-product/PRD.md`) and architecture (`docs/03-architecture/architecture.md`, ADR-001, ADR-002) are approved. Everything in this document is logical/physical design only — no application code, ORM models, or runnable migrations exist in the repository yet.

## 1. Database goals

The database must provide:

- strong transactional integrity for identity, permissions, relationships, content, memberships, and messages;
- clear ownership boundaries between modular-monolith modules;
- efficient cursor-based reads for feeds, conversations, notifications, and moderation queues;
- durable event publication through a transactional outbox;
- privacy-aware lifecycle management, deletion, retention, and auditability;
- a straightforward path to replicas, partitioning, and selective read models as usage grows.

PostgreSQL is the source of truth. Redis, object storage, search projections, and feed caches are derived or ephemeral and must be rebuildable.

### Non-goals

- No tables for marketplace, payments, jobs listings, creator monetization, or live streaming — out of MVP scope per `CLAUDE.md` and `docs/01-product/PRD.md`; none are modeled anywhere in this document.
- No microservice-per-schema split, no second system of record, and no graph database — the modular monolith uses one PostgreSQL database with ownership-separated schemas (`architecture.md` §1/§8).
- No dedicated search platform (Elasticsearch/OpenSearch) — PostgreSQL full-text search is the MVP baseline (ADR-003 §4).
- No business/organization identity tables for MVP — individual accounts only (§24 risk table).
- No premature partitioning, sharding, or read replicas — §21 defines the trigger conditions rather than building for hypothetical scale now.

## 2. Logical database layout

Use one PostgreSQL database initially. Organize tables into PostgreSQL schemas by module ownership:

| Schema | Responsibility |
|---|---|
| `identity` | Users, credentials, sessions, verification, roles, account state |
| `reference` | Controlled reference data: countries, interests, and other shared lookup values |
| `social` | Profiles, follows, friendships, blocks, user preferences, user-interest selections |
| `content` | Posts, comments, reactions, shares, visibility, content references |
| `feed` | Materialized feed entries and ranking metadata |
| `community` | Communities, memberships, roles, invitations |
| `messaging` | Conversations, participants, messages, receipts |
| `notification` | Notification records, preferences, delivery attempts |
| `media` | Upload reservations, assets, variants, processing state |
| `moderation` | Reports, cases, evidence references, decisions, appeals, sanctions |
| `admin` | Platform configuration, feature flags, administrative actions |
| `audit` | Append-only security and compliance audit events |
| `search` | Search projection metadata and indexing state |
| `integration` | Idempotency records and transactional outbox |

The application layer must respect schema ownership. A module may query another module through a repository/application contract, not by reaching into another module's tables from arbitrary code.

## 3. Common data conventions

### Identifiers

- Use UUIDv7, ULID, or an equivalent time-sortable identifier for public and primary keys. Select one format before implementation and use it consistently.
- Public IDs must not expose sequential database identity.
- Foreign keys use the same identifier type as their referenced primary key.
- External provider IDs are stored separately from internal IDs and scoped by provider.

### Timestamps

- Use `timestamptz` for `created_at`, `updated_at`, and lifecycle timestamps.
- Store timestamps in UTC; render them in the user's locale/time zone at the application boundary.
- Use database defaults for creation timestamps and application-controlled updates for modification timestamps.

### Lifecycle fields

Durable user-generated and administrative records should use the applicable subset of:

- `created_at`;
- `updated_at`;
- `deleted_at` for user-visible soft deletion;
- `deleted_by` or `deletion_reason` where auditability is required;
- `status` for explicit workflow state.

Do not use soft deletion as a replacement for retention policy. Personal data deletion, legal holds, moderation evidence, and audit retention require separate policy decisions.

### Text, JSON, and enums

- Use `text` for human text with application length limits.
- Use `citext` or normalized text for case-insensitive usernames, handles, and email lookup where appropriate.
- Use `jsonb` only for provider payloads, flexible metadata, and versioned settings—not for core relationships.
- Prefer database constraints for small, stable state sets. Use lookup tables or validated text for policies likely to change frequently.
- Normalize user-provided Unicode before uniqueness/search operations while preserving the original display form.

### Privacy and sensitive values

- Store password and token material only as one-way hashes where possible.
- Encrypt high-risk fields at the application or managed database layer; keep encryption keys outside PostgreSQL.
- Do not store media bytes, access tokens, secrets, or raw provider credentials in the database.
- Treat message bodies, reports, evidence references, contact information, and authentication metadata as sensitive.

## 4. Identity schema

### `identity.users`

The canonical account record.

| Column | Type/meaning | Rules |
|---|---|---|
| `id` | public identifier | Primary key |
| `handle` | normalized unique handle | Unique; nullable until onboarding if allowed |
| `status` | active, restricted, suspended, banned, pending_deletion, deleted | Required |
| `account_type` | individual, creator, business, organization | Required; product policy controls available types |
| `locale` | BCP 47 locale | Default from onboarding; validated |
| `timezone` | IANA time zone | Validated |
| `created_at`, `updated_at` | timestamps | Required |
| `deleted_at` | timestamp | Nullable; handle reuse policy must be explicit |

Recommended indexes: unique normalized handle, status/created-at, and deleted-at lifecycle queries.

### `identity.credentials`

Stores authentication methods, never plaintext credentials.

- `id`, `user_id`, `kind`, `identifier_normalized`, `secret_hash`, `verified_at`, `last_used_at`, `created_at`, `revoked_at`.
- Unique `(kind, identifier_normalized)` for active credentials.
- A user may have multiple credentials; recovery and verification rules are enforced by the Identity module.
- For phone/email OTP, store only the hash of the challenge, expiry, attempt count, and consumed timestamp in a separate challenge record if required.

### `identity.sessions`

- `id`, `user_id`, `refresh_token_hash`, `device_id`, `device_label`, `ip_hash`, `user_agent_hash`, `created_at`, `last_seen_at`, `expires_at`, `revoked_at`, `revoke_reason`.
- Unique refresh-token hash; index `(user_id, revoked_at, expires_at)`.
- Never log raw tokens. Revoke all sessions after high-risk credential changes when policy requires it.

### `identity.verification_challenges`

- `id`, `user_id`, `channel`, `destination_hash`, `purpose`, `challenge_hash`, `attempt_count`, `expires_at`, `consumed_at`, `created_at`.
- Index active challenges by destination/purpose and expiry.
- Enforce one-time use and rate limits at the application and infrastructure layers.

### `identity.roles`, `identity.permissions`, `identity.role_permissions`, `identity.user_roles`

Platform roles are separate from community roles. Store scoped assignments with:

- role/permission identifiers;
- `user_id`, optional scope type and scope ID;
- grantor and timestamps;
- optional expiry.

Never model a community moderator as a global administrator. Unique constraints must prevent duplicate active assignments.

## 5. Social schema

Countries and Interests are explicit MVP core modules (`CLAUDE.md`; PRD §14/§15; `architecture.md` §19 "Countries & Interests own supported reference data and user selections") but had no dedicated tables in earlier drafts of this document — profile country was a bare text field. The `reference.*` tables below close that gap; they live in their own schema (see §2) because they are shared, module-agnostic lookup data rather than social-graph data, but are documented alongside `social.profiles` since that is their primary consumer.

### `reference.countries`

- `code` primary key — ISO 3166-1 alpha-2, stored uppercase;
- `name`, `name_local` (optional), `region` (continent/sub-region grouping for Discover), `is_active`, `sort_order`;
- `created_at`, `updated_at`.

Countries are additive reference rows, not a schema or code change, consistent with ADR-002's Nigeria-first-but-not-Nigeria-only launch posture. Approved starter seed content (Nigeria plus six other African countries) is defined in ADR-003 §7 (`docs/10-decisions/decisions.md`) — editable later as plain row content, no migration required.

### `reference.interests`

- `id`, `slug` (unique, stable, used by clients), `label`, `category` (optional grouping), `is_active`, `sort_order`;
- `created_at`, `updated_at`.

The table shape is fixed here; the approved 18-item starter taxonomy is defined in ADR-003 §7 (`docs/10-decisions/decisions.md`) as placeholder content, expected to change based on real usage without any schema change.

### `social.profiles`

- `user_id` primary key and foreign key to `identity.users`;
- `display_name`, `bio`, `avatar_media_id`, `country_code` (foreign key to `reference.countries.code`, nullable until onboarding), `region`, `website_url`;
- `visibility`, `language_preferences`, `profile_metadata`;
- `created_at`, `updated_at`, `deleted_at`.

Do not use free-form profile metadata for authorization or moderation decisions. Country is a foreign key into `reference.countries`, not a free-text or hardcoded value, so it stays consistent and queryable for Discover's country-relevance ranking (`architecture.md` §19). Language code format must still be selected and validated before implementation.

### `social.user_interests`

- `user_id` (foreign key to `identity.users`), `interest_id` (foreign key to `reference.interests`), `created_at`;
- composite primary key `(user_id, interest_id)` — a user cannot select the same interest twice by construction;
- index `(interest_id, user_id)` to support interest-based Discover queries ("find users who share this interest").

### `social.follows`

- `follower_id`, `followee_id`, `status`, `created_at`, `deleted_at`;
- primary/unique active relationship on `(follower_id, followee_id)`;
- indexes `(followee_id, created_at, follower_id)` and `(follower_id, created_at, followee_id)`;
- check preventing self-follow unless explicitly approved by product policy.

Use soft deletion or a relationship state if historical follow events are needed. Counts are derived and repairable, not authoritative.

### `social.friendships`

Friendship is a distinct, mutual relationship from following (architecture.md §12, ADR-002 §4): a request requires acceptance, and the relationship is private by default.

- `id`, `requester_id`, `addressee_id`, `status` (`pending`, `accepted`, `declined`, `removed`), `requested_at`, `responded_at`, `created_at`, `updated_at`;
- check preventing a self-request (`requester_id <> addressee_id`);
- unique active relationship per unordered pair regardless of who initiated — enforce on `(least(requester_id, addressee_id), greatest(requester_id, addressee_id))` where `status` is `pending` or `accepted`, since a plain column-order unique constraint would allow both `(A,B)` and `(B,A)` to coexist;
- indexes `(requester_id, status, created_at)` and `(addressee_id, status, created_at)` for request-list queries in both directions.

Friend-list visibility defaults to private and is controlled by the account owner's privacy settings (`social.user_preferences`), independent of the follow graph's default-public visibility.

### `social.blocks`

- `blocker_id`, `blocked_id`, `reason_code`, `created_at`, `deleted_at`;
- unique active pair `(blocker_id, blocked_id)`;
- indexes in both directions for authorization and suppression checks;
- check preventing self-block.

Blocks must be applied before profile discovery, feed assembly, notifications, and messaging visibility.

### `social.user_preferences`

Stores privacy defaults, discovery settings, locale preferences, accessibility settings, quiet hours, and notification defaults. Keep channel-specific notification preferences in `notification` if the owning module requires it.

## 6. Content schema

### `content.posts`

- `id`, `author_id`, optional `community_id`, `body`, `status` (`published`, `hidden`, `removed`), `visibility`, `language_code`;
- `published_at`, `edited_at`, `deleted_at`, `created_at`, `updated_at`;
- optional `reply_to_post_id` only if threaded posts are approved;
- `hidden` and `removed` are moderation outcomes (architecture.md §20), `deleted_at` is the author's own deletion — moderation state must be explicit and separate from deletion status, not folded into one ambiguous flag.

Indexes:

- `(author_id, created_at desc, id desc)`;
- `(community_id, created_at desc, id desc)` for community feeds;
- `(status, published_at desc, id desc)` for moderation and projection workers;
- partial indexes excluding deleted or non-published rows where useful.

### `content.comments`

- `id`, `post_id`, `author_id`, optional `parent_comment_id`, `body`, `status` (`published`, `hidden`, `removed`), `created_at`, `updated_at`, `deleted_at`;
- indexes `(post_id, created_at, id)` and `(parent_comment_id, created_at, id)`;
- foreign keys must prevent orphan comments unless a deliberate tombstone policy is implemented.

### `content.post_reactions` and `content.comment_reactions`

Separate target tables per content type (rather than one `content.reactions` table with a polymorphic target), so referential integrity to `posts`/`comments` stays a real foreign key.

- `user_id`, `post_id` (or `comment_id`), `reaction_type`, `created_at`, `deleted_at`;
- unique active **`(user_id, post_id)`** / **`(user_id, comment_id)`** — one active reaction per user per post/comment (ADR-003 §6, `docs/10-decisions/decisions.md`). Selecting a new reaction type updates or replaces the existing row; it does not insert a second one.

`reaction_type` is constrained to the approved five-value set (ADR-003 §8): **Like, Love, Laugh, Support, Insightful**. Store it as a short application-level enum or a small `reference.reaction_types` lookup table (implementation's choice, not an architecture question); either way it is a fixed, reviewed list, not free text. The list can change later without altering the shape of `content.post_reactions`/`comment_reactions` themselves.

### `content.shares`

Users share eligible posts within AfriLink, preserving the original author and source context (PRD §18; architecture.md §7 Content module).

- `id`, `user_id`, `post_id`, optional `comment` (user commentary on the share), `created_at`, `deleted_at`;
- indexes `(user_id, created_at desc, id desc)` and `(post_id, created_at desc, id desc)`;
- a share references the original post by ID only — it does not copy content, so visibility/block/deletion/moderation checks are re-evaluated against the source post at read time, not frozen at share time.

External sharing, quote-post-style resharing commentary beyond a single optional comment field, and resharing-of-a-share are not modeled here pending product approval (PRD §18).

### `content.post_media` and `content.comment_media`

Join approved media assets to content with an explicit ordering, alt text, and display metadata. Media ownership remains with `media`; content rows reference media IDs and must not store provider URLs as the authority.

### `content.visibility_rules`

Use an explicit visibility model such as `public`, `followers`, `community_members`, `mentioned_users`, and `private`. If exceptions are required, store them in a constrained access table rather than embedding user IDs in JSON.

Visibility is evaluated with account state, blocks, community membership, moderation state, and deletion state.

## 7. Feed schema

### `feed.entries`

Derived per-viewer or per-source feed records:

- `id`, `viewer_id`, `post_id`, optional `community_id`;
- `source_type`, `source_id`, `ranking_version`, `score`;
- `created_at`, `eligible_at`, `expires_at`, `hidden_at`.

Indexes:

- `(viewer_id, eligible_at desc, id desc)` for cursor pagination;
- `(post_id, viewer_id)` for invalidation and deduplication;
- queue/rebuild indexes by ranking version and eligibility.

Feed entries are disposable projections. The Content, Social, Community, and Moderation modules remain authoritative. A rebuild job must be able to regenerate entries after deletion, block, privacy, or ranking changes.

## 8. Community schema

### `community.communities`

- `id`, `owner_user_id`, `slug`, `name`, `description`, `visibility`, `membership_policy`;
- `avatar_media_id`, `cover_media_id`, `rules`, `status`;
- `created_at`, `updated_at`, `deleted_at`.

Unique active slug; public discovery indexes should exclude deleted/private records as appropriate.

### `community.memberships`

- `community_id`, `user_id`, `status` (`pending`, `active`, `rejected`, `left`, `removed`, `banned`);
- `role`, `requested_at`, `approved_at`, `approved_by`, `left_at`, `removed_at`, `created_at`, `updated_at`;
- unique active `(community_id, user_id)`;
- indexes `(community_id, status, created_at, user_id)` and `(user_id, status, created_at, community_id)`.

### `community.invitations`

Store inviter, invitee or token hash, community, expiry, acceptance/revocation state, and timestamps. Tokens must be hashed and single-use.

### `community.moderator_assignments`

If community roles require more detail than membership roles, store scoped role assignments with grantor, expiry, and revocation. These records must never map directly to platform roles.

## 9. Messaging schema

### `messaging.conversations`

- `id`, `kind`, `created_by`, `title`, `status`, `last_message_at`, `created_at`, `updated_at`, `deleted_at`;
- index `(last_message_at desc, id desc)` for user conversation lists only through participant joins.

**Phase scoping:** the `kind` column exists so group conversations don't require a restructure later (`architecture.md` §14: "does not preclude group conversations later"), but its CHECK constraint is **`direct`-only for as long as messaging is implemented under MVP scope** (ADR-002 §7: one-to-one only). Nothing else in this schema — `messaging.participants`, fan-out, moderation, or notification policy — is designed for more than two participants, so allowing `group` at the database layer before that design work exists would let the system reach a state it can't safely handle. Widening the CHECK constraint to add `group` when it is actually approved is a pure additive migration, not a restructure.

### `messaging.participants`

- `conversation_id`, `user_id`, `role`, `joined_at`, `left_at`, `muted_until`, `last_read_message_id`, `status`;
- unique active `(conversation_id, user_id)`;
- index `(user_id, status, last_read_message_id)`.

### `messaging.messages`

- `id`, `conversation_id`, `sender_id`, client idempotency key, `body`, `status`, `moderation_state`;
- `created_at`, `edited_at`, `deleted_at`, optional `reply_to_message_id`;
- unique `(sender_id, client_message_id)` to make mobile retries safe;
- index `(conversation_id, created_at, id)` for cursor reads;
- index `(sender_id, created_at)` for abuse and audit workflows.

Messages are append-oriented. `deleted_at` hides a message from participants immediately; the row (or an anonymized tombstone) is purged **90 days** after deletion, matching the general content-retention window under ADR-001 — messages get no bespoke retention tier (ADR-003 §5, `docs/10-decisions/decisions.md`). Moderation evidence captured before deletion follows the separate moderation/audit retention rule in ADR-001, independent of this window.

### `messaging.message_receipts`

- `message_id`, `user_id`, `delivered_at`, `read_at`;
- unique `(message_id, user_id)`;
- use conversation-level read cursors for scale, with per-message receipts only if required by product behavior.

## 10. Notification schema

### `notification.notifications`

- `id`, `recipient_user_id`, `actor_user_id`, `type`, `target_type`, `target_id`;
- `group_key`, `payload` or safe display metadata, `read_at`, `created_at`, `deleted_at`;
- index `(recipient_user_id, created_at desc, id desc)`;
- deduplication key for repeated domain events.

Do not store sensitive message bodies in notification payloads. Re-resolve target visibility when a notification is read.

### `notification.preferences`

Store user, category, channel, enabled state, locale, quiet-hour configuration, and timestamps. Enforce one row per `(user_id, category, channel)`.

### `notification.deliveries`

- `notification_id`, `channel`, provider, provider message ID, state, attempt count, next attempt time, delivered/failed timestamps, error category;
- unique provider delivery key where available;
- indexes for pending retry work and provider reconciliation.

## 11. Media schema

### `media.assets`

- `id`, `owner_user_id`, `storage_provider`, private object key, `kind`, `state`;
- declared and verified MIME type, byte size, checksum, width, height, duration;
- `scan_state`, `moderation_state`, `created_at`, `ready_at`, `rejected_at`, `deleted_at`.

Never trust the client-declared MIME type. The asset becomes referenceable by public content only after validation and approval.

### `media.variants`

- `id`, `asset_id`, variant name, private object key, MIME type, dimensions, byte size, checksum, state, created_at;
- unique `(asset_id, variant_name)`.

### `media.uploads`

Tracks upload reservation and resumable parts: owner, asset, provider upload ID, expiry, expected size/checksum, completed timestamp, and failure state. Cleanup jobs remove abandoned reservations.

## 12. Moderation schema

### `moderation.reports`

- `id`, reporter, target type and target ID, reason code, description, status, priority, created_at, updated_at, resolved_at;
- deduplication key for equivalent active reports where policy permits;
- indexes by status/priority/created-at and target.

Because PostgreSQL cannot enforce a foreign key to multiple target tables, target references require an application-level target resolver and periodic integrity checks. If strict referential integrity is required, use separate report tables per target type.

### `moderation.cases`

- `id`, queue, assigned moderator, status, priority, SLA timestamps, source, created_at, updated_at, closed_at;
- link reports through `moderation.case_reports`.

### `moderation.actions`

- `id`, case ID, actor ID, target type/ID, action type, reason code, duration, starts/ends, reversal information, created_at;
- append-only; corrections are compensating actions, not destructive updates.

### `moderation.appeals`

Store action, appellant, statement, state, reviewer, decision, timestamps, and appeal deadline. Enforce one active appeal per applicable action unless policy allows multiple levels.

### `moderation.sanctions`

Store subject, scope, type, reason, start/end, source action, and current state. Scope must distinguish platform, community, content, and messaging restrictions.

## 13. Admin and audit schemas

### `admin.feature_flags`

Store key, environment, state, rollout rules, owner, expiry, and timestamps. Do not use feature flags as an authorization mechanism.

### `admin.provider_configs`

Store non-secret provider identifiers and operational state only. Secrets belong in a managed secret store.

### `audit.events`

Append-only records for authentication, credential changes, role changes, moderation, data access, exports, deletion, and administrative actions.

Suggested fields:

- event ID, event type, actor ID or system actor, subject type/ID;
- request ID, trace ID, IP hash, user-agent hash, reason, timestamp;
- safe structured metadata with strict redaction rules.

Audit records require restricted access, retention rules, and tamper-evident operational controls. They must not contain passwords, tokens, message bodies, or unnecessary PII.

## 14. Search schema

### `search.documents`

Search is initially implemented with PostgreSQL full-text search and projections. Store searchable entity type, entity ID, normalized document fields or generated vector, visibility state, language, version, and indexed timestamp.

- Only public/eligible content is projected.
- Deletions, blocks, sanctions, and privacy changes enqueue projection updates.
- Search results must re-check authorization against source modules before returning.
- A future search engine may replace this projection without changing source ownership.

Use generated `tsvector` columns and GIN indexes only after testing language/configuration requirements across initial markets.

## 15. Integration schema

### `integration.outbox_events`

The transactional outbox guarantees that committed state changes can be published to workers.

- `id`, event type/version, aggregate type/ID, payload, occurred_at;
- `available_at`, `published_at`, attempt count, last error, locked-until;
- index pending events by `(published_at, available_at, occurred_at)`.

Write the business mutation and outbox row in the same transaction. Consumers must be idempotent because delivery is at least once.

### `integration.idempotency_keys`

- owner/user, key, command type, request fingerprint, status, response reference or safe response payload, created/expires timestamps;
- unique `(owner_id, key, command_type)`;
- reject reuse with a different request fingerprint;
- apply retention limits and never store secrets in the response payload.

## 16. Relationship overview

```mermaid
erDiagram
	USERS ||--o| PROFILES : has
	COUNTRIES ||--o{ PROFILES : "located in"
	USERS ||--o{ USER_INTERESTS : selects
	INTERESTS ||--o{ USER_INTERESTS : "selected via"
	USERS ||--o{ CREDENTIALS : authenticates
	USERS ||--o{ SESSIONS : opens
	USERS ||--o{ FOLLOWS : creates
	USERS ||--o{ FRIENDSHIPS : requests
	USERS ||--o{ BLOCKS : creates
	USERS ||--o{ POSTS : authors
	POSTS ||--o{ COMMENTS : contains
	POSTS ||--o{ REACTIONS : receives
	POSTS ||--o{ SHARES : "shared as"
	USERS ||--o{ SHARES : shares
	USERS ||--o{ COMMUNITIES : owns
	COMMUNITIES ||--o{ MEMBERSHIPS : has
	USERS ||--o{ MEMBERSHIPS : joins
	CONVERSATIONS ||--o{ PARTICIPANTS : includes
	USERS ||--o{ PARTICIPANTS : joins
	CONVERSATIONS ||--o{ MESSAGES : contains
	USERS ||--o{ MESSAGES : sends
	USERS ||--o{ NOTIFICATIONS : receives
	USERS ||--o{ MEDIA_ASSETS : owns
	USERS ||--o{ REPORTS : submits
```

This is a logical overview, not an executable complete schema. Module-owned tables and cross-module contracts remain authoritative.

## 17. Integrity and authorization rules

1. Every user-facing write is authorized in the application layer before insertion or update.
2. Database foreign keys prevent orphaned durable records wherever the target is a concrete table.
3. Unique constraints enforce handles, active relationships, memberships, credentials, client message IDs, and idempotency keys.
4. Check constraints prevent invalid self-relationships, negative counters, invalid state combinations, and impossible timestamps.
5. Visibility checks combine source ownership, account state, block edges, relationship state, community membership, moderation sanctions, and deletion state.
6. Counters, feed entries, search documents, and notification aggregates are derived and repairable.
7. Cross-module domain events are delivered at least once and must be safe to replay.
8. Administrative and moderation mutations are append-only or represented by compensating records.

## 18. Indexing and query standards

- All large ordered lists use a stable cursor based on `(timestamp, id)`, not offset pagination.
- Every foreign key used in filtering or joins receives a supporting index unless query evidence proves otherwise.
- Partial indexes should exclude deleted, expired, or non-active rows where that materially reduces index size.
- Use `EXPLAIN (ANALYZE, BUFFERS)` during performance review for feed, profile, search, conversation, notification, and moderation queries.
- Set statement timeouts for API transactions and separate longer worker limits.
- Avoid unbounded joins, eager loading, and user-controlled sort expressions.
- Maintain query budgets and monitor slow-query logs without recording sensitive query parameters.

## 19. Transactions and concurrency

- Use a transaction for each domain command that changes authoritative state and writes its outbox event.
- Keep transactions short; do not call external providers while holding database locks.
- Use unique constraints for idempotency and handle conflicts explicitly.
- Use row locks only for narrow state transitions such as membership approval, moderation assignment, or upload completion.
- Prefer optimistic concurrency using `updated_at` or a version column for editable profiles and moderation cases.
- Choose isolation levels deliberately; default `READ COMMITTED` is sufficient for most commands, while high-contention workflows require tested locking strategies.

## 20. Deletion, retention, and privacy

Define retention periods with legal and product owners before production:

- Account deletion marks user-facing records unavailable, revokes sessions, removes discoverability, and queues data erasure/anonymization.
- Content deletion hides content immediately while retaining only the minimum evidence required for moderation, legal hold, or abuse prevention; the underlying row is purged/anonymized 90 days after deletion (ADR-001).
- Messages follow the same 90-day post-deletion window as content generally (ADR-003 §5) — no separate messaging-specific retention tier. Deletion behavior still distinguishes user-visible deletion (immediate) from required safety evidence (retained separately per moderation/audit rules).
- Audit events and moderation decisions follow a separate restricted retention schedule.
- Media objects and variants are deleted asynchronously after all references are removed or anonymized.
- Backups follow their own expiry and restoration privacy controls.

Every destructive workflow must be idempotent, auditable, and resumable.

## 21. Partitioning and growth plan

Do not partition tables on day one without measured need. First candidates, based on observed volume, are:

1. `messaging.messages` by time or conversation hash;
2. `audit.events` by month;
3. `feed.entries` by time or viewer hash;
4. notification delivery attempts by time.

Partitioning requires migration rehearsals, compatible indexes, retention automation, query testing, and operational documentation. Add read replicas for safe read workloads only after replication lag and consistency requirements are understood.

## 22. Backup, recovery, and operations

- Use encrypted managed backups and point-in-time recovery.
- Define RPO/RTO after product and operational targets are approved.
- Test restoration into an isolated environment on a recurring schedule.
- Store migration history and deployment compatibility checks in source control.
- Monitor connection pool usage, transaction age, locks, deadlocks, replication lag, table/index growth, vacuum health, bloat, slow queries, and failed migrations.
- Use separate credentials for application runtime, migrations, read-only analytics, and operations.
- Production schema changes require review, backward compatibility, rollback or forward-fix planning, and a maintenance/runbook entry.

## 23. Migration strategy

1. Every schema change is versioned and reviewed.
2. Prefer expand-and-contract changes: add nullable/new structures, deploy compatible code, backfill asynchronously, switch reads/writes, then remove obsolete structures later.
3. Never combine a destructive migration with the first code release that depends on it.
4. Backfills are resumable jobs with progress tracking and rate limits.
5. Test migrations against representative data volumes and a restored backup.
6. The migration tool must be the only normal mechanism for production schema changes.

## 24. Database risks and decisions required

| Risk/decision | Why it matters | Status |
|---|---|---|
| Identifier format | Affects every foreign key and cursor | **Resolved:** UUIDv7 (ADR-003 §1, `docs/10-decisions/decisions.md`). Earlier drafts of this document cited this as "Resolved... per ADR-002" — incorrect, ADR-002 (`docs/03-architecture/approval-gate.md`) does not address identifiers; corrected 2026-09-14, now correctly resolved via ADR-003 |
| Initial countries/languages | Affects locale, search, and profile fields | **Resolved for MVP:** Nigeria + 6 other African countries seeded, English-only (no `reference.languages` table needed for one language) — ADR-003 §7. Expanding the country list or adding a second language later is a content/seed change, not a schema change |
| Product scope | Determines tables and relationships | **Resolved:** PRD approved (`docs/01-product/PRD.md`) |
| Privacy/legal retention | Determines deletion and audit behavior | **Resolved:** ADR-001 (`docs/10-decisions/decisions.md`) — 30/90-day windows |
| Reaction cardinality and taxonomy | Affects `post_reactions`/`comment_reactions` uniqueness and allowed values | **Resolved:** one active reaction per user per post/comment (ADR-003 §6) — unique `(user_id, post_id)` / `(user_id, comment_id)`; five allowed types — Like, Love, Laugh, Support, Insightful (ADR-003 §8) |
| Message retention | High sensitivity and storage growth | **Resolved:** 90 days post-deletion, same window as general content under ADR-001 — no bespoke messaging tier (ADR-003 §5) |
| Business identities | May require organization tables and permissions | Open — not required for the Phase 1 implementation slice |
| Search strategy | Affects projections and indexes | **Resolved:** PostgreSQL full-text search first (ADR-003 §4); revisit only if language/relevance/latency evidence justifies a dedicated search engine |
| Scale targets | Determines partitioning and replicas | **Partially resolved:** 99.5% availability, p95<500ms, ~10k/1k capacity targets approved (ADR-002); RPO/RTO and vendor/region deferred to infrastructure phase |

## 25. Recommended implementation order after approval

1. ~~Confirm PRD, identity policy, countries/languages, retention, and identifier format.~~ Resolved: PRD, ADR-001, ADR-002, ADR-003.
2. Create the initial Prisma/PostgreSQL migration for identity, reference, social, content, and integration foundations.
3. Add communities, messaging, notifications, media, moderation, audit, feed, and search projections incrementally. Messaging requires no further retention decision (ADR-003 §5) before it can be implemented.
4. Add constraints and authorization-focused integration tests before feature breadth.
5. Seed `reference.countries` and `reference.interests` with the ADR-003 §7 starter content, plus other representative seed data and query-performance fixtures.
6. Validate backup/restore, migration rollback/forward-fix, outbox replay, deletion workflows, and privacy checks.

This document's design is now fully approved (PRD, ADR-001, ADR-002, ADR-003). Step 2 onward — actual Prisma schema and migrations — is implementation work outside this document's scope and has not been started in this repository.
