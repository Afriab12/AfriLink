# AfriLink Messaging WebSocket Architecture

**Status:** DESIGN APPROVED — IMPLEMENTED IN PART. Authentication, room authorization and event broadcasting are built and tested; several safeguards described below are designed but **not yet implemented** — see §14 for the exact state.
**Date:** 2026-09-18 (design); updated 2026-09-19 and 2026-09-20 to record what was actually implemented
**Formalized by:** ADR-006 (`docs/10-decisions/ADR-006-messaging-websocket.md`)
**Builds on, does not redesign:** `architecture.md` §14/§24, `api.md` §12/§13, ADR-004 §6/§7 (`docs/10-decisions/decisions.md`), the applied `messaging` database schema (`database.md` §9, `schema.prisma`)

> The sections below describe the approved design. Where the implementation differs, or a described safeguard is not yet built, the passage is marked *(implemented)*, *(differs from design)* or *(designed — not yet implemented)*, and §14 summarizes the state of every area.

---

## 1. Transport decision

| | A. Socket.IO (`@nestjs/platform-socket.io`) | B. raw `ws` (`@nestjs/platform-ws`) | C. Third-party managed push (Pusher/Ably/Firebase) |
|---|---|---|---|
| NestJS 12 compatibility | ✅ official adapter, `12.0.3`, exact peer match | ✅ official adapter, `12.0.3`, exact peer match | N/A — bypasses NestJS's gateway abstraction entirely |
| Browser support | Built-in fallback negotiation (WS → polling) if a proxy blocks raw WS | Raw `WebSocket` only — no fallback; fails behind WS-hostile proxies/older infra | Vendor client SDK handles this, but adds a vendor SDK to the frontend |
| React Native / mobile | Official `socket.io-client` React Native support, widely used in production RN apps | Works via a `WebSocket`-compatible polyfill, but no reconnection/room primitives — must be hand-built | Vendor RN SDK exists but couples the mobile client to that vendor |
| Reconnection | Built-in automatic reconnect with exponential backoff | None — must be hand-rolled | Built-in (vendor-managed) |
| Acknowledgements | Built-in ack callbacks per emitted event | None — must be hand-rolled over raw message framing | Vendor-specific, often present |
| Rooms/channels | Built-in (`socket.join()`/`socket.to()`), exactly what ADR-004 §6's per-conversation subscription model needs | None — must be hand-rolled (track socket↔conversation membership yourself) | Vendor-specific "channels," an external concept to model against |
| Scaling implications | Official `@socket.io/redis-adapter` for multi-instance room broadcast when needed | Would need a hand-rolled pub/sub bridge (e.g. raw Redis pub/sub) for the same result | Vendor handles scaling, but durable state now lives outside PostgreSQL |
| Operational complexity | Low — one more npm package, no new infrastructure at MVP scale | Medium — every feature ADR-004 §6 already committed to (heartbeat, backoff, rooms) has to be built by hand | Low operationally, but adds an external vendor dependency, billing surface, and a second system that can fail independently |
| Dependency cost | 2 small runtime packages (`@nestjs/websockets`, `@nestjs/platform-socket.io`), both official, both bundling/pinning `socket.io@4.8.3` | 2 small runtime packages, both official, bundling `ws@8.21.3` | An external vendor account, SDK, and billing relationship — the heaviest "dependency" of the three |
| Fit for AfriLink MVP | **Best fit** — ADR-004 §6 already describes Socket.IO's feature set (heartbeat, backoff reconnect, rooms) as the approved connection model; adopting Socket.IO means implementing that contract directly instead of re-deriving it from primitives | Would work, but re-implements functionality Socket.IO already provides, for no stated benefit | Rejected — violates the architecture's vendor-neutrality principle (`architecture.md` §2: vendor/region selection deliberately deferred, never adopted speculatively) and the "PostgreSQL is authoritative, one deployable backend" principle by handing durable delivery state to a third party |

### Recommendation

**Socket.IO**, via NestJS's official adapter. This is not a new architectural direction — it is the concrete implementation of a connection model (heartbeat, backoff reconnect, per-conversation rooms) ADR-004 §6 already committed to before this document existed. Choosing raw `ws` would mean re-deriving Socket.IO's feature set from scratch with no compensating benefit; choosing a managed vendor would contradict two already-approved architecture principles. No packages installed as part of writing this document.

---

## 2. NestJS 12.0.3 compatibility (verified live, not assumed)

Checked directly against the npm registry immediately before writing this document — not inferred from training data or a prior project's version history (this project's established discipline; earlier phases caught stale assumptions this way for Prisma, PostgreSQL, TypeScript, and `@nestjs/throttler`).

```
@nestjs/websockets        12.0.3   peers: @nestjs/core ^12.0.0, @nestjs/common ^12.0.0,
                                    rxjs ^7.1.0, reflect-metadata ^0.1.12||^0.2.0,
                                    @nestjs/platform-socket.io ^12.0.0
@nestjs/platform-socket.io 12.0.3  peers: @nestjs/common ^12.0.0, @nestjs/websockets ^12.0.0,
                                    rxjs ^7.1.0
                                    bundles: socket.io@4.8.3 (exact)
socket.io-client            4.8.3  matches server version exactly
```

Installed today: `@nestjs/common@12.0.3`, `@nestjs/core@12.0.3`, `rxjs@7.8.2`, `reflect-metadata@0.2.2` — every peer requirement is satisfied exactly, with no NestJS version change and no downgrade of anything currently installed.

**Alternative checked for completeness:** `@nestjs/platform-ws@12.0.3` (same peer shape, bundles `ws@8.21.3` exactly) — equally compatible at the dependency-resolution level; not recommended, per §1's feature-completeness reasoning, not a compatibility concern.

---

## 3. Authentication

The WebSocket handshake is a plain HTTP `Upgrade` request to the same origin — every cookie the browser would send on an ordinary `fetch()` to that origin, it also sends on this request, automatically, with no client-side code needed to "attach" it. This is why cookie-based auth transfers to WebSockets with zero new client-side token handling, exactly as ADR-004 §6 and `api.md` §14 already promise the frontend team.

### Handshake authentication

1. Client calls `io('/messaging', { withCredentials: true })` (or platform equivalent) against the same origin/API host already used for REST.
2. The `Upgrade` request carries the `afrilink_at` cookie automatically (browser). Mobile (no shared cookie jar) passes the access token in Socket.IO's handshake `auth` payload — `io(url, { auth: { accessToken } })` — which is sent as part of the initial handshake, never in a query string or the URL. If both are present, the cookie is used. *(differs from design: the design called for a separate post-connect `connection.authenticate` frame. No such event exists — the handshake `auth` payload is Socket.IO's native mechanism for this, and it means authentication completes before the connection does.)*
3. Authentication runs as **Socket.IO connection middleware** — `server.use(...)`, registered in the gateway's `afterInit` hook. It reads the cookie (with a small hand-written parser, because Socket.IO's handshake bypasses Express's `cookie-parser`) or the handshake `auth` token, and verifies it with the same `JwtService`/`JWT_ACCESS_SECRET` the existing `JwtAuthGuard` uses — no separate secret, no separate verification path. *(implemented)* It is deliberately **not** the `handleConnection` hook: Socket.IO completes the transport handshake, and the client receives `connect`, *before* that hook runs, so rejecting there lets an unauthenticated client briefly appear connected. This was found and fixed during implementation and is covered by a regression test.
4. On success, the verified `{ sub, sid }` payload (identical shape to `AccessTokenPayload`) is attached to the socket's connection context (e.g. `socket.data.user`), exactly mirroring how `JwtAuthGuard` attaches `request.user` today. *(implemented)*
5. On failure, the connection is rejected before any event handler runs (§3 "authentication failure behavior" below) — never silently allowed through with an unauthenticated context.

### Access-token expiration

The access token is short-lived (15 minutes, unchanged) but a WebSocket connection can live far longer than that. Two things happen independently:
- The socket connection itself is **not** torn down the instant the token's `exp` passes — Socket.IO connections aren't re-validated per-millisecond.
- *(designed — not yet implemented)* Every **authorization-sensitive action** (joining a new conversation room) would re-verify the token's current validity at that moment, not just at handshake time. **As built, the token is verified once, when the connection is established.** `conversation.join` re-checks conversation membership and blocks (via `MessagingAccessService`) but not token expiry, so an established socket remains authorized after its 15-minute access token expires, until it disconnects.

### Reconnect after refresh

Refreshing (`POST /api/v1/auth/refresh`) issues a new `afrilink_at` cookie via REST — it does not, and cannot, reach into an already-open WebSocket connection to update anything, because a browser cookie change doesn't propagate to an open connection. The client-side pattern (frontend team's responsibility, not built here): after a successful refresh, proactively disconnect and reconnect the socket so the next handshake picks up the new cookie. This is exactly what Socket.IO's built-in reconnect-with-backoff machinery is for — the client doesn't need bespoke logic beyond "reconnect after refresh," the library handles the retry/backoff mechanics.

### Logout behavior

`POST /api/v1/auth/logout` revokes the current session and clears cookies (unchanged, existing behavior). The WebSocket connection tied to that session must then be forcibly closed server-side — the gateway needs a way to map `sessionId (sid)` → active socket(s) so logout can reach in and disconnect them, rather than leaving a socket alive with a now-revoked session. (This mapping is an implementation detail for the eventual `MessagingGateway`, not designed further here — flagged so it isn't forgotten, not solved now.) *(designed — not yet implemented.)* **As built, nothing links a socket to a session:** logging out does not disconnect an open socket, and it stays authorized until it disconnects. (For comparison, REST honors a revoked session's access token only until it expires — at most 15 minutes — because `JwtAuthGuard` also verifies only the JWT.)

### Revoked-session behavior

Identical to logout's mechanism: refresh-token reuse detection (ADR-004 §3) revokes *all* sessions for a user — every open socket tied to any of those sessions must be disconnected the same way, with a typed `error` event (`SESSION_REVOKED`) sent immediately before the close, so the client can distinguish "you were logged out elsewhere" from a generic network drop. *(designed — not yet implemented; same gap as logout above.)*

### Blocked-user behavior

Blocking is not itself a connection-level event — a blocked user's *existing* socket connection stays open (they can still use the rest of the app), but every conversation-scoped authorization check (room join, and by extension every event scoped to that room) re-verifies via `social.blocks` at the moment of the action, per §10 below. A block that happens while both users are actively connected to the same conversation room results in the blocked party being evicted from that specific room (not disconnected entirely) the next time a room-scoped authorization re-check runs. *(partly implemented.)* The block check runs when a room is joined. **Not implemented:** evicting an already-joined blocked party — sockets already in the room keep receiving broadcasts. New messages are still stopped, because sending is REST and is rejected once either user blocks the other; but editing or deleting an existing message (`PATCH`/`DELETE /messages/{id}`) checks only that the caller is the sender, not conversation membership or blocks, and still broadcasts into the room.

### Authentication failure behavior

Handshake-time failure: the connection is rejected by the connection middleware before it completes, so the client receives Socket.IO's `connect_error` and never a `connect`. The error `message` is `AUTHENTICATION_REQUIRED` (no credential presented) or `TOKEN_INVALID` (unverifiable or expired token — expiry is not distinguished as `TOKEN_EXPIRED`). *(implemented, with regression tests asserting `connect_error` rather than a later failure.)* There is no post-connect grace window, because there is no post-connect auth frame.

### Unauthorized-event behavior

Post-handshake, a request the authenticated user is not permitted to make (e.g. `conversation.join` for a conversation they are not an active participant in) does **not** close the connection. *(differs from design)* The failure is returned in the request's **acknowledgement**, `{ ok: false, error: { code, message } }` (`RESOURCE_NOT_FOUND`, `VALIDATION_FAILED`, `AUTHENTICATION_REQUIRED`), rather than as a separate `error` event. The `error` event is emitted only immediately before the server closes a socket that exceeded the invalid-request threshold (`TOO_MANY_INVALID_REQUESTS`; 20 malformed `conversation.join` requests per connection). Expired or revoked sessions do not close an established connection (see above).

---

## 4. Cookie / cross-origin security

Nothing here weakens or duplicates the existing HTTP cookie model — the WebSocket layer is a second **consumer** of the exact same cookies REST already uses, not a second security model.

- **SameSite:** `Lax`, unchanged (ADR-004 §1) — a WS handshake from the legitimate frontend origin is a "same-site" request in the relevant sense; this isn't weakened for sockets.
- **Secure:** `true` in production/staging, unchanged — WebSocket handshakes happen over `wss://` in any environment where the cookie itself is marked `Secure`, matching the existing REST cookie policy (browsers refuse to send a `Secure` cookie over an insecure `ws://` origin anyway, so this is enforced by the platform, not something to configure separately).
- **Allowed origins:** the WS handshake's `Origin` header is validated against the exact same allow-list `main.ts`'s `app.enableCors({ origin: process.env.FRONTEND_ORIGIN ?? true, credentials: true })` already uses — one origin policy, not two.
- **Credential handling:** `credentials: true` on both the REST CORS config and the Socket.IO CORS config (`cors: { origin: <same allow-list>, credentials: true }`) — required for the cookie to be sent on the handshake at all.
- **WebSocket handshake origin validation:** rejected origins fail the handshake outright (same posture as a rejected CORS preflight today), before any authentication check even runs. *(designed — not yet implemented.)* The gateway sets Socket.IO's `cors` option (same allow-list as REST), but there is no explicit Origin check (`allowRequest`) on the WebSocket upgrade; cross-site protection currently rests on the `SameSite=Lax` cookie policy (ADR-004 §1).
- **Relationship to CSRF:** CSRF (ADR-004 §2) exists specifically to stop a cross-site page from triggering a state-changing *REST* request using the browser's ambient cookies. A WebSocket connection is not itself a state-changing write — per ADR-004 §6 (unchanged by this document), **sending a message is always REST**, so it goes through the exact same `CsrfGuard` double-submit check it already does today. The WS layer therefore does not need its own CSRF mechanism — it inherits the guarantee from the fact that it never performs writes.
- **No token in `localStorage`, no token in a URL/query string, ever** — the mobile handshake `auth` payload (§3) carries the access token inside the Socket.IO handshake, over `wss://` (TLS), the same trust boundary the REST response body already relies on for mobile token delivery (ADR-004 §4) — not a new, weaker channel.

---

## 5. Modular monolith process architecture

**Decision: same NestJS application/process.** CLAUDE.md: "do not introduce microservices unless there is a documented technical reason" — no such reason exists at the approved ~1,000-concurrent-user MVP target (§12). Messaging runs as one more module inside the existing modular monolith, exactly like Auth/Profiles/Social Graph/Content.

```
MessagingModule
├── MessagingController        (REST — future: POST/GET conversations, messages, read receipts)
├── MessagingService           (business logic — used by BOTH the controller and the gateway below)
├── MessagingRepository        (Prisma data access over the already-applied messaging schema)
├── MessagingAccessService     (authorization — mirrors ProfileVisibilityService/PostAccessService's
│                                existing role: single source of truth for "can this user act on
│                                this conversation," reused by both REST and WS, never duplicated)
└── MessagingGateway            (@WebSocketGateway — thin: auth the socket, join/leave rooms,
                                  subscribe to domain events, delegate everything else to
                                  MessagingService/MessagingAccessService)
```

The gateway is deliberately thin — it translates transport events into calls against the same service layer the REST controller calls, and it never re-implements a rule (visibility, block, membership) the REST side already enforces. This directly satisfies "both REST and WebSocket interfaces should use the same application/business logic rather than duplicating rules," using the exact reuse pattern already proven in this codebase (`ProfilesModule` exports `ProfileVisibilityService`, consumed by `SocialGraphModule` and `ContentModule` without re-declaration).

None of these classes exist yet — this is the target shape for whenever implementation is separately authorized.

---

## 6. Socket organization

- **Namespace:** `/messaging` — isolates messaging traffic from any future WS use (none planned for MVP, but namespacing costs nothing and avoids event-name collisions later).
- **Room `conversation:{conversationId}`:** joined only after `MessagingAccessService` confirms the connecting user has an active (`left_at IS NULL`) row in `messaging.participants` for that conversation — the same check the REST history endpoint will perform, not a separate rule.
- **Room `user:{userId}`:** joined automatically on connect (no authorization check needed — a user always may subscribe to their own account-level room). Reserved for **future** cross-device/account-level events (e.g. "you read this conversation on another device"); **no MVP event in §7 uses it yet** — flagged explicitly as a judgment call: included for forward-compatibility (so adding a cross-device-sync event later is additive, matching how the notification DTO shape was kept WS-compatible without building push — ADR-004 §7), not because an approved MVP requirement needs it today. If you'd rather it not exist until a concrete event needs it, that's a one-line removal from this design, not a redesign.

**Join sequence:** `conversation.join` request (§7) → `MessagingAccessService.assertCanAccessConversation(userId, conversationId)` (re-checks active participant row + not blocked by the other participant, via `social.blocks`, same table REST will use) → on success, `socket.join('conversation:' + conversationId)` and an ack; on failure, an acknowledgement `{ ok: false, error }`, no room membership change, connection stays open.

**Leave sequence:** explicit `conversation.leave` request, or automatic on disconnect (Socket.IO tracks room membership per-socket and cleans it up on disconnect without extra code) — leaving a room is never itself a durable action (it does not set `participants.left_at`; that's a REST-only mutation, matching "REST is authoritative for writes").

**Blocked users:** handled entirely through the join-time (and re-checked) authorization call above — a block that lands while a room is already joined evicts the blocked party from that room on the next re-check (§3 "blocked-user behavior"), it does not need a bespoke "kick" event separate from the authorization re-check mechanism. *(partly implemented: the check runs at join time; evicting an already-joined blocked party is not implemented — see §3 and §14.)*

**Deleted/invalid conversations:** a `conversation.join` for a `deletedAt`-set or nonexistent conversation ID fails authorization the same way an unauthorized one does (an acknowledgement error with code `RESOURCE_NOT_FOUND`) — no distinct code path, matching the existing REST convention (`ResourceNotFoundException`) of not distinguishing "doesn't exist" from "you can't see it," to avoid enumeration.

---

## 7. Event contract

Reconciled directly against ADR-004 §6's already-approved names — not reinvented. Two events this task's brief listed as candidates (`message.send`, a client-writable `message.read`) are **excluded**, with the reason stated per-event below, because ADR-004 §6 already forbids exactly what they'd do.

### Client → server

| Event | `conversation.join` |
|---|---|
| Purpose | Subscribe to live events for one conversation |
| Authenticated | Required (§3) |
| Authorization | Active `messaging.participants` row, not blocked — via `MessagingAccessService` (§6) |
| Payload | `{ conversationId: string }` |
| Ack | `{ ok: true }` on success |
| Errors | `AUTHENTICATION_REQUIRED`, `RESOURCE_NOT_FOUND` (not a participant / doesn't exist / blocked — same non-enumerating shape as REST) |
| Idempotency | Naturally idempotent — joining an already-joined room is a no-op |
| Persistence | None — room membership is a transient socket-server fact, not written to PostgreSQL |

| Event | `conversation.leave` |
|---|---|
| Purpose | Unsubscribe from a conversation's live events |
| Authenticated | Required |
| Authorization | None beyond authentication — leaving a room you're not in is a harmless no-op |
| Payload | `{ conversationId: string }` |
| Ack | `{ ok: true }` |
| Errors | none beyond auth |
| Idempotency | Naturally idempotent |
| Persistence | None |

**`message.send` — excluded, not part of this contract.** ADR-004 §6: "sending a message is `POST /conversations/{id}/messages` (REST), never a WebSocket write." A `message.send` WS event would duplicate a write path the architecture already forbids duplicating.

**A client-writable `message.read` — excluded, not part of this contract.** ADR-004 §6: "delivery/read acknowledgement is a REST call... not a raw WebSocket ack primitive — keeps the durable read-state in PostgreSQL, not the ephemeral socket." Read-state changes go through `POST /conversations/{id}/read` (REST, already named in `api.md` §12); the WS layer only ever *broadcasts* the resulting change (`conversation.read`, below), it never accepts it as input.

### Server → client

| Event | `message.accepted` |
|---|---|
| Purpose | A new message was persisted in a conversation the recipient has joined |
| Authenticated | N/A (server-originated, only sent to already-authenticated, room-joined sockets) |
| Authorization | Implicit — only emitted into `conversation:{conversationId}`, which only authorized participants have joined |
| Payload | The persisted message (id, conversationId, senderId, body, createdAt, clientMessageId) — same shape the REST `POST` response body already returns to the sender |
| Ack | None (server → client fire-and-forget; delivery is best-effort, see §8) |
| Errors | N/A |
| Idempotency | `clientMessageId` is included so a client that also sees its own optimistic local copy can dedupe by that key, not by racing the REST response against the WS event |
| Persistence | Emitted **after** the REST write commits — never before, and never as a substitute for it |

| Event | `message.updated` |
|---|---|
| Purpose | An existing message was edited (`edited_at` set) |
| Payload | `{ id, conversationId, body, editedAt }` |
| Everything else | Same shape as `message.accepted` — emitted after `PATCH /messages/{id}` commits *(implemented)* |

| Event | `message.deleted` |
|---|---|
| Purpose | An existing message was soft-deleted (`deleted_at` set) |
| Payload | `{ id, conversationId, deletedAt }` — body is never re-sent, matching "hides a message from participants immediately" (database.md §9) |
| Everything else | Emitted after `DELETE /messages/{id}` commits *(implemented)* |

| Event | `conversation.read` |
|---|---|
| Purpose | A participant's read cursor advanced (`participants.last_read_message_id` updated) |
| Payload | `{ conversationId, userId, lastReadMessageId, readAt }` |
| Everything else | Emitted after the REST `POST /conversations/{id}/read` call commits — this is the *only* way `conversation.read` is ever triggered, there is no WS-originated equivalent (see exclusion above) |

| Event | `conversation.updated` |
|---|---|
| Purpose | Conversation-level metadata changed — the request→accepted `status` transition, or a future `title` change |
| Payload | `{ id, status }` *(as built; `title` is not a changeable field yet)* |
| Everything else | Emitted after `POST /conversations/{id}/accept` or `/decline` commits *(implemented; no dedicated test yet)* |

| Event | `error` |
|---|---|
| Purpose | *(differs from design)* Sent only immediately before the server closes a socket that exceeded the invalid-request threshold; ordinary request failures are returned in the request's acknowledgement (§3) |
| Payload | `{ code, message }` — same canonical vocabulary as the REST error envelope's `code` field (`AUTHENTICATION_REQUIRED`, `RESOURCE_NOT_FOUND`, etc.), not a second error taxonomy |
| Everything else | The connection is closed after this event is sent |

---

## 8. Message delivery model

Three distinct guarantees, never conflated:

1. **Persisted successfully** — the REST `POST` call's response returning `2xx` is the only thing that means "this message durably exists." Nothing about the WebSocket layer is required for this to be true.
2. **Delivered to an active socket** — `message.accepted` (and the other server→client events) reaching a connected, room-joined client is **best-effort, at-most-once**. If the recipient's socket is offline, disconnected, or simply hasn't joined that room, the event is not queued or redelivered later — this architecture does not claim guaranteed delivery over the live channel, because nothing is built (a message queue, per-socket delivery receipts) that could actually provide it.
3. **Read by recipient** — only ever true once the REST read-acknowledgement call persists `participants.last_read_message_id`; a delivered-but-unacknowledged message is not "read."

**Offline recipient:** sees nothing live; on their next app open/reconnect, the normal REST history fetch (§9) shows the message like any other — no special "offline queue" is built or needed, because REST is already the durable source of truth.

**Reconnect behavior:** on reconnect, the client re-authenticates, re-joins its previously-open conversation rooms, and **must** re-fetch recent history via the REST cursor endpoint to catch anything missed while disconnected — the WebSocket stream is never assumed to be a complete record of what happened while offline (ADR-004 §6, unchanged).

**Duplicate event handling:** a client may see both its own optimistic local echo of a sent message *and* the `message.accepted` broadcast for that same message — `clientMessageId` (already a real, unique-per-sender column in `messaging.messages`, per the applied schema) is the dedupe key, not message `id` guessing or timing.

**Ordering:** within one conversation, `message.accepted` events are emitted in the same order the underlying REST writes committed (Socket.IO preserves per-socket emission order over one connection) — but cross-conversation or cross-reconnect ordering is not guaranteed, which is exactly why REST's `(conversation_id, created_at, id)` cursor index (already applied) is the authoritative ordering, not the live stream.

**Read-state updates:** always REST-originated, always broadcast (never accepted) over WS, per §7.

---

## 9. Pagination boundary

- **REST history endpoint's responsibility:** all of it. `GET /conversations/{id}/messages`, cursor-paginated exactly like every other list endpoint in this API (`api.md` §9/ADR-004 §5 convention — opaque cursor, default 20/max 50, forward-only).
- **WebSocket's responsibility:** none of it. It streams *new* events after the client is already caught up via REST — it never serves a "give me the last 50 messages" request.
- **Initial conversation history load:** client opens a conversation → REST `GET .../messages` (first page) → **then** `conversation.join` over WS for live updates from this point forward. The two are sequenced, not interchangeable.
- **New messages arriving:** purely via the `message.accepted` WS event once joined — no polling needed while connected.
- **Reconnect/backfill:** exactly the same REST cursor call, using the last-known message's cursor, to fill any gap opened while disconnected — never inferred from "how long was I offline," always an explicit, correct cursor-bounded query.

---

## 10. Authorization

One shared decision point (`MessagingAccessService`, §5), consulted identically by REST and WebSocket — never two copies of the same rule.

| Action | Rule |
|---|---|
| Opening a conversation (REST) | Active `messaging.participants` row for the requesting user |
| Joining a conversation room (WS) | The same participant-and-block check, run at join time. *(The access token itself is not re-verified at join — see §3.)* |
| Sending a message (REST only — never WS) | Active participant row + conversation not `deletedAt` + (for a still-`pending` conversation) sender-side message-request rules per PRD §19 (a first message from a non-connection is a request until accepted — enforced by the already-applied `conversations.status` field) |
| Reading message history (REST) | Active participant row |
| Marking read (REST only — never WS) | Active participant row; a user can only advance their own `last_read_message_id`, never another participant's |
| Editing / deleting a message (REST) | Sender-only ownership **and** the same participant/block check as every other message action (`assertOwnsMessage` calls `MessagingAccessService`). *(Fixed 2026-09-20 — see §14.)* |
| All of the above | Re-checked against `social.blocks` (existing table, not duplicated or redesigned) — a block between the two participants suppresses all of the above the same way it already suppresses posts/comments/reactions/shares today |

Friendship/follow relationship rules govern **conversation creation** specifically (who may initiate a request vs. send directly to an existing connection) — that logic lives entirely in the future REST `POST /conversations` handler; the WebSocket layer never creates conversations, so it has no independent copy of this rule to keep in sync.

---

## 11. Rate limiting / abuse protection

No new dependency. Message *sending* is REST (§7) and therefore already covered by the existing `RateLimitGuard` (`services/api/src/common/guards/rate-limit.guard.ts`) once a messaging controller applies it, exactly like every other mutating endpoint today.

New WS-specific surface, using the same in-memory per-key approach `RateLimitGuard` already implements (not a new package):

- **Connection attempts:** throttle handshake attempts per IP (mirrors the existing guard's key shape, applied in `handleConnection` rather than as an HTTP route decorator). *(designed — not yet implemented.)*
- **Room joins (`conversation.join`):** throttle per user — a burst of join attempts across many conversation IDs is a plausible enumeration/abuse pattern worth capping even though each individual check is cheap. *(designed — not yet implemented.)*
- **Repeated invalid events:** a strike counter per connection — a socket that repeatedly sends malformed or unauthorized requests is disconnected after a threshold, rather than being allowed to hammer the authorization/validation path indefinitely. This is the one case where a non-auth failure *does* close the connection (§3), specifically to bound abuse, not because any single failure is itself fatal. *(implemented for malformed `conversation.join` requests: 20 per connection, then an `error` event and disconnect.)*

---

## 12. Scaling

At the approved ~10,000 registered / ~1,000 concurrent target, **a single NestJS process is sufficient** — Node/Socket.IO comfortably handles this connection count for a lightweight message-passing workload on modest hardware. Nothing beyond what's already described is needed at MVP scale, and nothing beyond it is added by this document.

**Future path, described but not built:**
1. Multiple NestJS instances behind a load balancer, once measured load (not a guess) justifies it — matching the "revisit only if load-test evidence justifies it" posture already used elsewhere in this project's decisions (e.g. cursor signing in ADR-004 §5).
2. **Sticky sessions** (or **WebSocket-only transport**, disabling Socket.IO's HTTP long-polling fallback, as an alternative that avoids needing them) — required only once there's more than one instance, so a reconnecting client's polling requests land back on the instance holding its session state.
3. **`@socket.io/redis-adapter`** — required once more than one instance exists, so `socket.to('conversation:x').emit(...)` reaches sockets connected to a *different* instance than the one that received the originating REST write. Redis is already an approved piece of this architecture (`architecture.md` §15, "derived/ephemeral state only") — this would be a new *use* of it, not a new piece of infrastructure, when the time comes.

None of steps 1–3 are implemented, configured, or depended upon by this document — explicitly deferred per this task's own instruction not to add Redis Socket.IO infrastructure without a demonstrated requirement.

---

## 13. Dependency gate

See ADR-006 §13 for the authoritative table (this document mirrors it): `@nestjs/websockets@12.0.3`, `@nestjs/platform-socket.io@12.0.3`, `socket.io@4.8.3` (all runtime, required), `socket.io-client@4.8.3` (dev, optional — only if backend e2e tests exercise the gateway directly). **Installed with the implementation, at exactly these versions.**

---

## 14. Implementation status (updated 2026-09-20)

| Area | Design | State |
|---|---|---|
| Transport: Socket.IO on NestJS 12.0.3 | Approved | **Implemented** (`@nestjs/websockets` / `@nestjs/platform-socket.io` 12.0.3, `socket.io` 4.8.3) |
| Handshake authentication (cookie) | Approved | **Implemented** as connection middleware (`server.use()` in `afterInit`); regression-tested (`connect_error`, not a later failure) |
| Mobile authentication | Post-connect auth frame | **Differs from design:** Socket.IO handshake `auth: { accessToken }`; no post-connect event exists |
| Auth failure at the handshake | Rejected before connect | **Implemented:** `connect_error` = `AUTHENTICATION_REQUIRED` / `TOKEN_INVALID` |
| Namespace and rooms | `/messaging`, `conversation:{id}`, `user:{id}` | **Implemented**; `user:{id}` is joined on connect, no event uses it yet |
| Room join/leave authorization | Participant + block check | **Implemented** via the shared `MessagingAccessService`; tested (participant, non-participant, blocked, leave) |
| Live events | `message.accepted`/`updated`/`deleted`, `conversation.read`/`updated` | **Implemented**, emitted after the REST write commits; the first four are tested, `conversation.updated` has no dedicated test yet |
| Event envelope (event ID, version, timestamp) | `architecture.md` §24 | **Not implemented** — the payload is the affected resource |
| Request failures | Typed `error` event | **Differs from design:** returned in the request's acknowledgement |
| Token-expiry re-check at join | Approved | **Not implemented** |
| Disconnect on logout / session revocation | Approved | **Not implemented** (no socket↔session link) |
| Evict a blocked or departed participant from a joined room | Approved | **Not implemented — confirmed by probe (2026-09-19), tracked as F-1 below** |
| Access check on message edit/delete | Implied by §10 | **Implemented** (fixed 2026-09-20): `assertOwnsMessage` now also calls `MessagingAccessService.assertCanAccessConversation`; regression-tested for blocked-either-way, left, and soft-deleted conversations, and that a rejected edit/delete is not broadcast |
| Origin validation on the WebSocket upgrade | Approved | **Not implemented** (Socket.IO `cors` option only) |
| Throttling of connection attempts and room joins | Approved | **Not implemented** |
| Invalid-request strike counter | Approved | **Implemented** for malformed `conversation.join` (20, then `error` + disconnect) |
| Scaling | Single process | As designed; no Redis adapter or sticky sessions |

Rows marked **Not implemented** or **Gap** are open follow-up work, not changes to the approved design.

### Tracked follow-ups

**F-1 — Evict sockets from `conversation:{id}` when a participant is blocked or leaves (open, not scheduled).**
Probe result (2026-09-19, throwaway test, not committed): a socket that has joined a room **stays a member** after the user is blocked or after their `participants.left_at` is set; nothing removes it.
- **After a block — latent.** Nothing reaches the blocked socket today, because every REST action by either party is rejected (bidirectional block) before it emits. It would leak as soon as any event source not gated on the block exists.
- **After `left_at` — real leak.** The remaining participant can still send, and the departed user's already-joined socket **receives `message.accepted`**. No REST leave/remove endpoint exists yet, so this is not reachable through the API today; it becomes live when leave, removal or conversation soft-delete is added.
- **Fix direction (not designed here):** on block, leave and conversation deletion, remove that user's sockets from the room server-side (`socketsLeave`), and re-check access before emitting. Needs its own test-first change; also relates to the "Disconnect on logout" and token-expiry rows above.
