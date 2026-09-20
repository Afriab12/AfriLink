# AfriLink Decisions

## ADR-001: MVP Approval Gate Decisions — Privacy, Moderation, Retention, Identity, Data Residency

**Status:** Approved for MVP architecture
**Date:** 2026-09-14
**Scope:** Resolves the blocking decisions identified in `docs/01-product/project-discovery.md` §5 ("Decisions that block implementation") for privacy, moderation, retention, identity, and data residency.

---

### 1. Privacy

AfriLink follows a **Privacy by Design** approach.

AfriLink will:

- Collect only data necessary for defined product features and legitimate purposes.
- Allow users to access their personal information.
- Provide a mechanism for users to request/export their data.
- Provide a mechanism for users to request account/data deletion.
- Not sell user personal data to third parties.
- Protect personal data in transit and at rest.
- Treat private messages, contact information and precise location information as protected/private data.
- Implement privacy controls at the product and API authorization layers.
- Maintain appropriate security and audit controls.

AfriLink will design its privacy architecture to support applicable Nigerian data-protection requirements and maintain flexibility for additional jurisdictions.

Formal legal/compliance review remains required before launch and before intentionally targeting additional regulated markets.

---

### 2. Moderation

AfriLink will use **post-moderation** for MVP. Content may be published after basic automated checks.

AfriLink will combine:

- Automated filtering
- User reporting
- Moderation queues
- Human review
- Account enforcement
- Appeals

Moderators may:

- Remove content
- Restrict content
- Warn users
- Suspend accounts
- Ban accounts
- Restrict community participation

Users may:

- Report content
- Report users
- Report communities
- Block users
- Appeal eligible moderation decisions

Advanced AI moderation is a future enhancement and is not required for MVP.

---

### 3. Data Retention

**Active accounts:** Data remains while the account remains active and while retention is necessary for the relevant lawful product purposes.

**Deleted accounts:** Personal account data should be scheduled for deletion or irreversible anonymization within **30 days**, except information that must be retained for legitimate legal, security, fraud-prevention, regulatory or dispute-resolution purposes.

**Deleted content:** Deleted posts and related recoverable content may be retained for up to **90 days** for moderation, abuse investigation, recovery and operational safety before deletion or irreversible anonymization where appropriate.

**Moderation/audit records:** Moderation and security records may be retained as necessary for safety, appeals, abuse prevention and legal obligations.

**Messages:** Retained according to the account/conversation lifecycle and applicable privacy and safety requirements. Final technical deletion and backup behavior must be documented in the data-retention architecture.

**Backups:** Data deletion procedures must account for backup copies and backup expiration.

Retention policies must be documented and periodically reviewed.

---

### 4. Identity

AfriLink MVP will not require KYC or government-issued identity verification.

Users may register using:

- Email
- Phone number
- Password

Account activation requires verification.

Users may use a username, display name, and profile name. AfriLink will not enforce a universal real-name policy.

Future verification categories may include: Person, Creator, Business, Organization. Government-ID/KYC verification is out of scope for MVP.

---

### 5. Data Residency

AfriLink MVP does not impose a universal Nigeria-only data-storage requirement.

Production infrastructure will use appropriate cloud regions selected according to: latency, reliability, security, data-protection requirements, operational cost, and applicable cross-border transfer requirements.

The architecture must remain capable of supporting regional or country-specific data residency requirements in the future.

Any cross-border transfer of personal data must be reviewed against applicable law and contractual/technical safeguards before production use.

---

### 6. Compliance Position

For Nigeria, AfriLink will design toward the requirements of the **Nigeria Data Protection Act 2023** and applicable NDPC requirements.

For European users, GDPR applicability will be assessed based on AfriLink's actual activities, user targeting and processing operations. AfriLink must not claim blanket GDPR compliance without an appropriate legal/compliance assessment.

---

### 7. Architecture Consequences

These decisions require:

- Privacy-aware database design
- User data-export capability
- Account-deletion workflow
- Data-retention jobs
- Authorization at the API layer
- Moderation audit logs
- Report/appeal data structures
- Secure message handling
- Backup-retention policy
- Region-aware infrastructure configuration
- Compliance documentation
- Administrative audit trails

These requirements are reflected in `docs/03-architecture/architecture.md`. They must also be reflected in the database, API, security and deployment specifications as those are produced.

### Still open (not resolved by this ADR)

- Initial launch country/countries, target segment, diaspora scope, launch sequence.
- Supported languages, age policy, accessibility target.
- Friend/follow semantics, visibility modes, messaging permissions, community model.
- Feed/Discover ranking, cold-start behavior, reaction set, sharing behavior, content limits.
- Moderation taxonomy detail, sanction durations, response-time SLAs, legal escalation path.
- Specific cloud region/vendor selection, traffic assumptions, numeric SLOs, RPO/RTO.

---

## ADR-003: Database Foundations — Identifier Strategy, Lifecycle Fields, Feed/Search Persistence, Message Retention, Reaction Cardinality/Taxonomy, and Reference-Data Seed Content

**Status:** Approved for MVP database foundations
**Date:** 2026-09-14 (approved; §1–4 drafted 2026-09-14 to formalize decisions already reasoned through in `docs/04-database/database.md` and `docs/03-architecture/architecture.md`; §5–7 added 2026-09-14 on owner approval to resolve message retention, reaction cardinality, and reference-data seed content; §8 added 2026-09-14 on owner approval to resolve the reaction type taxonomy, closing every item this ADR opened)
**Scope:** Identifier format, lifecycle/soft-delete field conventions, feed persistence strategy, search persistence strategy, message retention window, reaction cardinality, reaction type taxonomy, and initial reference-data seed content for the PostgreSQL database (`docs/04-database/database.md`).

This ADR does not change ADR-001 or ADR-002, which remain in effect unmodified.

---

### 1. Identifier strategy

All public and primary-key identifiers use **UUIDv7** (time-sortable, so they double as a natural insertion-order cursor component without leaking sequential row counts the way a bare auto-increment integer would).

- Generated by application/ORM code, not a PostgreSQL extension — keeps the database vendor-neutral per ADR-002 §13.
- Foreign keys use the same type as their referenced primary key.
- External provider IDs (OAuth subject IDs, payment/email/SMS provider references, etc.) are stored separately from internal IDs and scoped by provider — never reused as a primary key.

### 2. Lifecycle field conventions

Durable records use the applicable subset of `created_at` / `updated_at` (both `timestamptz`, UTC) / `deleted_at` (soft delete) / `status` (explicit workflow state), per `database.md` §3.

- Soft deletion (`deleted_at`) is for user-facing "this is gone" semantics only. It is not a substitute for retention/legal-hold policy — moderation evidence and audit records follow their own retention rules regardless of `deleted_at`.
- Any table with a meaningful lifecycle beyond "exists / soft-deleted" (e.g. `content.posts`, `content.comments`, `community.memberships`, `moderation.cases`) enumerates its `status` values explicitly in the design document rather than leaving `status` as an untyped string.

### 3. Feed persistence strategy

MVP feed uses a **bounded hybrid push/pull model** backed by the `feed.entries` table (`database.md` §7, `architecture.md` §13): bounded fan-out on publish for normal accounts, pull-on-read for high-fan-out authors, with `feed.entries` treated as a disposable, rebuildable projection — Content/Social/Community/Moderation remain the source of truth.

Rejected alternatives: a fully precomputed feed table for every viewer (too much write amplification for MVP scale) and pure query-time assembly with no projection at all (too expensive per read at the approved ~10k user / 1k concurrent target). Revisit if load testing shows either bound is wrong.

### 4. Search persistence strategy

MVP search uses **PostgreSQL full-text search** (`tsvector`/GIN) over a `search.documents` projection (`database.md` §14, `architecture.md` §18), populated asynchronously from approved source changes and re-checked against source visibility/blocks/moderation at read time.

A dedicated search engine (e.g. Elasticsearch/OpenSearch) is explicitly deferred until measured relevance, language-coverage, or latency evidence justifies the added operational surface — not introduced speculatively.

### 5. Message retention window

Messages follow the **same retention window as general content deletion under ADR-001**: once a message is deleted (by the sender, a moderation action, or as part of account deletion), it is retained up to **90 days** for moderation, abuse investigation, and recovery purposes, then permanently deleted or irreversibly anonymized. There is no separate, longer-lived messaging-specific retention tier for MVP — messaging does not get bespoke treatment beyond what ADR-001 already established for content generally.

This resolves the `messaging.messages` deletion behavior referenced in `database.md` §9/§20: `deleted_at` marks a message hidden immediately from participants; the underlying row (or an anonymized tombstone, implementation's choice) is purged after the 90-day window. Moderation evidence captured before deletion follows the separate moderation/audit retention rule in ADR-001, unaffected by this window.

### 6. Reaction cardinality

A user may hold **exactly one active reaction per post, of a single reaction type at a time** — not multiple simultaneous reaction types on the same post. Selecting a new reaction type replaces the existing one rather than adding a second row.

- Enforced with a unique constraint on `(user_id, post_id)` in `content.post_reactions` (not `(user_id, post_id, reaction_type)` — the earlier conditional wording in `database.md` §6 is now settled in favor of the single-type constraint).
- The same cardinality rule applies to `content.comment_reactions` via `(user_id, comment_id)`.
- Cardinality is settled here. The reaction **type taxonomy** itself is resolved separately in §7a below.

### 7. Reference-data seed content

Initial seed rows for `reference.countries` and `reference.interests` (added in `database.md` §5), and the language posture for MVP, are approved as placeholder/starter content — editable later without any schema change, since these are plain reference-table rows:

- **Countries:** Nigeria (primary launch market, `is_active = true`) plus a small starter set of other African countries spanning multiple regions so cross-border discovery has something to discover against at launch: Ghana, Kenya, South Africa, Egypt, Ethiopia, and Senegal. All seeded as `is_active = true`; additional countries are added as rows later with no migration required.
- **Languages:** English only for MVP. Given exactly one language is supported at launch, a dedicated `reference.languages` table is unnecessary abstraction for now — `language_code`/`language_preferences` fields (`database.md` §5/§6) are validated at the application layer against a single allowed value (`en`). Revisit a proper reference table only when a second language is actually approved, per `CLAUDE.md`'s guidance against designing for hypothetical future requirements.
- **Interests:** an 18-item starter taxonomy in `reference.interests`, chosen for general relevance to an Africa-first social platform rather than as a final content decision: Music, Sports, Fashion & Style, Food & Cooking, Technology, Business & Entrepreneurship, Film & TV, Arts & Culture, Travel, Education, Health & Wellness, Gaming, Politics & Current Affairs, Religion & Spirituality, Comedy & Entertainment, Photography, Literature & Books, Agriculture. All seeded `is_active = true` with a stable `slug`; the list is expected to change based on real usage and does not require a migration to do so.

No seed scripts or migration files are created by this ADR — this is content policy for whoever implements the Phase 1 seed job (`database.md` §25), not an implementation artifact itself.

### 8. Reaction type taxonomy

The `reaction_type` value set (distinct from the cardinality rule in §6) is approved as: **Like, Love, Laugh, Support, Insightful** — five types, chosen to cover simple approval (Like), warmth (Love), humor (Laugh), solidarity (Support), and substantive engagement (Insightful) without over-fragmenting a single-choice reaction. Stored as a constrained set (application-level enum or a small `reference.reaction_types` lookup — implementation's choice; either way it is a fixed, short, code-reviewed list, not free text). Like `reference.interests` content, this list can change later without a schema change to `content.post_reactions`/`comment_reactions` themselves, since `reaction_type` is just a value in an existing column.

---

### Architecture consequences

These decisions are reflected in `docs/04-database/database.md` §3 (conventions), §5 (reference schema and seed content), §6 (reaction cardinality and type taxonomy), §7 (feed), §9/§20 (message retention), §14 (search), and the risk table in §24, which previously cited an incorrect ADR-002 justification for the identifier format — corrected to point here.

### Still open (not resolved by this ADR)

- Business identity tables/permissions (organization accounts) — not required for the Phase 1 implementation slice.
- Any country/interest/reaction content beyond the starter seed in §7/§8 remains editable product content, not an architecture question.

---

## ADR-004: API Foundations — Authentication Cookies, CSRF, Cursor Pagination, WebSocket Messaging Boundary

**Status:** Approved — approved by the owner before Phase 1 API implementation began, and implemented since (cookie names/lifetimes, CSRF, cursor pagination and the error contract in `services/api`; the messaging WebSocket boundary per ADR-006). Status line corrected 2026-09-19: it previously still read "Proposed — pending owner approval."
**Date:** 2026-09-15
**Scope:** Concrete decisions the API architecture (`docs/05-api/api.md`) depends on but that no prior document pinned to specifics: web authentication cookie/token parameters, CSRF strategy, refresh rotation/revocation behavior, cursor pagination shape, and the messaging WebSocket boundary now required by the separate frontend team's confirmed transport choices (WebSocket for messaging, REST/polling for notifications).

This ADR does not change ADR-001/002/003, which remain in effect unmodified. It formalizes decisions consistent with `architecture.md` §10 ("short-lived JWT access tokens and rotating refresh tokens... secure HttpOnly/SameSite cookies where web policy selects cookies") and §14 ("REST creates messages; WebSockets deliver accepted events"), which established direction without pinning exact parameters.

---

### 1. Web authentication cookies

Two `HttpOnly` cookies, never readable by JavaScript, never mirrored to `localStorage`/`sessionStorage`:

| Cookie | Name | Path | Lifetime | Contains |
|---|---|---|---|---|
| Access | `afrilink_at` | `/` | 15 minutes | Short-lived JWT access token |
| Refresh | `afrilink_rt` | `/api/v1/auth/refresh` | 30 days | Opaque refresh token (server stores only its hash, per `database.md` §4 `identity.sessions`) |

- `Secure`: `true` in production and staging; `false` only permitted on local HTTP development.
- `SameSite`: `Lax` — blocks the common cross-site POST/PATCH/DELETE CSRF vectors while still allowing normal top-level navigation (e.g., an email verification link landing the user logged in). `Strict` is rejected because it breaks cross-site-initiated navigations AfriLink needs (shared post links opened from other sites/apps while logged in).
- Refresh cookie is scoped to `Path=/api/v1/auth/refresh` specifically — it is never sent on ordinary API requests, narrowing its exposure window to exactly the one endpoint that needs it.
- No `Domain` attribute is set (defaults to the exact host) — no cross-subdomain cookie sharing for MVP.

### 2. CSRF protection

`SameSite=Lax` is the primary defense. Defense-in-depth for state-changing requests (`POST`/`PATCH`/`PUT`/`DELETE`): a third, **non-`HttpOnly`** cookie `afrilink_csrf` (random token, same lifetime as the access token) that the frontend reads and echoes back as an `X-CSRF-Token` request header — the classic double-submit pattern. The server rejects state-changing requests where the header is missing or does not match the cookie. `GET` requests are exempt (must not mutate state per `api.md` §3).

### 3. Refresh rotation and revocation

- Every successful `/auth/refresh` call **rotates**: the presented refresh token is marked `revoked_at` in `identity.sessions`, and a new refresh token (new session row) is issued. The client never reuses a refresh token.
- **Reuse detection:** presenting an already-revoked refresh token is treated as a signal of token theft — the API revokes **all** sessions for that user immediately and returns `401 TOKEN_INVALID`, forcing full re-authentication everywhere.
- **Logout** (`/auth/logout`) revokes only the current session and clears both cookies. **Logout-all** (`/auth/logout-all`) revokes every session for the user.
- **Password change** and any account-security-relevant action (admin-forced suspension, detected compromise) revoke all sessions **except** the one performing the change, consistent with `architecture.md` §10's "revoke all sessions after high-risk credential changes."

### 4. Mobile authentication

Mobile clients cannot use browser cookies. The same `/auth/*` endpoints serve both platforms, distinguished by an explicit client-type signal (e.g., a `X-Client-Type: mobile` request header, decided at implementation time):

- Web clients: tokens delivered as the two `HttpOnly` cookies above, nothing in the response body.
- Mobile clients: tokens delivered in the JSON response body instead; the client stores the access token in memory and the refresh token in OS-protected secure storage (Keychain/Keystore) per `architecture.md` §5 — never in plain app storage, never in a WebView's `localStorage`.

One endpoint set, two token-delivery mechanisms — not a split API.

### 5. Cursor pagination shape

- Cursor is an opaque, base64url-encoded JSON object carrying the last-seen ordering key(s) — typically `{ v: <sortValue>, id: <uuid> }`. Not encrypted or signed for MVP (adds implementation cost without a concrete threat this blocks — a forged cursor at worst produces a `400 INVALID_CURSOR` or an empty/wrong page, never unauthorized data, since every row is still re-checked against authorization at read time per `api.md` §10). Revisit only if abuse evidence justifies it.
- Every cursor-paginated list orders by its primary timestamp **plus `id` as a tie-breaker** (matching the composite indexes already built in `database.md`/`schema.prisma`, e.g., `created_at desc, id desc`) — guarantees stable ordering even when multiple rows share a timestamp.
- Default page size: **20**. Maximum page size: **50** (server clamps, never errors, on an oversized `limit`).
- Only a forward `nextCursor` is supported for MVP — no `previousCursor`. Bidirectional cursor pagination is a future enhancement if a "jump back to top after a gap" UX is ever needed; MVP's infinite-scroll patterns don't require it.
- Deleted/changed rows between page fetches never cause skipped or duplicated rows the way offset pagination can — a structural benefit of cursor pagination worth relying on rather than re-solving.

### 6. Messaging WebSocket boundary

Per the frontend team's confirmed choice (WebSocket for messaging), formalizing the boundary `architecture.md` §14 already sketched:

- **REST is authoritative for writes.** Sending a message is `POST /conversations/{id}/messages` (REST), never a WebSocket write — "WebSockets are not a second write API" (`architecture.md` §14) is unchanged.
- **WebSocket authentication:** the same `afrilink_at` `HttpOnly` cookie used for REST is sent automatically during the WebSocket handshake (it's an HTTP Upgrade request to the same origin), validated before the handshake completes. Mobile clients (no shared cookie jar) authenticate via an initial post-connect auth frame carrying the access token instead of a cookie.
- **Authorization:** each conversation "room"/channel subscription is authorized individually against `messaging.participants` (once that schema exists) at subscribe time, not just at connection time.
- **Connection lifecycle:** connect → authenticate → subscribe to permitted conversation channels → receive events → heartbeat (ping/pong) → on drop, reconnect with exponential backoff, re-authenticate, re-subscribe.
- **Delivery events**, not a write path: `message.accepted`, `message.updated`, `message.deleted`, `conversation.read` — each carries event ID, type, resource ID, version, and server timestamp (`architecture.md` §24, unchanged).
- **Acknowledgement:** delivery/read acknowledgement is a REST call (`POST /conversations/{id}/read`, already in `api.md` §12), not a raw WebSocket ack primitive — keeps the durable read-state in PostgreSQL, not the ephemeral socket.
- **Reconnect/recovery:** on reconnect, missed messages are recovered via the same cursor-paginated `GET /conversations/{id}/messages` REST endpoint, never assumed from the WebSocket stream alone (WS delivery is best-effort/at-most-once for the live channel; REST is the durable source of truth).
- **Failure handling:** a rejected subscription or auth failure emits a typed `error` event (code + message) before the server closes the connection with a specific close code; if WebSocket is unavailable, message *reading* still works via REST polling of the same cursor endpoint (only live push is lost, not functionality).
- **Pagination:** message history pagination is the same cursor convention as §5 above, always via REST — the WebSocket itself never paginates, it only streams new live events.

Messaging is **not** part of Phase 1 database scope — this boundary is a forward contract so the eventual implementation doesn't retrofit badly, not something implementable today (`database.md` §25 lists messaging in the incremental phase after Phase 1).

### 7. Notifications: REST/polling only for MVP

Per the frontend team's confirmed choice, **no WebSocket notification channel for MVP** — `notification.created` is explicitly **not** part of the WebSocket event set in §6 above (an earlier draft of `api.md` had included it; corrected by this ADR). Notifications are fetched via `GET /notifications` (REST, cursor-paginated) and are expected to be polled by the client.

**Future extension point, reserved but not built:** the notification list DTO shape is kept WS-event-compatible on purpose (same fields a future `notification.created` push event would carry), so adding push delivery later is additive — a new WebSocket event emitting the same shape — not a redesign. Nothing is implemented toward this now.

### 8. Error contract: multi-field validation

`api.md` §5's existing error envelope already uses a `details` **array** of `{ field, reason }` objects, not a single `field` string — this was evaluated against the requirement to support multiple simultaneous field errors (e.g., both `email` and `password` invalid in one request) and is confirmed sufficient: each entry in `details` covers one field, and a request with multiple invalid fields simply returns multiple entries. `field` uses dot/bracket path notation for nested or array fields (e.g., `profile.displayName`, `items[0].email`). No redesign needed — this ADR formalizes the existing shape as approved rather than replacing it.

---

### Architecture consequences

These decisions are reflected in `docs/05-api/api.md` §4 (authentication), §5 (error contract), §8 (pagination), §12 (WebSocket boundary), §14 (frontend handoff).

### Still open (not resolved by this ADR)

- Exact mobile client-type detection mechanism (header name/value vs. a distinct auth grant) — an implementation detail, not an architecture blocker.
- Whether a signed/encrypted cursor is ever needed — deferred pending real abuse evidence, not a default requirement.
- Push/email/SMS notification channels remain a separate, already-noted-open product/vendor decision (`architecture.md` §15/Open questions) — unaffected by the REST-only decision here, which concerns only the *in-app* WebSocket-vs-REST transport question.
