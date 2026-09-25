# AfriLink Platform-Role Authorization Design

**Status:** DESIGN ONLY for role *assignment/revocation* policy (§5) — owner-approved 2026-09-25, nothing implemented for it (no admin endpoints, no role assigned to anyone). The authorization *mechanism* itself (§1–§4, §6–§7) is implemented and live: `PlatformRoleGuard`/`@RequireRole()` shipped and pushed (commit `af359b2`, CI green), and the `moderator` role row is seeded in `afrilink_dev` (`database/seeds/roles.seed.ts`, commit `6292334`) — but **no user holds it yet**. No `schema.prisma`, migration, or dependency change accompanies this document at any point.
**Date:** 2026-09-24 (patched 2026-09-25 — §5 added, role-assignment policy finalized)
**Scope:** The smallest production-appropriate platform-role authorization mechanism required to unblock Moderation MVP, reusing the existing (applied, unused) Phase 1 RBAC schema — `identity.roles`, `.permissions`, `.role_permissions`, `.user_roles`.
**Not in scope:** application code, guard/decorator implementation, seed script contents, admin endpoints, schema/migration changes, Moderation's own module code, Audit (`audit.events`), the full future role matrix.

Source documents read: `database/schema.prisma` (`identity.Role`/`Permission`/`RolePermission`/`UserRole`) and the applied Phase 1 migration SQL (confirmed the RBAC tables, FKs, and the `user_roles_active_assignment_key` partial unique index are real, not just schema-level); current `services/api/src/common/guards/*` (`JwtAuthGuard`, `OptionalJwtAuthGuard`, `CsrfGuard`, `RateLimitGuard`) and their decorators; `docs/03-architecture/architecture.md` §11 (RBAC); `docs/04-database/database.md` §4, §13 (`audit.events` naming role changes as an audit category); `docs/05-api/api.md` §5, §15 (`/admin/*` forward contract); `docs/05-api/moderation.md` §8.

This document is **owner-approved as of 2026-09-24**; all decisions below are settled, not proposals. Nothing in this document has been implemented.

## 1. Why this exists

`docs/05-api/moderation.md` identified, and this document resolves, a genuine gap: `JwtAuthGuard`'s enforcement (signature/expiry, session revocation, account status — all shipped, commit `a267312`) has no concept of "is this user a moderator." No signal exists anywhere — not in the JWT, not in any guard — distinguishing an ordinary active user from a moderator, even though the Phase 1 RBAC schema (`Role`/`Permission`/`RolePermission`/`UserRole`) has existed, fully applied, since the very first migration, with zero rows and zero consumers.

## 2. Existing RBAC schema — confirmed real, reused unchanged

| Table | Confirmed columns | Confirmed constraints/indexes |
|---|---|---|
| `identity.roles` | `id`, `key` (unique), `name`, `description`, `created_at` | `roles_key_key` unique |
| `identity.permissions` | `id`, `key` (unique), `name`, `description`, `created_at` | `permissions_key_key` unique |
| `identity.role_permissions` | `role_id`, `permission_id`, `created_at` | composite PK `(role_id, permission_id)`, both FKs `ON DELETE CASCADE` |
| `identity.user_roles` | `id`, `user_id`, `role_id`, `scope_type` (nullable), `scope_id` (nullable), `granted_by` (nullable, no FK — pre-existing, not introduced here), `granted_at`, `expires_at` (nullable), `revoked_at` (nullable) | `user_roles_user_id_idx`; **`user_roles_active_assignment_key`** — partial unique `(user_id, role_id, scope_type, scope_id) WHERE revoked_at IS NULL`, already prevents duplicate active grants |

Verified directly against the applied migration SQL (`migrations/20260914000000_init_phase1/migration.sql`), not just `schema.prisma`. `scope_type`/`scope_id` nullable already represents a platform-wide (non-community-scoped) grant as `(NULL, NULL)`. `expires_at` already supports time-bound grants. **No schema change of any kind is required by this design** — decision 3 below.

## 3. Decisions recorded (owner-approved, 2026-09-24)

**1. Platform role matrix — `moderator` only for MVP.** No `admin`, `senior_moderator`, or `security_administrator` role is created now. `architecture.md` §11's full role matrix remains, correctly, an open product/operations decision — not resolved or pre-empted by this document. Additional roles are **deferred**, to be introduced later as pure data (`INSERT INTO identity.roles`) with zero schema or guard code change, whenever a real requirement exists — see §6.

**2. The *role's existence* is seeded; the *grant* is not.** `database/seeds/roles.seed.ts` (committed `6292334`, run against `afrilink_dev`) is a version-controlled, idempotent seed script — matching the existing `reference.seed.ts` precedent — but it deliberately seeds only the `moderator` `Role` row, never a `UserRole` grant. Refined by §5 below: the first (and every) *grant* is a trusted-operator, direct-database action, not a seed script and not an API — a seed script re-run in every environment is the right shape for "this role exists," but wrong for "this specific person holds it," which is environment- and person-specific.

**3. Existing RBAC structure reused as-is — no new tables, no migration.** `identity.roles`/`.permissions`/`.role_permissions`/`.user_roles` are sufficient exactly as they stand (§2). This document proposes zero schema changes.

**4. No JWT role claims.** `JwtAuthGuard`'s token payload (`{ sub, sid }`) is unmodified — this document does not touch it, per standing instruction. Platform-role authorization performs a **fresh server-side lookup** against `user_roles` on every request to a role-gated route, exactly mirroring the pattern `JwtAuthGuard` itself already established for session/status enforcement (no cached or token-carried claim, ever).

**5. Revocation takes effect on the next protected request.** Because no role state is cached or token-carried (decision 4), setting `revoked_at = now()` on the active `UserRole` row is immediately honored — the very next request to a role-gated route re-checks the database fresh. No propagation delay, no token-expiry window to wait out.

**6. MVP permission granularity — flat `moderator` check only.** Every `/moderation/*` route in the approved API design (`docs/05-api/moderation.md`) requires the identical condition — "is a moderator" — so `RolePermission`'s finer-grained join is not needed now. `Permission`/`RolePermission` remain in the schema, unused, genuinely available for a future need (e.g. a `moderation:decide-appeals` permission distinct from `moderation:view-queue`) without any schema change when that need is real.

**7. Enforcement sequence — fixed, layers never merged:**

```
JwtAuthGuard  →  account/session enforcement  →  PlatformRoleGuard  →  ModerationAccessService
(authentication)  (already shipped, a267312)     (this design)         (resource-level, existing pattern)
```

`PlatformRoleGuard` (future) answers only "does this already-authenticated, already-active caller hold an active platform role" — it must never perform resource-ownership checks (e.g. "is this the report's own moderator-assignee"), and `ModerationAccessService` must never be asked to answer "is this caller a moderator at all." Each layer owns exactly one question; none substitutes for or duplicates another. This is the same separation `CommunityAccessService`/`MediaAccessService` already model for resource-level checks distinct from `JwtAuthGuard`'s authentication layer.

## 4. What remains deferred (not open decisions — future work with a known shape)

- **Future role-matrix expansion** (`admin`, `senior_moderator`, `security_administrator`, or others) — purely data-additive per decision 1, zero schema/guard change, whenever `architecture.md` §11's matrix is actually approved. **Explicitly deferred, not created now (§5 item 3).**
- **Granular moderation permissions** via `Permission`/`RolePermission` — available, unused, per decision 6. Not designed further here.
- **`audit.events` recording of role grants/revokes** — `database.md` §13 names role changes as an audit category, but the `audit` schema doesn't exist yet (Database Phase 2 not started for Audit). Architecturally correct eventually; not buildable or required for this increment. The `UserRole` row's own `granted_by`/`granted_at`/`revoked_at` fields are the MVP record (§5 item 8).
- **The `/admin/*` grant/revoke endpoints — deferred, not designed, not buildable for MVP at all (§5 item 2).** There is no in-app role grant/revoke API in MVP, full stop — not merely "not built yet." Building one would need a qualifying grantor role (`admin`, deferred per decision 3) or permitting `moderator`-to-`moderator` grants (not permitted, §5 item 4); neither exists, so no such endpoint can be safely gated. Whenever a future admin role is approved, this belongs to whichever increment builds the Admin module, guarded by the same `PlatformRoleGuard`/`@RequireRole()` mechanism this document establishes the shape of — but that is future work with no current timeline, not a near-term dependency.

**No genuinely open architectural decisions remain for either the mechanism (§1–§4, §6–§7) or the assignment policy (§5).** The role-key matrix, the bootstrap approach, and the full assignment/revocation policy are all resolved by owner decision.

## 5. Role assignment & revocation policy (MVP) — owner-approved 2026-09-25

**1. MVP platform role: `moderator` only.** Restates decision 1 — no other role exists or is created for this policy either.

**2. Operator-only role management for MVP — there is no in-app role grant/revoke API.** Every grant and every revocation, not just the first, is a trusted operator directly manipulating `identity.user_roles` via a controlled database operation (e.g. a reviewed `INSERT`/`UPDATE` statement) — never an API endpoint, never automated, never part of any script that runs in every environment. This is the load-bearing consequence of decisions 3 and 4 below: with no qualifying grantor role and no peer-granting, no endpoint could be safely built anyway.

**3. `admin` role — deferred, not created now.** Reaffirms decision 1: no `admin` role exists. Its absence is precisely why decision 2 must hold — there is no role to gate a grant/revoke endpoint with.

**4. Moderator-to-moderator (or self) granting — not permitted.** Not merely a policy preference: with no in-app grant/revoke API at all (decision 2), there is no mechanism through which a moderator (or anyone) could grant or self-grant the role even if they wanted to. The only path to holding `moderator` is decision 5.

**5. First moderator bootstrap.** A trusted operator assigns the role directly through `identity.user_roles` (a controlled database operation, e.g. `INSERT INTO identity.user_roles (user_id, role_id, granted_by, ...) VALUES (...)` identifying the target user precisely) — never a seed script (decision 2/§3 revision above), never an API. Applies identically to the *first* moderator and *every subsequent* one, since no grant API exists to make later grants any different in kind.

**6. `PlatformRoleGuard` — unchanged.** No modification to the guard, the decorator, or the fresh-per-request lookup pattern already shipped (§1–§6 above). This policy is entirely about *how a grant comes to exist*, never about how it's *checked*.

**7. Expired-grant re-grant handling — a requirement for whenever grant logic is eventually built, not resolved by this document.** `user_roles_active_assignment_key` is keyed on `revoked_at IS NULL`, not on `expires_at` — so a grant that has naturally expired (past `expires_at`, `revoked_at` still `null`) still occupies that unique-constraint slot. Any future grant logic (operator SQL today, a hypothetical future API) attempting to re-grant the same `(user_id, role_id, scope_type, scope_id)` tuple after natural expiry must explicitly set `revoked_at` on the stale row first (or as part of the same operation) — otherwise the insert fails against a grant `PlatformRoleGuard` itself already treats as inert. Documented here so it isn't lost; not fixed in schema (no schema change proposed) and not exercised today (no operator grant has been made yet).

**8. Audit — `UserRole`'s own fields are the MVP record.** `granted_by`, `granted_at`, `expires_at`, `revoked_at` on the `UserRole` row itself are the complete audit trail for MVP. Centralized `audit.events` recording of role changes (named as a category in `database.md` §13) remains a future phase, not required and not blocking any operator action described here.

## 6. Consistency check against current `JwtAuthGuard` and the RBAC schema

- `JwtAuthGuard`'s current payload/behavior (`{ sub, sid }`, session-revocation + account-status re-check, commit `a267312`) — **unaffected**. This design adds a new, separate, composed-after guard; it does not read, write, or depend on anything about how `JwtAuthGuard` is implemented beyond it having already run and set `request.user`.
- `identity.user_roles`' partial unique index (`WHERE revoked_at IS NULL`) — directly relied upon by decision 5's "next request re-check" guarantee: at most one active grant per `(user_id, role_id, scope_type, scope_id)` means the lookup this design performs is always unambiguous.
- No contradiction found between this document, `docs/05-api/moderation.md` §8, and the current schema — `moderation.md` §8 already anticipated exactly this reuse-not-reinvent shape before this document existed; nothing there is now stale.
- **§5 consistency:** the operator-only assignment policy doesn't touch `PlatformRoleGuard`'s own behavior at all (decision 6) — the guard checks whatever rows exist in `identity.user_roles` regardless of how they got there, so nothing about the guard's already-shipped, already-tested logic needs to change or be re-verified because of this policy.

## 7. Implementation sequence (status as of 2026-09-25)

1. ~~Seed a `moderator` `Role` row~~ — **done** (`database/seeds/roles.seed.ts`, commit `6292334`, run against `afrilink_dev`).
2. ~~Build `PlatformRoleGuard` + `@RequireRole()`~~ — **done** (commit `af359b2`, test-first, mutation-tested, `EXPLAIN`-verified, CI green).
3. **Removed — not a future step.** Per §5 item 2, no `/admin/*` grant/revoke endpoint is built for MVP at all; this was previously listed as a future step and is now explicitly out of scope for as long as the operator-only policy holds.
4. **Bootstrap: the first `moderator` grant, via a trusted operator's direct database operation (§5 item 5) — not yet done.** No user currently holds the role.
5. Only once a real user holds `moderator`: apply `@UseGuards(JwtAuthGuard, PlatformRoleGuard)` + `@RequireRole('moderator')` to Moderation's own controllers, as part of Moderation's own implementation.

Step 4 is not Moderation-module work and does not require step 5's controllers to exist first — it can happen independently, whenever an operator is ready to perform it.
