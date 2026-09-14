# Prompt: Database Architecture Design

**Phase:** 03-database
**Produces:** `docs/04-database/database.md`
**Depends on:** `docs/01-product/PRD.md`, `docs/03-architecture/architecture.md`, `docs/10-decisions/decisions.md` (ADR-001), `docs/03-architecture/approval-gate.md` (ADR-002)

---

## Purpose

Design the PostgreSQL database architecture for AfriLink: schema organization, tables, columns, constraints, indexes, and relationships for the approved MVP scope, consistent with the modular-monolith architecture and the product/privacy/retention decisions already approved.

This prompt does not implement executable migrations. It produces the logical/physical database design document that later implementation work (Prisma schema, migrations) is generated from.

---

## Before you start

Read, in order:

1. `CLAUDE.md` — technology stack, architecture rules, database rules, the "never silently change" list.
2. `docs/01-product/PRD.md` — MVP feature scope. Do not design tables for anything outside MVP (no marketplace, payments, jobs, monetization, live streaming) unless explicitly approved.
3. `docs/03-architecture/architecture.md` — module boundaries and how each core module (Auth, Users, Profiles, Countries, Interests, Friendships, Follows, Posts, Comments, Reactions, Shares, Feed, Media, Communities, Messaging, Notifications, Search, Reports, Moderation, Admin, Privacy) is expected to behave.
4. `docs/10-decisions/decisions.md` (ADR-001) — privacy-by-design, retention windows (30-day account deletion, 90-day content retention), identity model (no KYC for MVP), data residency posture.
5. `docs/03-architecture/approval-gate.md` (ADR-002) — friend vs. follow semantics, messaging/media MVP scope, moderation taxonomy, reliability/capacity targets.

If any of these documents is missing, empty, or still in draft, stop and report that the database design is blocked pending that approval. Do not invent product or policy decisions to fill the gap.

---

## Task

Follow the `DEVELOPMENT WORKFLOW` in `CLAUDE.md` (review requirements → review architecture → identify dependencies → explain approach → identify affected files → implement → ...). For this prompt, "implement" means writing the design document, not application code.

For each core module in MVP scope, define:

- Which PostgreSQL schema it belongs to (group related modules under one schema; do not create a schema per table).
- Tables, with primary key strategy, foreign keys, and audit fields (`created_at`, `updated_at`, soft-delete field where applicable).
- Constraints: unique constraints, check constraints, not-null rules — derived from actual product rules (e.g., a friendship request cannot target yourself; a block pair cannot duplicate in either direction).
- Indexes needed for the access patterns the module actually requires (list queries, cursors, lookups) — not speculative indexes.
- Any relationship that is easy to get wrong (self-referential relationships, unordered-pair uniqueness, polymorphic-looking associations) and how the design avoids it.

Then produce, at the document level:

- Database goals and non-goals.
- Full schema-to-responsibility table.
- An ERD (Mermaid `erDiagram` is acceptable) covering the modeled entities.
- A section on scaling posture (partitioning, read replicas) — describe what would trigger it, do not implement it prematurely.
- A "risks and decisions required" table listing anything the design depends on that has not yet been explicitly approved, with a status (Resolved / Partially resolved / Open) and where the resolution lives.
- A recommended implementation order for turning the design into executable migrations, phased so that the modules needed for the earliest usable slice (identity, social graph, content) come first.

---

## Constraints

- PostgreSQL is the single source of truth for relational data — no duplicate authoritative stores.
- Respect the modular-monolith boundary: schemas separate module data, but this is one database, not one per service.
- Do not design tables for out-of-MVP features (marketplace, payments, jobs, advanced monetization, live streaming) per `CLAUDE.md`.
- Do not silently resolve an open product/policy question by picking a default in the schema — surface it in the risks/decisions section instead, unless `CLAUDE.md` or an approved ADR already gives the answer.
- Treat any change to an already-approved schema shape (once `docs/04-database/database.md` has a "Phase 1 implemented" status) as a change to an existing subsystem: explain why before proposing it, per `CLAUDE.md`'s "never silently change" rule on database architecture.
- No application code, ORM code, or runnable migrations belong in this deliverable — this is the design phase, not the implementation phase.

---

## Output

Update `docs/04-database/database.md` directly. Keep its `Status`, `Date`, and header note accurate to what is actually designed vs. implemented vs. still open. Report back using the `RESPONSE FORMAT FOR CLAUDE` section of `CLAUDE.md`.
