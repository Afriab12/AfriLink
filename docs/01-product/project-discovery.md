# AfriLink Project Discovery

**Status:** Draft - pending product approval  
**Date:** 2026-09-13  
**Product:** AFRILINK  
**Tagline:** Africa's Social Network, Built for Africans.

## 1. What is already defined

### Product direction

- **Vision:** Build the digital social infrastructure that connects African people, communities, creators, and businesses across borders.
- **Product differentiation:** Prioritize African discovery, country-based discovery, African communities, cross-border connection, African creators, African businesses, and African cultural context.
- **MVP feature categories:** Registration, authentication, verification, password reset, profiles, friends, following, feed, text/photo/video posts, reactions, comments, shares, messaging, notifications, search, communities/groups, country discovery, reporting, blocking, basic moderation, admin, and privacy controls.
- **Explicit exclusions:** Marketplace, payments, jobs, advanced creator monetization, live streaming, and other future features are not to be added without approval.

### Technical and governance constraints

- Start with a **modular monolith** and do not introduce microservices without a documented technical reason.
- Keep presentation, API, business logic, data access, infrastructure, and background jobs separated.
- Use the technology baseline specified by `CLAUDE.md`: Next.js/TypeScript, React Native/TypeScript, NestJS/TypeScript, PostgreSQL, Redis, REST/OpenAPI, WebSockets, S3-compatible storage, JWT access and refresh tokens, Docker, and CI/CD.
- PostgreSQL is the relational source of truth. Security, validation, authorization, migrations, testing, and auditability are mandatory concerns.
- The supporting documents are drafts, not approved contracts:
  - `docs/01-product/PRD.md` exists but is empty.
  - `docs/03-architecture/architecture.md` contains a draft modular-monolith architecture.
  - `docs/04-database/database.md` contains a draft logical PostgreSQL design.
  - `docs/05-api/api.md` contains a draft versioned REST/WebSocket contract.

## 2. What is incomplete

- No validated target users, launch country or countries, initial wedge, or user research findings.
- No approved PRD, prioritization, user stories, acceptance criteria, or definition of MVP completion.
- The broad MVP list is not decomposed into release phases or dependency order.
- No decisions on whether web, mobile, or both are required for the first release.
- No finalized identity policy: email, phone, social login, verification requirements, or age assurance.
- No supported country, language, locale, timezone, accessibility, or low-bandwidth requirements with measurable acceptance criteria.
- No approved privacy, visibility, consent, retention, deletion, export, legal hold, or cross-border data-transfer policies.
- No finalized moderation taxonomy, sanctions, appeals, legal escalation, or response-time commitments.
- No business model, operating model, budget, team ownership, launch timeline, or support model.
- No cloud, region, provider, capacity, availability, recovery, latency, or cost targets.
- Architecture, database, and API drafts contain open decisions and cannot safely be treated as implementation-ready specifications.

## 3. Important assumptions

These assumptions are provisional and require explicit confirmation:

1. The first product value is trusted discovery and meaningful connection across African countries and diaspora communities.
2. Individual users are the initial core account type; creator, community, and business experiences may need separate validation.
3. Mobile usage, variable connectivity, and media-heavy behavior justify efficient payloads, resumable uploads, retries, and low-bandwidth flows.
4. User-generated content, messaging, and communities require reporting, blocking, moderation, and appeals from the first public release.
5. Public, follower-limited, community-limited, and private visibility states are required.
6. PostgreSQL can support the initial product if queries, indexes, pagination, queues, and retention are measured and managed.
7. Search can begin with PostgreSQL full-text search, subject to validation against the initial languages and expected volume.
8. Derived feed entries, counters, search projections, notifications, and caches must remain rebuildable from authoritative records.
9. The proposed stack and module boundaries remain unchanged unless a documented technical reason is approved.

## 4. Missing requirements

### Product and market

- Initial launch market and country rollout sequence.
- Primary persona and high-value problem to solve first.
- Definition of a meaningful connection and the activation event.
- Supported account types and whether businesses are first-class identities or later scope.
- Supported languages, scripts, dialects, accessibility needs, and diaspora coverage.
- Age policy, treatment of minors, and safeguarding requirements.

### Scope and behavior

- Exact MVP feature priorities, exclusions, limits, and acceptance criteria.
- Friend versus follow semantics and their privacy implications.
- Post, video, share, group, messaging, notification, and country-discovery behavior.
- Feed ranking rules, freshness expectations, and user controls.
- Community visibility, membership, roles, invitations, and moderation rules.
- Account lifecycle, verification, recovery, username, impersonation, and deletion behavior.

### Policy and operations

- Community standards, prohibited content, moderation severity levels, sanctions, appeals, and evidence handling.
- Privacy notice, consent model, data subject rights, retention periods, deletion guarantees, and cross-border transfers.
- Admin roles, approval boundaries, incident response, abuse handling, and customer support process.
- Success metrics, SLOs, RPO/RTO, traffic assumptions, budget, and launch readiness criteria.

## 5. Dependencies

### Decisions that block implementation

1. Product approval of this discovery analysis and a populated PRD.
2. Target market, languages, age policy, account types, privacy model, and MVP acceptance criteria.
3. Moderation, reporting, blocking, appeals, retention, and legal/compliance policies.
4. Confirmation of web/mobile scope, identifier format, and API/database contract ownership.
5. Capacity, reliability, data residency, hosting region, and provider decisions.

### External and operational dependencies

- Email, SMS/OTP, push notification, media processing, content-safety, object storage, CDN, WAF, secrets, backups, and monitoring providers.
- App-store accounts and release processes if mobile is in scope.
- Moderation and support personnel with documented escalation authority.
- Legal/privacy review for every initial country and the data flows between countries.
- CI, migration, contract-test, security-test, backup, restore, and incident-response processes.

## 6. Technical risks

| Risk | Impact | Required response |
|---|---|---|
| Empty PRD and undefined acceptance criteria | Schema, API, and UI rework | Approve product scope before freezing contracts or migrations |
| Draft architecture/database/API treated as final | Inconsistent module ownership and breaking changes | Keep drafts provisional; record approved decisions in the relevant documents or ADRs |
| Feed fan-out and ranking growth | High write volume, stale feeds, queue pressure | Start with bounded hybrid push/pull, cursor pagination, metrics, and backpressure |
| Media and video processing | High storage, bandwidth, and processing cost | Direct uploads, validation, variants, quotas, cleanup, and CDN delivery |
| Realtime and offline behavior | Duplicate, missing, or out-of-order messages | Keep PostgreSQL authoritative; use idempotency, cursors, reconnect, and replay |
| External provider failures | Broken verification, notifications, or uploads | Use adapters, retries, fallback behavior, and visible dependency health |
| Modular-monolith coupling | Slow changes and difficult extraction | Enforce module ownership and application-service boundaries |
| Unmeasured database growth | Performance and availability degradation | Define traffic/storage targets, query budgets, backups, and restore drills |

## 7. Product risks

- Treating Africa as one homogeneous market may produce poor relevance, language fit, and trust.
- An unclear initial wedge may create a broad feature set without a compelling reason to return.
- A cold-start social graph may result in empty feeds and communities.
- Weak trust and safety can cause user harm, churn, and reputational damage before network effects develop.
- Business and creator requirements may expand the MVP beyond the team’s capacity.
- Country, language, cultural, and diaspora differences may make a single onboarding or discovery model ineffective.
- A demanding cross-platform MVP may delay validation of the core product.

## 8. Security risks

- Account takeover through weak credential, OTP, recovery, session, or device controls.
- IDOR and privilege escalation across profiles, posts, private media, messages, communities, moderation, and admin resources.
- Spam, scams, impersonation, harassment, coordinated abuse, and malicious automation.
- Unsafe uploads, malware, spoofed MIME types, metadata leakage, private object exposure, and excessive media access.
- Privacy leaks through search, feeds, notifications, logs, analytics, backups, exports, or cross-border processing.
- Community roles being confused with platform-wide administrator privileges.
- Sensitive moderation evidence or message content being retained, exposed, or logged improperly.
- Provider credentials, refresh tokens, secrets, or administrative actions being compromised.

Minimum controls include Argon2id or equivalent password hashing, rotating sessions, MFA for administrators, resource-level authorization, layered rate limits, strict input and upload validation, secure cookies/storage, CSRF protection where applicable, strict CORS, redacted logs, managed secrets, encryption, audit trails, dependency scanning, and tested incident response.

## 9. Scalability risks

- Feed writes and read-time ranking may outgrow ordinary relational queries.
- Messaging, audit, notification, and feed tables may become append-heavy and require partitioning or retention controls.
- PostgreSQL full-text search may not meet relevance or latency needs for all initial languages and content volumes.
- Notification fan-out and provider retries may create queue spikes and unexpected cost.
- Video storage and egress may dominate operating cost.
- A single PostgreSQL instance may become a throughput or availability bottleneck.
- Cross-border latency, residency, and regional availability may require future deployment changes.

The intended scaling path is measurement first: optimize queries and indexes, scale stateless API and workers, use safe caches and read replicas, isolate high-volume queues, partition proven hot tables, and extract a module only when a documented scaling, reliability, ownership, or deployment boundary justifies it.

## 10. Recommended next step

Create and approve the product baseline before further architecture or implementation work:

1. Confirm the initial country/market, primary user problem, launch segment, languages, age policy, and web/mobile scope.
2. Populate `docs/01-product/PRD.md` with prioritized MVP requirements, user stories, acceptance criteria, policies, and success metrics.
3. Resolve privacy, moderation, retention, identity, visibility, and data-residency decisions.
4. Review the architecture, database, and API drafts against the approved PRD and update only where the approved requirements require it.
5. Confirm capacity, reliability, vendor, and operating assumptions, then produce the implementation plan and tests.

No application code should be written until steps 1-3 are approved. This document records discovery findings only and does not approve changes to the existing technical direction.