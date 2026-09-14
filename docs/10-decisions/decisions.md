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
