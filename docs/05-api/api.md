# AfriLink REST API Design

**Status:** The Phase 1 REST surface (identity, profiles/social graph, content, reference data) and the Messaging REST API + WebSocket gateway are implemented and covered by end-to-end tests; an OpenAPI document is generated from the live controllers (`/api/docs`, `/api/docs-json`, and a CI build artifact). Every endpoint below is marked **[Phase 1]** (implemented) or **[Future contract]** (not implemented — design only). Communities and Notifications now have database schemas (Database Phase 2) but no REST API yet; Feed, Media, Moderation, Admin/Audit and Search are still blocked on their database modules (see §15). The implemented Messaging routes are listed in §13.
**Date:** 2026-09-13 (original draft); rewritten 2026-09-15 for API Architecture Phase — PRD/architecture/database are now approved and Phase 1 database (`identity`, `reference`, `social`, `content`, `integration` schemas) is implemented, migrated, and seeded. This revision corrects several inaccuracies the original draft had relative to the actual schema (see §16 database-consistency findings) and incorporates frontend-team transport decisions (§12). Patched 2026-09-19 to reflect that the Phase 1 REST surface and the Messaging REST/WebSocket surface are implemented, and that the Communities and Notifications database layers now exist (their APIs do not yet).
**Base path:** `/api/v1`
**Format:** JSON over HTTPS; WebSocket gateway for real-time messaging delivery (messaging only — implemented, see §13 and `docs/05-api/messaging-websocket.md`)

> REST, OpenAPI, WebSockets, JWT access/refresh tokens, and the modular-monolith constraint are defined in `CLAUDE.md`. Endpoint scope reflects the approved `docs/01-product/PRD.md` and the actually-implemented Phase 1 database (`database/schema.prisma`, `docs/04-database/database.md`). New decisions this revision depends on (cookie/token specifics, CSRF, cursor pagination shape, WebSocket messaging boundary) are formalized in ADR-004 (`docs/10-decisions/decisions.md`), approved by the owner and implemented (status corrected 2026-09-19).

## 1. API architecture overview

The API is one versioned REST contract shared by the web client (built by a separate frontend team) and the future mobile client, sitting in front of the NestJS modular monolith. REST is authoritative for all durable state; a WebSocket gateway exists only as a future delivery channel for messaging (§12) — never a second write path.

```mermaid
flowchart LR
	Client[Web client (separate frontend team) / future mobile] --> Edge[CDN/WAF/TLS]
	Edge --> REST[REST API /api/v1]
	Edge -.future.-> WS[WebSocket gateway - messaging only]
	REST --> Modules[NestJS modular monolith]
	WS -.future.-> Modules
	Modules --> DB[(PostgreSQL - Phase 1 schemas)]
	Modules --> Queue[Outbox - integration.outbox_events]
```

| API area | Owning module | Backing schema | Status |
|---|---|---|---|
| Authentication and account | Identity & Access | `identity` | **[Phase 1]** |
| Profiles, country, interests | Profiles | `social`, `reference` | **[Phase 1]** |
| Friendships, follows, blocks | Social graph | `social` | **[Phase 1]** |
| Posts, comments, reactions, shares | Content | `content` | **[Phase 1]** (text-only — see §16) |
| Home/community feeds | Feed | `feed` (does not exist yet) | **[Future contract]** |
| Communities | Communities | `community` (database implemented; no REST API yet) | **[Future contract]** — API not implemented |
| Messaging | Messaging | `messaging` | **[Implemented]** — REST + WebSocket gateway (§13, ADR-006) |
| Notifications | Notifications | `notification` (database implemented; no REST API yet) | **[Future contract]** — REST/polling only, decided (§13); API not implemented |
| Media | Media | `media` (does not exist yet) | **[Future contract]** |
| Moderation | Moderation | `moderation` (does not exist yet) | **[Future contract]** |
| Admin | Admin & Audit | `admin`, `audit` (do not exist yet) | **[Future contract]** |
| Search | Search | `search` (does not exist yet) | **[Future contract]** |

Controllers call application services only; no controller queries another module's tables directly.

## 2. API principles

- Resource-oriented, predictable, one stable contract for every client.
- Secure by default — authorization enforced server-side; frontend route guards are UX only, never a security boundary.
- Efficient on low-bandwidth connections; cursor pagination everywhere a list can grow unbounded.
- Safe to retry — idempotency keys on retry-prone mutations (§10).
- Explicit about visibility, account state, and what does not exist vs. what the caller cannot see.
- Independently evolvable through additive, versioned changes (§3).
- Never expose what the database doesn't actually support yet — every endpoint below is honest about its backing schema.

## 3. API versioning

Confirmed as already decided in `architecture.md` §9: `/api/v1`, no new decision needed here.

- Additive fields/endpoints are preferred within a version; clients must ignore unknown response fields.
- A breaking change requires a new major path (`/api/v2`) or an explicitly approved compatibility shim — never a silent behavior change under `/api/v1`.
- Deprecations require documentation, telemetry on old-path usage, a migration period, and direct communication to the frontend team before removal.
- Database migrations use expand-and-contract (`database.md` §23) specifically so old and new API versions can coexist during a deploy.

## 4. Authentication

Concrete parameters formalized in ADR-004 §1–4 (`docs/10-decisions/decisions.md`), Proposed pending approval; summarized here.

### Web: HttpOnly cookies, never localStorage

Two `HttpOnly` cookies — never readable by JavaScript, never mirrored to browser storage:

| Cookie | Name | Path | Lifetime |
|---|---|---|---|
| Access | `afrilink_at` | `/` | 15 minutes |
| Refresh | `afrilink_rt` | `/api/v1/auth/refresh` (scoped — never sent on ordinary requests) | 30 days |

`Secure=true` in production/staging (HTTP-only local dev is the sole exception). `SameSite=Lax` — blocks cross-site state-changing CSRF while still allowing normal top-level navigation (e.g., a shared post link opening while logged in). No `Domain` attribute (exact host only).

**CSRF:** `SameSite=Lax` is the primary defense; a non-`HttpOnly` `afrilink_csrf` cookie plus a required `X-CSRF-Token` header (double-submit pattern) is defense-in-depth for every `POST`/`PATCH`/`PUT`/`DELETE`. `GET` is exempt.

**Refresh rotation:** every `/auth/refresh` call revokes the presented refresh token and issues a new one. Presenting an already-revoked refresh token is treated as theft — all sessions for that user are revoked immediately, forcing full re-login everywhere.

**401/refresh flow (what the frontend does):** on any `401 TOKEN_EXPIRED`, the frontend calls `/auth/refresh` once; if that also fails, it redirects to login. This is the frontend's own stated responsibility — the API's job is to make `401` vs. other `4xx` unambiguous (see §5) so the frontend never has to guess whether to retry-with-refresh or show an error.

**Logout:** `/auth/logout` revokes the current session and clears both cookies. `/auth/logout-all` revokes every session.

**Password change / account-security events:** revoke all sessions except the one performing the change (matches `architecture.md` §10).

### Mobile

No browser, so no cookies. Same `/auth/*` endpoints, distinguished by an explicit client-type signal (exact mechanism — e.g. `X-Client-Type: mobile` — an implementation detail, not an architecture blocker): tokens are returned in the JSON body instead of cookies; the client stores the access token in memory and the refresh token in OS-protected secure storage (Keychain/Keystore), never in a WebView's `localStorage` or plain app storage. One endpoint set, two delivery mechanisms.

### Auth endpoints **[Phase 1]**

| Method | Endpoint | Purpose | Auth |
|---|---|---|---|
| `POST` | `/auth/register` | Create an account | Public, rate-limited |
| `POST` | `/auth/login` | Authenticate with approved credential | Public, rate-limited |
| `POST` | `/auth/refresh` | Rotate a refresh token | Refresh cookie/token |
| `POST` | `/auth/logout` | Revoke current session | Authenticated |
| `POST` | `/auth/logout-all` | Revoke all sessions | Authenticated |
| `POST` | `/auth/verify` | Consume email/phone verification challenge | Public/session-bound |
| `POST` | `/auth/verification-challenges` | Request a verification challenge | Public/session-bound, rate-limited |
| `POST` | `/auth/password/forgot` | Start recovery | Public, rate-limited |
| `POST` | `/auth/password/reset` | Complete recovery | Challenge-bound |
| `GET` | `/auth/sessions` | List active sessions (device/label from `identity.sessions`) | Authenticated |
| `DELETE` | `/auth/sessions/{sessionId}` | Revoke one session | Authenticated |

Maps directly to `identity.users`, `identity.credentials`, `identity.sessions`, `identity.verification_challenges` — all present in Phase 1.

## 5. Authorization

Every use case evaluates, in order: (1) authentication and account status (`identity.users.status`), (2) resource ownership or permitted relationship, (3) profile/content visibility, (4) block state (`social.blocks`), (5) moderation sanctions — **not yet enforceable in Phase 1**, since `moderation` schema doesn't exist (see §16), (6) scoped role — **not applicable yet**, no community/platform-role consumer exists in Phase 1 beyond the `identity.roles`/`user_roles` tables themselves, (7) field-level disclosure.

Frontend route guards are UX only; every API request re-checks authorization server-side regardless of what the client already knows.

## 6. Error model

```json
{
	"error": {
		"code": "VALIDATION_FAILED",
		"message": "The request could not be accepted.",
		"details": [
			{ "field": "email", "reason": "invalid_format" },
			{ "field": "profile.displayName", "reason": "too_long" }
		],
		"requestId": "req_..."
	}
}
```

**Critically evaluated per the frontend team's requirement** (ADR-004 §8): a single `field` string cannot represent two simultaneously invalid fields in one request (e.g., both `email` and `password` at once), or a nested/array field path. The shape above already solves this — `details` is an **array**, one entry per field, and `field` uses dot/bracket path notation (`profile.displayName`, `items[0].email`) for nesting. This is not a new design, it's confirming the existing shape is sufficient and formalizing it as approved rather than replacing it.

| HTTP status | Typical codes | Meaning |
|---:|---|---|
| `400` | `INVALID_REQUEST`, `INVALID_CURSOR` | Malformed or semantically invalid request |
| `401` | `AUTHENTICATION_REQUIRED`, `TOKEN_INVALID`, `TOKEN_EXPIRED` | Missing or invalid authentication — triggers the frontend's refresh flow |
| `403` | `FORBIDDEN`, `ACCOUNT_RESTRICTED` | Authenticated but not permitted |
| `404` | `RESOURCE_NOT_FOUND` | Does not exist, or intentionally undiscoverable (blocked/private) |
| `409` | `CONFLICT`, `DUPLICATE_ACTION`, `IDEMPOTENCY_CONFLICT` | Current state conflicts with the command |
| `413` | `PAYLOAD_TOO_LARGE` | Body exceeds policy |
| `422` | `VALIDATION_FAILED`, `POLICY_REJECTED` | Well-formed request, rejected by domain rules |
| `429` | `RATE_LIMITED` | Retry later per `Retry-After` |
| `500` | `INTERNAL_ERROR` | Unexpected; details never exposed |
| `503` | `DEPENDENCY_UNAVAILABLE` | Temporary dependency outage |

Never reveal whether an account/email/phone/private profile exists when that would aid enumeration (§13).

## 7. Response envelope

```json
{
	"data": { "id": "01J...", "type": "profile", "attributes": {}, "relationships": {} },
	"meta": { "requestId": "req_..." }
}
```

Collections:

```json
{
	"data": [],
	"meta": { "requestId": "req_...", "page": { "nextCursor": "opaque-cursor", "hasMore": true } }
}
```

Never serialize ORM entities directly; explicit response DTOs only. Omit unauthorized fields rather than nulling them. Timestamps are RFC 3339 UTC. Counts are labeled as derived/eventually-consistent where applicable (e.g., reaction/comment counts).

## 8. Phase 1 REST resources

### Profiles, country, interests

| Method | Endpoint | Purpose | Backing |
|---|---|---|---|
| `GET` | `/me` | Authenticated user's account summary | `identity.users` |
| `PATCH` | `/me` | Update allowed account fields | `identity.users` |
| `DELETE` | `/me` | Request account deletion | `identity.users.status` → `pending_deletion` |
| `GET` | `/profiles/{userIdOrHandle}` | Read a visibility-filtered profile | `social.profiles` |
| `PATCH` | `/me/profile` | Update the current profile | `social.profiles` |
| `GET` | `/me/preferences` | Read preferences | `social.user_preferences` |
| `PATCH` | `/me/preferences` | Update privacy/discovery/notification defaults | `social.user_preferences` |
| `GET` | `/countries` | List active countries for signup/profile forms | `reference.countries` — public, no auth |
| `GET` | `/interests` | List active interests | `reference.interests` — public, no auth |
| `GET` | `/me/interests` | List the caller's selected interests | `social.user_interests` |
| `PUT` | `/me/interests` | Replace the full interest selection (`{"interestIds": [...]}`) | `social.user_interests` |

`PATCH /me/profile` accepted fields: `displayName`, `bio`, `countryCode` (must match an active `reference.countries.code`), `region`, `websiteUrl`, `visibility`. **`avatarMediaId` is deliberately not accepted yet** — see §16 finding 1.

### Social graph — follows, friendships, blocks

| Method | Endpoint | Purpose | Backing |
|---|---|---|---|
| `POST` | `/users/{userId}/follow` | Follow a user (idempotency-key safe) | `social.follows` |
| `DELETE` | `/users/{userId}/follow` | Unfollow | `social.follows` |
| `GET` | `/users/{userId}/followers` | List permitted followers | `social.follows` |
| `GET` | `/users/{userId}/following` | List permitted followees | `social.follows` |
| `POST` | `/users/{userId}/friend-requests` | Send a friend request | `social.friendships` (`status=pending`) |
| `GET` | `/me/friend-requests?direction=incoming\|outgoing` | List pending requests | `social.friendships` |
| `POST` | `/friend-requests/{friendshipId}/accept` | Accept | `social.friendships` (`status=accepted`) |
| `POST` | `/friend-requests/{friendshipId}/decline` | Decline | `social.friendships` (`status=declined`) |
| `DELETE` | `/friend-requests/{friendshipId}` | Cancel a request the caller sent | `social.friendships` |
| `DELETE` | `/friendships/{friendshipId}` | End an accepted friendship | `social.friendships` (`status=removed`) |
| `GET` | `/users/{userId}/friends` | List permitted friends (private-by-default per ADR-002 §4) | `social.friendships` |
| `GET` | `/users/{userId}/relationship` | Combined state: following/followedBy/friendshipStatus/blocked/blockedBy | `social.follows`+`friendships`+`blocks` |
| `POST` | `/users/{userId}/block` | Block a user | `social.blocks` |
| `DELETE` | `/users/{userId}/block` | Remove a block | `social.blocks` |
| `GET` | `/me/blocks` | List current blocks | `social.blocks` |

**Friendships were missing from the original draft entirely** despite `social.friendships` being fully implemented in Phase 1 — added here (§16 finding 2). Block mutations must trigger suppression of the blocked party across profile reads, content visibility, and future feed/messaging (once those exist).

### Posts, comments, reactions, shares

| Method | Endpoint | Purpose | Backing |
|---|---|---|---|
| `POST` | `/posts` | Create a post | `content.posts` |
| `GET` | `/posts/{postId}` | Read an authorized post | `content.posts` |
| `PATCH` | `/posts/{postId}` | Edit an owned post | `content.posts` |
| `DELETE` | `/posts/{postId}` | Soft-delete an owned post | `content.posts.deleted_at` |
| `GET` | `/users/{userId}/posts` | List a user's visible posts (cursor) | `content.posts` |
| `POST` | `/posts/{postId}/comments` | Add a comment or reply | `content.comments` |
| `GET` | `/posts/{postId}/comments` | List top-level comments (cursor) | `content.comments` |
| `GET` | `/comments/{commentId}/replies` | List replies to a comment (cursor) | `content.comments.parent_comment_id` |
| `PATCH` | `/comments/{commentId}` | Edit an owned comment | `content.comments` |
| `DELETE` | `/comments/{commentId}` | Delete an owned comment | `content.comments.deleted_at` |
| `PUT` | `/posts/{postId}/reaction` | Set the caller's reaction | `content.post_reactions` |
| `DELETE` | `/posts/{postId}/reaction` | Remove the caller's reaction | `content.post_reactions` |
| `PUT` | `/comments/{commentId}/reaction` | Set a comment reaction | `content.comment_reactions` |
| `DELETE` | `/comments/{commentId}/reaction` | Remove a comment reaction | `content.comment_reactions` |
| `POST` | `/posts/{postId}/shares` | Share a post (`{"comment": "optional"}`) | `content.shares` |
| `DELETE` | `/shares/{shareId}` | Remove the caller's own share | `content.shares.deleted_at` |
| `GET` | `/users/{userId}/shares` | List a user's shares (cursor) | `content.shares` |

Create-post request body, **corrected from the original draft** (§16 finding 3 — no media attachment or community assignment is possible in Phase 1):

```json
{
	"body": "Post text",
	"visibility": "followers",
	"language": "en"
}
```

`visibility` is one of `public | followers | private` for Phase 1 (`community_members`/`mentioned_users` are valid at the database CHECK-constraint level per `database.md` §6 but are not selectable yet — no community/mention module exists to make them meaningful; rejecting them at the API layer with `422 POLICY_REJECTED` until then).

Reaction request body reflects the approved five-type taxonomy (ADR-003 §8) — no free text:

```json
{ "type": "like" }
```
`type` ∈ `like | love | laugh | support | insightful`.

Comment creation supports threaded replies:

```json
{ "body": "Reply text", "parentCommentId": "01J..." }
```

`GET /posts/{postId}/comments` returns only top-level comments (`parentCommentId=null`); reply threads are fetched per-comment via `/comments/{commentId}/replies`, matching the `comments_parent_comment_id_created_at_id_idx` index built for exactly this access pattern.

## 9. Pagination

Formalized in ADR-004 §5. All Phase 1 list endpoints above use cursor pagination:

- Cursor: opaque, base64url-encoded, carries the last-seen `(sortValue, id)`. Not signed/encrypted for MVP — a forged cursor produces a bad/empty page or `400 INVALID_CURSOR`, never unauthorized data, since authorization is re-checked at read time regardless of cursor content.
- Ordering: primary timestamp **plus `id` as tie-breaker**, matching the composite indexes already built (e.g., `posts_author_id_created_at_id_idx` — `created_at desc, id desc`).
- Default page size **20**, maximum **50** — server clamps an oversized `limit`, never errors.
- Only forward `nextCursor` for MVP; no `previousCursor`.
- Deleted/changed rows between fetches don't cause skipped/duplicated rows — a structural benefit of cursor over offset pagination.

### Offset pagination — admin only, not yet applicable

Reserved for admin tables/dashboards per the frontend team's direction. **No admin endpoints exist in Phase 1** (`admin`/`audit` schemas aren't implemented — §15), so this has no concrete surface yet; documented here only so a future admin API doesn't need a new pagination decision.

## 10. Filtering and sorting

Per-endpoint allowlists only — never pass client-supplied sort/filter fields directly into a query. Phase 1 filters: `GET /users/{userId}/posts` and `/profiles` support no filters beyond pagination for MVP (keeps the resource-vs-CRUD line from §2 clean — add filters only when a real product need appears, not speculatively).

## 11. Rate limiting strategy

Layered by IP, account, and device. Concrete MVP limits (illustrative starting points, tunable at implementation time — the architecture-level decision is *that* these are limited and *roughly how strictly*, not exact production tuning):

| Operation | Suggested limit |
|---|---|
| Registration | 5 / hour / IP |
| Login | 10 / 15 min / IP, 5 / 15 min / account |
| Password reset request | 3 / hour / account |
| Verification challenge request | 5 / hour / account |
| Friend request send | 30 / hour / account |
| Follow | 100 / hour / account |
| Post creation | 20 / hour / account |
| Comments | 60 / hour / account |
| Reactions | 300 / hour / account (cheap action, higher ceiling) |
| Shares | 30 / hour / account |
| Search *(future — no search module in Phase 1)* | 60 / hour / account |

`429 RATE_LIMITED` with `Retry-After`. Counters live in Redis; durable security/abuse events remain in PostgreSQL per `architecture.md` §22.

## 12. Idempotency

Require `Idempotency-Key` for: registration, follow/unfollow, friend-request send/accept/decline, post/comment/share creation, password-reset requests. Stored in `integration.idempotency_keys` (owner, key, command type, request fingerprint, status, safe response reference — already implemented in Phase 1). Reusing a key with a *different* request body returns `409 IDEMPOTENCY_CONFLICT`.

**Reactions are a special case, not idempotency-key-based:** `PUT .../reaction` is naturally idempotent by HTTP semantics and by the database design itself — `content.post_reactions`/`comment_reactions` enforce exactly one row per `(user, target)` (ADR-003 §6), so repeating the same `PUT` just re-sets the same state. No idempotency key needed there; adding one would be unnecessary mechanism per §12's own "do not add unnecessary idempotency" instruction.

## 13. WebSocket boundary (messaging — implemented)

Full detail in ADR-004 §6, ADR-006 and `docs/05-api/messaging-websocket.md`. Summary:

- **REST is authoritative for writes** — sending a message is always `POST /conversations/{id}/messages`, never a WebSocket write.
- **Auth:** same `afrilink_at` HttpOnly cookie, sent automatically on the WS handshake (same-origin Upgrade request) and verified by connection middleware before the connection completes; mobile passes the access token in the Socket.IO handshake `auth` payload (`accessToken`) — never in the URL or query string.
- **Authorization:** per-conversation subscription check against `messaging.participants`, not just connection-level auth.
- **Lifecycle:** connect → authenticate → subscribe → receive → heartbeat → reconnect-with-backoff on drop, re-authenticate, re-subscribe.
- **Events:** `message.accepted`, `message.updated`, `message.deleted`, `conversation.read`, `conversation.updated` — emitted only after the corresponding REST write commits. Payloads carry the affected resource; the event ID/version envelope described in `architecture.md` §24 is not implemented yet. Client → server events are subscription management only: `conversation.join`, `conversation.leave` (namespace `/messaging`, rooms `conversation:{id}`).
- **Acknowledgement:** via REST (`POST /conversations/{id}/read`), not a raw WS ack.
- **Reconnect/recovery:** missed messages recovered via the same cursor-paginated REST endpoint (§9) — WS is best-effort for the live stream, REST is durable truth.
- **Failure handling:** an unauthenticated or invalid-token connection is rejected at the handshake (`connect_error` with message `AUTHENTICATION_REQUIRED` or `TOKEN_INVALID`) before any event is accepted; a rejected `conversation.join` returns an acknowledgement `{ ok: false, error: { code, message } }` and leaves the connection open; if WebSocket is unavailable, reading still works via REST polling.
- **Pagination:** message history uses the same cursor convention (§9), always over REST.

**Notifications explicitly do NOT use WebSocket for MVP** — REST/polling only (`GET /notifications`, cursor-paginated, §15). The notification DTO shape is kept WS-event-compatible so a future push channel is additive, not a redesign — nothing built toward it now, and it is deliberately excluded from the WebSocket event list above (an earlier draft of this document had incorrectly included `notification.created` in the WS event set; ADR-004 §7 corrects that).

**Implementation status:** Messaging (REST + WebSocket gateway) is implemented; some designed WebSocket safeguards (token-expiry re-check, disconnect on logout, live block eviction, Origin check) are not yet built — see `docs/05-api/messaging-websocket.md` §14. Notifications have a database schema but no REST API yet.

**Implemented Messaging REST routes** (all authenticated; state-changing routes also require the CSRF header, §4; errors and cursor pagination follow §6/§9):

| Method | Path | Behavior |
|---|---|---|
| `POST` | `/conversations` | Start a direct conversation with `recipientUserId`. Idempotent per pair (returns the existing conversation). Starts `accepted` if the two users are accepted friends, otherwise `pending` (a message request). Rejects self and blocked users. |
| `GET` | `/conversations` | List the caller's conversations, cursor-paginated, most recent message first (`last_message_at` descending, `id` descending as tie-breaker). Conversations with no messages yet come last, newest-created first. The cursor is opaque and specific to this ordering: cursors issued before this change (`created_at`-based) are rejected with `400 INVALID_CURSOR`; clients restart from the first page. |
| `GET` | `/conversations/{id}` | One conversation (participants only; `404` otherwise). |
| `POST` | `/conversations/{id}/accept` | The recipient accepts a `pending` request. |
| `POST` | `/conversations/{id}/decline` | The recipient declines a `pending` request (`declined`; sending is then rejected). |
| `POST` | `/conversations/{id}/messages` | Send `{ body, clientMessageId }`; idempotent on `clientMessageId`. While `pending`, only the initiator may send. |
| `GET` | `/conversations/{id}/messages` | Message history, newest first, cursor-paginated. |
| `PATCH` | `/messages/{id}` | Edit the caller's own message (sets `editedAt`). The caller must still have access to the conversation (an active participant, not blocked in either direction, conversation not deleted); otherwise `404`, indistinguishable from a nonexistent message. |
| `DELETE` | `/messages/{id}` | Soft-delete the caller's own message, under the same access rule as edit (`404` if the caller no longer has access to the conversation). |
| `POST` | `/conversations/{id}/read` | Advance the caller's read cursor with `{ messageId }`. |

Request/response schemas are in the generated OpenAPI document.

## 14. Frontend handoff

Written for the separate frontend team building against this contract.

- **Base URL:** environment-specific; always call the relative path `/api/v1/...`.
- **API version:** `/api/v1` for the entire Phase 1 surface — no version negotiation needed yet.
- **Auth flow:** `POST /auth/login` sets the two `HttpOnly` cookies (web) or returns tokens in the body (mobile, via client-type header) — nothing for the frontend to store manually on web.
- **401/refresh flow:** on `401 TOKEN_EXPIRED`, call `POST /auth/refresh` once; if that also fails, redirect to login. Do not attempt to read or inspect the access token — it's `HttpOnly` by design.
- **CSRF:** read the `afrilink_csrf` cookie value and send it as `X-CSRF-Token` on every `POST`/`PATCH`/`PUT`/`DELETE`.
- **Canonical error format:** always `{ "error": { "code", "message", "details"?, "requestId" } }` (§6). Map `details[].field` directly to form fields; a field can appear at most once per response but a response can carry many field entries.
- **Pagination:** always `{ "data": [...], "meta": { "page": { "nextCursor", "hasMore" } } }`. Pass `nextCursor` back as the `cursor` query param for the next page; stop when `hasMore` is `false`. Never construct your own cursor.
- **Loading/empty/error states:** an empty collection is `data: [], hasMore: false` — not an error. A `404` on a single resource means "does not exist or you can't see it" (never disambiguated, by design — §13). A `403` means it exists but you're not permitted.
- **Optimistic operations:** safe to optimistically apply follow/reaction/share toggles client-side (server enforces the real state regardless); post/comment creation should wait for the server response before showing as permanent, since content passes validation/policy checks that can reject it.
- **Idempotency:** attach `Idempotency-Key` (any client-generated UUID) on retryable mutations listed in §12 before retrying a timed-out request — never retry those without one, to avoid duplicate posts/friend-requests/etc.
- **WebSocket (messaging only):** available now on the `/messaging` namespace. On web, connection auth reuses your existing session cookie automatically — no separate token handling; mobile passes the access token in the Socket.IO handshake `auth` payload.

## 15. Phase 2 API contracts (implemented and future)

Communities, Messaging and Notifications now have backing database schemas (Database Phase 2); Feed, Media, Moderation, Admin and Search do not (verified against `database/schema.prisma`). Only Messaging has an implemented API. Every other row is a forward contract boundary, not implemented.

| Module | Planned transport | Primary resources | Auth/authz | Pagination | DB Phase 2 dependency | Status |
|---|---|---|---|---|---|---|
| Feed | REST | `/feed`, `/communities/{id}/feed` | Authenticated; visibility+block+moderation filtering at read time | Cursor (§9 convention) | `feed.entries` and ranking metadata — does not exist | **Future contract only.** Preserves the approved ranking concept (relationship + relevance + recency + basic engagement, `architecture.md` §13) as the design target once buildable. |
| Communities | REST | `/communities`, memberships, invitations | Scoped community roles, separate from platform roles | Cursor for members/posts | `community.*` — database implemented; no API yet | **Future contract only.** |
| Messaging | WebSocket (delivery) + REST (writes/history) | `/conversations`, `/conversations/{id}/messages` | Per-conversation participant check | Cursor (§9); WS is not paginated | `messaging.*` — implemented | **Implemented** (§13, ADR-006). |
| Notifications | REST/polling only (no WS for MVP) | `/notifications`, `/notification-preferences` | Authenticated, recipient-only | Cursor (§9) | `notification.*` — database implemented; no API yet | **Future contract only.** Transport decision (REST, not WS) is final for MVP per frontend team (§13/ADR-004 §7). |
| Media | REST (signed upload flow) | `/media/uploads`, `/media/{id}` | Owner-authorized | N/A (single-resource reads) | `media.*` — does not exist. Note: `social.profiles.avatar_media_id` and would-be `content.post_media` exist only as unvalidated/absent columns — see §16 finding 1 | **Future contract only.** |
| Moderation | REST | `/reports`, `/moderation/cases`, appeals | User-facing (own reports) vs. scoped moderator/admin | Cursor for queues | `moderation.*` — does not exist | **Future contract only.** |
| Admin | REST | `/admin/*` | Platform role + MFA + audit | Offset (§9) | `admin.*`, `audit.*` — do not exist | **Future contract only.** |
| Search | REST | `/search`, `/search/{type}` | Authenticated; re-checks source visibility per result | Cursor (§9) | `search.*` projection — does not exist | **Future contract only.** |

## 16. Database consistency findings

Checked every Phase 1 endpoint above against the actual, applied `database/schema.prisma` (not just `database.md`'s design prose) — three real corrections were needed relative to the original (pre-implementation) draft of this document:

1. **`social.profiles.avatar_media_id` exists but is unusable safely today.** It's a bare nullable UUID column with **no foreign key** (deliberately — `media` schema doesn't exist yet, per `schema.prisma`'s own header comment). Nothing validates that a client-supplied UUID corresponds to a real, owned, ready, approved asset. Accepting it on `PATCH /me/profile` today would let a client set an arbitrary, meaningless UUID with no way to serve or verify it. **Decision: `avatarMediaId` is not an accepted field on any Phase 1 endpoint.** Dependency: the Media module (§15) must exist first.
2. **Friendships were entirely absent from the original endpoint list**, despite `social.friendships` being fully implemented (pending/accepted/declined/removed lifecycle, unordered-pair uniqueness, self-request prevention — `database.md` §5, ADR-002 §4). Added the full friend-request/accept/decline/cancel/remove/list surface in §8.
3. **Post creation previously accepted `mediaIds` and `communityId`**, but `content.post_media`/`comment_media` join tables don't exist in Phase 1 at all, and `content.posts.community_id` had no foreign key in Phase 1 (the foreign key to `community.communities` was added in Database Phase 2, but the Communities API does not exist yet). **Decision: Phase 1 posts are text-only; `communityId` is rejected until the Communities module exists.** No schema change proposed — this is a scope correction to the API design, not a database gap to fix.

No missing constraints, ambiguous relationships, or concurrency risks were found for the Phase 1 surface itself — cardinality (one reaction per user per post, unordered-pair friendship uniqueness, self-relationship checks) is already enforced at the database layer (`database.md` §17), so the API layer doesn't need to re-implement those invariants, only surface the resulting `409`/`422` cleanly. One N+1 risk worth flagging for implementation time (not a design blocker): `GET /users/{userId}/relationship` composes three separate checks (follow/friendship/block) — implement as one batched query or three parallel indexed lookups, not three sequential round-trips.

## 17. Security considerations

- TLS everywhere outside local dev; strict CORS (only the known frontend origin(s), credentials-aware since cookies are used).
- CSRF via `SameSite=Lax` + double-submit token (§4) on every state-changing request.
- Validate every body/path/query parameter and content type server-side; never trust client-side validation.
- Resource-level authorization on every request prevents IDOR — ownership/relationship/visibility/block checks happen per-request, not cached from a prior response.
- Generic `404`/`403` responses avoid account, private-profile, and (once it exists) moderation-target enumeration — never reveal *why* something is inaccessible if that itself leaks information (§6).
- Mass-assignment protection: every write endpoint has an explicit accepted-fields allowlist (e.g., `PATCH /me/profile`'s list in §8) — never a generic "update these arbitrary fields" endpoint.
- Media authorization boundary is a **future** concern (§15) — flagged now so it isn't an afterthought: signed URLs, owner checks, and type/size validation must exist before any media endpoint ships, consistent with `architecture.md` §16.
- Redact access tokens, credential material, and any future message/report content from logs and traces.
- WebSocket authentication/authorization (§13) uses the identical session model as REST — no separate, weaker auth path for sockets.
- Auditability: Phase 1 has no `audit` schema yet, so authentication/authorization-failure audit trails are a Database Phase 2 dependency, not something the API can fully deliver today — noted as an open item (§18), not silently skipped.

## 18. Open API decisions

| Decision | Why it matters | Status |
|---|---|---|
| Auth cookie names/lifetimes/CSRF strategy | Security-critical, frontend-visible | **Approved** — ADR-004 §1–4, implemented |
| Cursor pagination shape/page sizes | Every list endpoint depends on it | **Approved** — ADR-004 §5, implemented |
| Messaging WebSocket boundary | Frontend transport requirement (implemented — ADR-006) | **Approved** — ADR-004 §6, implemented (ADR-006) |
| Notifications REST-only for MVP | Frontend-confirmed, corrects an earlier draft inconsistency | **Approved** — ADR-004 §7 |
| Error contract multi-field support | Frontend form-mapping depends on it | **Resolved** — existing `details` array shape confirmed sufficient, ADR-004 §8 |
| Mobile client-type detection mechanism | Needed before mobile auth is implementable | Open — implementation detail, not an architecture blocker |
| Rate-limit exact thresholds (§11) | Tunable without a design change | Open — illustrative starting values given; production tuning deferred |
| Audit trail for auth/authz failures | Security observability | Open — blocked on `audit` schema (Database Phase 2), not an API design gap |
| Communities/Notifications API implementation | Database layers exist; no REST API yet | Open — contracts to be finalized before implementation |
| Feed/Media/Moderation/Admin/Search implementation | All remaining §15 rows | Open — blocked on their Database Phase 2 modules, contracts defined so implementation won't retrofit badly |

## 19. Recommended order after approval

1. ~~Approve ADR-004 (cookies/CSRF, pagination, WebSocket boundary, notifications-REST-only).~~ Done — ADR-004 is approved and implemented.
2. Implement Phase 1 REST surface (§8) against the already-applied database migration — auth first, then profiles/social graph, then content.
3. Implement authorization and error/pagination middleware before feature endpoints (shared infrastructure first).
4. Publish an OpenAPI document generated from reviewed DTOs once controllers exist — not before.
5. Continue Database Phase 2 (media, moderation, audit, feed, search per `database.md` §25 remain; the communities, messaging and notifications database layers are done) in whatever order product priority dictates; each unlocks its corresponding §15 contract without redesigning this document, since the boundaries are already defined.

~~No endpoint implementation should begin until ADR-004 is approved.~~ Satisfied — ADR-004 is approved.
