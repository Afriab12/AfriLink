# ADR-006: Messaging WebSocket Transport Architecture

**Status:** DESIGN APPROVED — IMPLEMENTATION NOT YET AUTHORIZED
**Date:** 2026-09-18
**Scope:** The concrete WebSocket transport stack, authentication mechanism, process placement, socket organization, and event contract for real-time Messaging delivery. This ADR does not change ADR-001–004, which remain in effect unmodified — it fills in the implementation-level detail ADR-004 §6 deliberately left as a forward contract ("boundary defined now, not implementable today").

This ADR does not authorize writing any code. No package has been installed, no gateway created, no controller/service/DTO written, no database or frontend change made as part of producing this document. See `docs/05-api/messaging-websocket.md` for the full technical detail this ADR summarizes and formalizes.

---

## 1. Transport: NestJS WebSockets + Socket.IO

**Decision: Socket.IO** (`@nestjs/websockets` + `@nestjs/platform-socket.io` + `socket.io` + `socket.io-client`), not raw `ws`, not a third-party managed push service.

Rationale — ADR-004 §6 already committed to a connection model (heartbeat/ping-pong, reconnect with exponential backoff, per-conversation rooms/channels) that is Socket.IO's built-in feature set. Choosing raw `ws` would mean hand-building reconnection, heartbeat, and room/broadcast primitives that Socket.IO already provides and NestJS already wraps as first-class decorators. A third-party managed service (Pusher/Ably/Firebase) was considered and rejected: it violates the architecture's vendor-neutrality principle (`architecture.md` §2/Decisions: "vendor/region selection... deferred to the deployment/infrastructure phase," not adopted speculatively) and duplicates the "PostgreSQL is authoritative, one deployable backend" principle by putting durable delivery state in a third party. Full comparison in `messaging-websocket.md` §1.

## 2. NestJS 12.0.3 compatibility — verified, not assumed

Checked live against the npm registry (not assumed from training data, matching this project's established discipline):

| Package | Version | Peer requirement | Installed | OK |
|---|---|---|---|---|
| `@nestjs/websockets` | `12.0.3` | `@nestjs/core ^12.0.0`, `@nestjs/common ^12.0.0`, `rxjs ^7.1.0`, `reflect-metadata ^0.1.12\|\|^0.2.0`, `@nestjs/platform-socket.io ^12.0.0` | `12.0.3` / `12.0.3` / `7.8.2` / `0.2.2` | ✅ |
| `@nestjs/platform-socket.io` | `12.0.3` | `@nestjs/common ^12.0.0`, `@nestjs/websockets ^12.0.0`, `rxjs ^7.1.0` | as above | ✅ |
| `socket.io` | `4.8.3` | bundled exactly by `@nestjs/platform-socket.io@12.0.3` | n/a | ✅ |
| `socket.io-client` | `4.8.3` | matches server version | n/a | ✅ |

No NestJS version change, no downgrade — everything targets the exact `12.0.3` already installed. Full table and the rejected `@nestjs/platform-ws` alternative in `messaging-websocket.md` §2.

## 3. Authentication: cookie-reuse handshake, REST-only refresh

The WebSocket handshake is an HTTP Upgrade request to the same origin — the existing `afrilink_at` `HttpOnly` cookie is sent automatically by the browser, exactly as ADR-004 §6 already specified. No new token transport is introduced. `afrilink_rt` (refresh) is never read during the handshake, never placed in any WS payload/query string, and refresh stays a REST-only operation (`POST /api/v1/auth/refresh`) — unchanged from ADR-004 §3.

Full state-by-state definition (handshake, access-token expiry mid-connection, reconnect-after-refresh, logout, revoked-session, blocked-user, auth failure, unauthorized-event) in `messaging-websocket.md` §3.

## 4. Cookie/cross-origin security — unchanged from ADR-004 §1

`SameSite=Lax`, `Secure` in production/staging only, no `Domain` attribute, CORS `credentials: true` restricted to `FRONTEND_ORIGIN` (matching `main.ts`'s existing `app.enableCors()` config exactly) — the WS handshake's origin is validated against the identical allow-list. No token ever moves to `localStorage`, no token ever appears in a URL/query string. Full detail in `messaging-websocket.md` §4.

## 5. Process placement: same NestJS application

**Decision: same process**, inside a new `MessagingModule` alongside the existing `AuthModule`/`ProfilesModule`/`SocialGraphModule`/`ContentModule`. No documented MVP blocker justifies a separate service (CLAUDE.md: "do not introduce microservices unless there is a documented technical reason"; the ~1,000-concurrent-user target does not constitute one). `MessagingGateway` and any future `MessagingController` both depend on the same `MessagingService`, so REST and WebSocket never implement authorization or business rules twice. Boundary detail in `messaging-websocket.md` §5.

## 6. Socket organization

Namespace `/messaging`; room `conversation:{conversationId}` per conversation (join only after a `messaging.participants` authorization check); room `user:{userId}` per connected user, for account-level events (future: presence, cross-device read sync) without needing per-conversation fan-out. Full join/leave/block/deleted-conversation handling in `messaging-websocket.md` §6.

## 7. Event contract — reconciled against ADR-004 §6, not reinvented

**Client → server:** only `conversation.join` and `conversation.leave` (room subscribe/unsubscribe — no durable write). **`message.send` and a WebSocket `message.read` are explicitly excluded** — ADR-004 §6 already ruled both out ("never a WebSocket write"; "read acknowledgement is a REST call... not a raw WebSocket ack primitive"). Introducing them now would contradict already-approved architecture, not extend it.

**Server → client:** `message.accepted`, `message.updated`, `message.deleted`, `conversation.read`, `conversation.updated`, `error` — the first four names come directly from ADR-004 §6; `conversation.updated` (status/title changes) and `error` are additive, justified by fields that already exist in the approved `messaging` schema (`Conversation.status`, `.title`). The task brief's placeholder names `message.sent`/`message.new`/a client `message.read` are deliberately **not** adopted — see `messaging-websocket.md` §7 for the full reconciliation and per-event definition (purpose, auth, authorization, payload, ack, errors, idempotency, persistence).

## 8. Message delivery model

Three distinct, never-conflated guarantees: **persisted** (REST write commits to `messaging.messages`, always) → **delivered** (best-effort push to any currently-connected, room-joined socket for that user — at-most-once, no redelivery guarantee) → **read** (REST-driven `participants.last_read_message_id` update, broadcast as `conversation.read`). An offline recipient simply never receives the live push; they see the message on their next REST fetch/reconnect-backfill. No guaranteed-delivery or exactly-once semantics are claimed anywhere — the architecture cannot actually provide them without infrastructure not being built now (message queues, delivery receipts persisted per-socket). Full detail in `messaging-websocket.md` §8.

## 9. REST/WebSocket pagination boundary — unchanged from ADR-004 §5/§6

History is REST-only, cursor-paginated (`GET /conversations/{id}/messages`, same convention as every other list endpoint). The WebSocket never paginates — it only streams live events after the initial REST-loaded page, and reconnect gaps are backfilled via the same REST endpoint, never assumed from the socket stream. Detail in `messaging-websocket.md` §9.

## 10. Authorization — one shared service, not duplicated

A future `MessagingAccessService` (not built now) is the single source of truth for "can this user act on this conversation," used identically by REST controllers and the WebSocket gateway — the same pattern already established by `ProfileVisibilityService`/`PostAccessService` across the existing Profiles/Social Graph/Content modules. Every check re-verifies active `messaging.participants` membership; blocks are re-checked via the existing `social.blocks` table (not duplicated) at conversation-creation and room-join time. Full matrix (open conversation / join room / send / read / mark-read / history) in `messaging-websocket.md` §10.

## 11. Rate limiting / abuse protection — no new dependency

Message *sending* is already REST and already covered by the existing `RateLimitGuard` pattern once a messaging controller exists. New WS-specific surface (connection attempts, room joins, malformed/repeated invalid events) reuses the same in-memory, per-key approach already used by `RateLimitGuard` — applied inside the gateway's connection/subscription handlers, not a new package. Detail in `messaging-websocket.md` §11.

## 12. Scaling — single process now, defined path later

At the approved ~10,000 registered / ~1,000 concurrent target, a single NestJS process handles this comfortably — no Redis Socket.IO adapter, no multiple instances, no sticky-session configuration is needed or added now. Future path (only if/when measured load requires it): multiple NestJS instances behind a load balancer → sticky sessions (or WebSocket-only transport, no long-polling fallback, to avoid needing them) → `@socket.io/redis-adapter` for cross-instance room broadcast. None of this is implemented as part of this ADR. Detail in `messaging-websocket.md` §12.

## 13. Dependencies — proposed, not installed

| Package | Version | Type | Required/Optional | Reason |
|---|---|---|---|---|
| `@nestjs/websockets` | `12.0.3` | runtime | Required | Gateway decorators (`@WebSocketGateway`, `@SubscribeMessage`, etc.) |
| `@nestjs/platform-socket.io` | `12.0.3` | runtime | Required | Socket.IO adapter for NestJS's WebSocket layer |
| `socket.io` | `4.8.3` | runtime | Required | Server-side transport (bundled/pinned exactly by the adapter above) |
| `socket.io-client` | `4.8.3` | dev (or a future frontend-side dependency, not this backend) | Optional for this repo | Only needed if/when backend e2e tests exercise the gateway directly; the actual browser/mobile client is the separate frontend team's dependency, not `services/api`'s |

**Nothing has been installed.** This table is the Dependency Gate output for whenever implementation is separately authorized.

## 14. Documentation

- `docs/05-api/messaging-websocket.md` — full technical architecture (this ADR's detail).
- This file.

## 15. Open decisions (not blocking this ADR, flagged for implementation time)

- Exact mobile post-connect auth-frame shape (event name/payload) — implementation detail, not an architecture blocker, same category ADR-004 §4 already left open for REST mobile auth. **Resolved at implementation:** no post-connect frame exists; mobile passes `auth: { accessToken }` in the Socket.IO handshake and connection middleware validates it (see `messaging-websocket.md`).
- Exact WS error/close-code taxonomy (beyond "typed `error` event before close," already decided) — implementation detail.
- Whether `user:{userId}` room is needed at MVP launch or can be added later (currently included for forward-compatibility with cross-device read sync, not exercised by any MVP event above) — flagged as a judgment call in `messaging-websocket.md` §6.

## Known issue, noted not fixed by this ADR

`ADR-004`'s own status line (`docs/10-decisions/decisions.md` line 233) still reads "Proposed — pending owner approval," despite ADR-004 being fully implemented in practice (exact cookie names/TTLs/CSRF pattern/pagination shape all already built and shipped). This ADR builds directly on ADR-004 §6 regardless, since the implementation record settles what the stale status line doesn't. Not corrected here — out of this task's authorized scope (documentation-only, limited to this file and `messaging-websocket.md`).
