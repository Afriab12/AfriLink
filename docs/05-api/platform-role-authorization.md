# AfriLink Platform-Role Authorization Design

**Status:** DESIGN ONLY — proposed and owner-approved for the architecture; no guard, decorator, seed script, endpoint, or database change exists yet. No `schema.prisma`, migration, or dependency change accompanies this document.
**Date:** 2026-09-24
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

**2. First-privileged-user bootstrap — a version-controlled seed script, run by a trusted operator, never an API endpoint.** No unauthenticated or special-purpose bootstrap route is created. The script is environment-controlled (run separately, deliberately, against dev/test/prod) — matching the existing precedent `database/seeds/reference.seed.ts` already established for `reference.countries`/`reference.interests`: a code-reviewed, repeatable artifact, not a one-off manual SQL command and not an API-driven flow (which would itself be a privilege-escalation attack surface). Script contents are not created by this document — decision recorded, not implemented.

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

- **Future role-matrix expansion** (`admin`, `senior_moderator`, `security_administrator`, or others) — purely data-additive per decision 1, zero schema/guard change, whenever `architecture.md` §11's matrix is actually approved. Not designed further here.
- **Granular moderation permissions** via `Permission`/`RolePermission` — available, unused, per decision 6. Not designed further here.
- **`audit.events` recording of role grants/revokes** — `database.md` §13 names role changes as an audit category, but the `audit` schema doesn't exist yet (Database Phase 2 not started for Audit). Architecturally correct eventually; not buildable or required for this increment. The `UserRole` row's own `granted_by`/`granted_at`/`revoked_at` fields are the only trail available for now.
- **The `/admin/*` grant/revoke endpoints themselves** — `api.md` §15 already forward-contracts this surface ("Platform role + MFA + audit"). Not designed or built by this document; belongs to whichever future increment builds the Admin module, guarded by the same `PlatformRoleGuard`/`@RequireRole('moderator')` mechanism this document establishes the shape of.

**No genuinely open architectural decisions remain for this design.** The two items previously flagged open (exact future role-key matrix; seed-script-vs-manual-SQL bootstrap approach) are both resolved by decisions 1 and 2 above.

## 5. Consistency check against current `JwtAuthGuard` and the RBAC schema

- `JwtAuthGuard`'s current payload/behavior (`{ sub, sid }`, session-revocation + account-status re-check, commit `a267312`) — **unaffected**. This design adds a new, separate, composed-after guard; it does not read, write, or depend on anything about how `JwtAuthGuard` is implemented beyond it having already run and set `request.user`.
- `identity.user_roles`' partial unique index (`WHERE revoked_at IS NULL`) — directly relied upon by decision 5's "next request re-check" guarantee: at most one active grant per `(user_id, role_id, scope_type, scope_id)` means the lookup this design performs is always unambiguous.
- No contradiction found between this document, `docs/05-api/moderation.md` §8, and the current schema — `moderation.md` §8 already anticipated exactly this reuse-not-reinvent shape before this document existed; nothing there is now stale.

## 6. Implementation sequence (unchanged from the prior review, restated for reference — not started)

1. Seed a `moderator` `Role` row (decision 2) — data-only, its own tiny reviewed increment.
2. Build `PlatformRoleGuard` + `@RequireRole()` (decorator, parameterized per decision 1's future-extensibility note) — test-first, mutation-tested, `EXPLAIN`-verified, matching the rigor already applied to `JwtAuthGuard`.
3. Build the future `/admin/*` grant/revoke endpoints, guarded by step 2's mechanism.
4. Manual bootstrap: the first `moderator` grant via the seed script (decision 2), per environment.
5. Only then: apply `@UseGuards(JwtAuthGuard, PlatformRoleGuard)` + `@RequireRole('moderator')` to Moderation's own controllers, as part of Moderation's own implementation.

None of steps 1–4 are Moderation-module work.
