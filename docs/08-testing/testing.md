# Testing

**Status:** working notes on the automated tests that exist today, written 2026-09-21. This file was empty until now; it deliberately covers only what is built and verified, not a full test strategy. Sections for the other modules, for browser end-to-end tests, and for security and load testing have not been written.

## What exists

The API (`services/api`) has two kinds of automated test. Most are **end-to-end tests that boot the real NestJS application and talk to a real PostgreSQL database**: requests go through HTTP (supertest), the real guards, validation and exception filter, and the real database with the migrations applied. The rest are small **unit specs** (the rate-limit guard and the UUID pipe). E2E tests generally use real dependencies; exceptions include path-parameter boundary tests, which replace the database with a tripwire (see "Path parameter validation" below), and A3 failure-path tests, which use spies or rejected mocks for preference lookups and notification recording.

| Suite | Tests |
|---|---:|
| `test/auth.e2e-spec.ts` | 22 |
| `test/content.e2e-spec.ts` | 36 |
| `test/messaging.e2e-spec.ts` (REST and WebSocket) | 41 |
| `test/notifications.e2e-spec.ts` | 59 |
| `test/profiles.e2e-spec.ts` | 20 |
| `test/social-graph.e2e-spec.ts` | 26 |
| `test/path-params.e2e-spec.ts` | 99 |
| `src/common/guards/rate-limit.guard.spec.ts` (unit) | 5 |
| `src/common/pipes/parse-uuid.pipe.spec.ts` (unit) | 14 |
| **Partial documented snapshot total (2026-09-21; Notifications A3 adds 12)** | **322** |

- **Runner:** Vitest with SWC, configured in `services/api/vitest.config.ts`. The counts above will go stale; the suite output is the source of truth.
- **Running them:** `npm test` (or `npm run test:e2e`) in `services/api`. Both load `services/api/.env.test`, which points at the separate `afrilink_test` database, so the tests never touch `afrilink_dev`.
- **They need the local PostgreSQL container running** (`docker compose up -d` from the repo root). If nearly every test fails at once with `500` on `/auth/register`, check the container first: that is an environment fault, not a code regression.
- **CI** (`.github/workflows/ci.yml`) runs the same `npm test` against an ephemeral PostgreSQL service with the migrations applied and the reference data seeded.
- **Data is not cleaned up.** Tests register random users and leave their rows behind, so the test database grows over time. Tests must not depend on the database being empty.
- **Type checking:** `tsc --noEmit` deliberately excludes `test/`, so files there are covered by ESLint but not by the compiler; a type mistake in one only shows up at runtime. Specs under `src/` (such as `parse-uuid.pipe.spec.ts`) **are** type-checked, so they must import `describe`, `it` and `expect` from `vitest` explicitly instead of relying on the globals.

## Working method

Applied to the messaging and notifications work, and the method to keep using for new endpoints:

1. **Tests first.** Write the tests, run them, and confirm they fail *for the right reason* (for example a `404` because the route does not exist yet, not a bug in the test).
2. **Implement**, then run the tests, typecheck and lint together.
3. **Mutation checks on the real code.** Deliberately break the implementation one way at a time (drop a recipient filter, allow one block direction only, remove a guard, and so on) and confirm the intended test fails each time. A mutation that no test catches means a missing test. The files are restored afterwards and compared byte for byte.
4. **Query performance.** For list-style queries, capture the SQL Prisma actually emits and run `EXPLAIN (ANALYZE, BUFFERS)` against a large synthetic dataset inside a transaction that is rolled back.

## Path parameter validation

`test/path-params.e2e-spec.ts` and `src/common/pipes/parse-uuid.pipe.spec.ts` cover tracked follow-up T-1 (`api.md` §18): a malformed UUID in a path parameter is a `422 VALIDATION_FAILED`, never a `500`. They cover **every** route that takes a UUID path parameter (39 in the route table: 37 fixed by `ParseUuidPipe` plus the 2 Notifications routes), not a sample.

- **Boundary tests with a database that explodes if touched.** `PrismaService` is replaced by a tripwire that throws on any access, and the access token is minted directly (the JWT guard verifies the signature only, with no database lookup). A `422` therefore proves the request was rejected before any business or database logic ran. A positive control (a well-formed id must trip the wire) keeps that assertion from being vacuous.
- **Shapes of "not a UUID":** nine forms (a number, a non-hex character, one character short or long, no hyphens, a SQL fragment, an encoded slash, non-ASCII text, a 5,000-character string) on eight representative routes (posts, comments, shares, conversations, messages, social graph and auth sessions), plus well-formed lower-case, upper-case, v7 and nil UUIDs that must not be rejected. Authentication and CSRF must still answer before validation.
- **Completeness test.** It reads Nest's own route metadata and fails if any route with a path parameter is missing from the table (or the table lists a route that no longer exists), so a new route cannot be added without deciding how its id is validated. The only exempt route is `GET /profiles/{userIdOrHandle}`, which treats a non-UUID as a handle.
- **Valid ids are unchanged.** Against the real database, every route answers a well-formed id that matches nothing exactly as before (33 x `404`, and 4 idempotent deletes x `200`), and existing resources are still returned, including with an upper-case id.
- **Mutation-checked:** removing the pipe from each of the 37 routes in turn, and seven mutations of the pipe itself (accept everything, UUIDv7 only, reject upper case, wrong status, wrong field name, echo the input, generic error envelope), are each caught by the intended test.

## Notifications

`test/notifications.e2e-spec.ts` covers the notification and preference routes (`api.md` §15) with 59 tests.

**API tests use seeded rows; producer tests use real flows.** The notification REST tests insert notification rows directly through Prisma and register users through the real API. Producer behavior is covered end to end in `social-graph.e2e-spec.ts`, `content.e2e-spec.ts` and `communities.e2e-spec.ts`, exercising the originating operation through notification persistence. A3 additionally exercises all eight supported producer type mappings through the shared recording service.

What the 59 tests cover:
- **List:** authentication, ordering and the `id` tie-break, cursor pagination (including across rows with the same timestamp), limit clamping, malformed cursor, exact response fields and no internal fields, `Cache-Control`.
- **`unread=true`:** only the literal `true` is valid; any other value is `422`.
- **Isolation:** one user can never read, mark read or dismiss another user's notification (`404`, and the row is left untouched).
- **Actor privacy:** public-profile details only, `id` only for private and followers-only profiles, `null` for a system or inactive actor with the notification kept.
- **Blocked actors:** hidden in both block directions and restored on unblock, in the list, the unread list and the count; system notifications are never hidden.
- **Unread count:** exact up to 100, capped beyond it, cap applied after block filtering, and always equal to the unread list.
- **Read and dismiss:** idempotent `204` with the first timestamp kept, `404` cases, malformed id `422`, CSRF required, dismissal keeps the row and its dedup key, and dismissing does not mark read.
- **Preferences:** default effective matrix, self-scoped GET/PATCH, CSRF, strict category/channel/value/unknown-field/duplicate validation, category-to-producer mapping, prospective suppression/re-enabling, unconsumed dedup keys while disabled, and fail-closed lookup errors.

Mutation-checked before A3: 26 deliberate breakages (dropped recipient scope, one-direction blocks, a bare `notIn` that drops system notifications, no cap, non-idempotent read or dismiss, hard delete, leaked fields, missing guards, and others) are each caught by the intended test. The queries were also checked with `EXPLAIN` on about 600,000 notifications and 500,000 block rows: no sequential scan, existing indexes used. A3 has not been mutation-tested; no mutation-test runner is configured in the current checkout.

**Producer coverage and remaining gaps.** A1 tests follow and friend-request notifications. A2 tests post/comment reactions, comments/replies, community membership approval, recipient/actor/target metadata, deterministic deduplication, self-notification handling, blocked-pair suppression and best-effort failures. Still not covered:
- message-request or moderation notification producers;
- grouping and aggregation through `group_key` (A2 producers leave it null);
- preference lookup failures through every producer wrapper's real domain operation;
- quiet hours, locale, and channel consent beyond in-app preferences;
- deliveries over push, email or SMS (`notification.deliveries` is deferred);
- retention and purging (no retention period is decided).

**Also not tested: rate limiting.** Notifications rate limiting is **not currently enforced**, and no Notifications-specific limits are defined yet (`api.md` §11), so there is nothing to test.
