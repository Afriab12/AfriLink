# Testing

**Status:** working notes on the automated tests that exist today, written 2026-09-21. This file was empty until now; it deliberately covers only what is built and verified, not a full test strategy. Sections for the other modules, for browser end-to-end tests, and for security and load testing have not been written.

## What exists

The API (`services/api`) has one kind of automated test: **end-to-end tests that boot the real NestJS application and talk to a real PostgreSQL database.** Nothing is mocked: requests go through HTTP (supertest), the real guards, validation and exception filter, and the real database with the migrations applied.

| Suite | Tests |
|---|---:|
| `test/auth.e2e-spec.ts` | 22 |
| `test/content.e2e-spec.ts` | 36 |
| `test/messaging.e2e-spec.ts` (REST and WebSocket) | 41 |
| `test/notifications.e2e-spec.ts` | 47 |
| `test/profiles.e2e-spec.ts` | 20 |
| `test/social-graph.e2e-spec.ts` | 26 |
| `src/common/guards/rate-limit.guard.spec.ts` (unit) | 5 |
| **Total (2026-09-21)** | **197** |

- **Runner:** Vitest with SWC, configured in `services/api/vitest.config.ts`. The counts above will go stale; the suite output is the source of truth.
- **Running them:** `npm test` (or `npm run test:e2e`) in `services/api`. Both load `services/api/.env.test`, which points at the separate `afrilink_test` database, so the tests never touch `afrilink_dev`.
- **They need the local PostgreSQL container running** (`docker compose up -d` from the repo root). If nearly every test fails at once with `500` on `/auth/register`, check the container first: that is an environment fault, not a code regression.
- **CI** (`.github/workflows/ci.yml`) runs the same `npm test` against an ephemeral PostgreSQL service with the migrations applied and the reference data seeded.
- **Data is not cleaned up.** Tests register random users and leave their rows behind, so the test database grows over time. Tests must not depend on the database being empty.
- **Type checking:** `tsc --noEmit` deliberately excludes `test/`, so test files are covered by ESLint but not by the compiler. A type mistake in a test only shows up at runtime.

## Working method

Applied to the messaging and notifications work, and the method to keep using for new endpoints:

1. **Tests first.** Write the tests, run them, and confirm they fail *for the right reason* (for example a `404` because the route does not exist yet, not a bug in the test).
2. **Implement**, then run the tests, typecheck and lint together.
3. **Mutation checks on the real code.** Deliberately break the implementation one way at a time (drop a recipient filter, allow one block direction only, remove a guard, and so on) and confirm the intended test fails each time. A mutation that no test catches means a missing test. The files are restored afterwards and compared byte for byte.
4. **Query performance.** For list-style queries, capture the SQL Prisma actually emits and run `EXPLAIN (ANALYZE, BUFFERS)` against a large synthetic dataset inside a transaction that is rolled back.

## Notifications

`test/notifications.e2e-spec.ts` covers the four implemented routes (`api.md` §15) with 47 tests.

**How it is tested: seeded rows.** There are no notification producers yet: nothing in the application creates a notification. The tests therefore **insert notification rows directly through Prisma**, with an opaque `type` value, and register the users through the real registration API. The API is exercised end to end from HTTP down to the database, but the *creation* of a notification is not.

What the 47 tests cover:
- **List:** authentication, ordering and the `id` tie-break, cursor pagination (including across rows with the same timestamp), limit clamping, malformed cursor, exact response fields and no internal fields, `Cache-Control`.
- **`unread=true`:** only the literal `true` is valid; any other value is `422`.
- **Isolation:** one user can never read, mark read or dismiss another user's notification (`404`, and the row is left untouched).
- **Actor privacy:** public-profile details only, `id` only for private and followers-only profiles, `null` for a system or inactive actor with the notification kept.
- **Blocked actors:** hidden in both block directions and restored on unblock, in the list, the unread list and the count; system notifications are never hidden.
- **Unread count:** exact up to 100, capped beyond it, cap applied after block filtering, and always equal to the unread list.
- **Read and dismiss:** idempotent `204` with the first timestamp kept, `404` cases, malformed id `422`, CSRF required, dismissal keeps the row and its dedup key, and dismissing does not mark read.

Mutation-checked: 26 deliberate breakages (dropped recipient scope, one-direction blocks, a bare `notIn` that drops system notifications, no cap, non-idempotent read or dismiss, hard delete, leaked fields, missing guards, and others) are each caught by the intended test. The queries were also checked with `EXPLAIN` on about 600,000 notifications and 500,000 block rows: no sequential scan, existing indexes used.

**Not covered yet: future notification-producer integration.** Because nothing creates notifications, none of the following can be tested end to end until producers exist:
- an event (a reaction, comment, follow, message request, moderation outcome) producing the right notification for the right recipient;
- deduplication of a replayed event. Today only the database's unique `(recipient_user_id, dedup_key)` constraint is tested, by inserting a duplicate directly, not the producer path that would hit it;
- grouping and aggregation through `group_key`;
- suppressing a notification at creation time when the pair is blocked (the API filters on read; a producer should also not create it);
- user preferences, quiet hours and channel consent (no API over `notification.preferences` exists);
- deliveries over push, email or SMS (`notification.deliveries` is deferred);
- retention and purging (no retention period is decided).

**Also not tested: rate limiting.** Notifications rate limiting is **not currently enforced**, and no Notifications-specific limits are defined yet (`api.md` §11), so there is nothing to test.
