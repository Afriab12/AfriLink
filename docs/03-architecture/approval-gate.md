# AfriLink Architecture Approval Gate

## ADR-002: Remaining Architecture Blocker Decisions

**Status:** Approved for MVP architecture
**Date:** 2026-09-14
**Scope:** Resolves the remaining architecture-blocking product decisions identified in `docs/03-architecture/architecture.md` §"Open questions" as of ADR-001 (`docs/10-decisions/decisions.md`), covering launch market, launch language, age scope, friend/follow semantics, feed ranking, Discover ranking, messaging/media scope, moderation taxonomy, moderation appeal SLA, reliability target, API performance target, initial capacity target, and vendor selection posture.

This ADR does not change ADR-001 (privacy, moderation model, data retention, identity, data residency), which remains in effect unmodified.

---

### 1. Launch market

Primary launch country: **Nigeria**.

The product architecture must still support expansion to additional African countries. Country reference data is additive (new rows), not a schema or code change.

### 2. Launch language

Primary MVP interface language: **English**.

The architecture must support future localization and additional African/international languages without major redesign.

### 3. Age scope

MVP audience: **18+ only**.

No minor/teen account system, parental controls, or age-tiered experience is designed for MVP.

### 4. Friend/follow semantics

**Friends:**

- Mutual relationship.
- Friend requests require acceptance.
- Friend relationship is private by default.
- Users can control whether their friend list is visible.

**Following:**

- One-way relationship.
- Public following is allowed unless restricted by privacy controls.
- Intended to support creators/public profiles.

Visibility rules apply consistently across profiles, feed, search, and notifications.

### 5. Feed ranking

MVP feed ranking does **not** use a complex AI recommendation system.

Initial ranking uses: relationship, relevance, recency, basic engagement signals.

The architecture allows a more advanced recommendation system to be introduced later behind the same interface.

### 6. Discover ranking

MVP Discover prioritizes: country, interests, social relationships, activity, recency, community relevance.

No machine-learning ranking is built for MVP.

### 7. Messaging and media scope

**MVP messaging:** one-to-one messaging; text; image attachments; message requests; read status; block/report integration.

**MVP media:** profile images; post images; limited video uploads; basic image/video validation and processing.

**Out of MVP:** voice calls, video calls, voice notes, live streaming, advanced short-video/reels infrastructure, advanced video editing.

### 8. Moderation taxonomy

Initial report categories: Spam, Harassment, Hate, Impersonation, Scam/fraud, Violence, Sexual content, Misinformation, Other.

Moderators may: remove content, restrict content, warn users, suspend accounts, ban accounts, restrict community participation.

Users may appeal eligible moderation actions. (Moderator action list and appeal existence were already set by ADR-001; this ADR adds the report taxonomy.)

### 9. Moderation appeal SLA

Target: **72 hours** for normal appeals. Critical safety/security cases may be prioritized faster.

Treated as an operational target for queue design and alerting, not a guaranteed legal deadline.

### 10. MVP reliability target

Initial SLO: **99.5% availability** for core production services.

### 11. API performance target

Normal API requests: target **p95 latency below 500ms** under expected MVP load. Not optimized prematurely for extreme scale.

### 12. Initial capacity target

Design target: approximately **10,000 registered users**, **1,000 concurrent users**, without requiring a fundamental architectural rewrite.

Planning target only — not a statement that the system is guaranteed to achieve it until load-tested.

### 13. Vendor selection

Keep the architecture vendor-neutral where practical. Do not lock the application to a specific cloud provider unless required.

Specific infrastructure vendors (cloud provider, database hosting, object storage, CDN, messaging infrastructure) are selected during the deployment/infrastructure phase, evaluated on: cost, African-region availability, reliability, security, data protection, object storage, database availability, CDN, messaging infrastructure.

---

### Architecture consequences

These decisions are reflected in `docs/03-architecture/architecture.md`:

- §1 Executive overview and §2 Architecture principles — launch scope framing.
- §10 Authentication — 18+ enforcement at registration.
- §12 Social graph — friend/follow visibility model.
- §13 Feed — deterministic ranking signals, pluggable ranking interface.
- §14 Messaging — one-to-one/text/image/message-requests scope, explicit exclusions.
- §16 Media — profile/post image and limited-video scope, explicit exclusions.
- §19 Country-discovery/Discover — Discover ranking signals, non-ML posture.
- §20 Moderation — report taxonomy, appeal SLA target.
- §26 Observability — SLO targets.
- §27 Deployment — vendor-neutrality decision and evaluation criteria.
- §32 Scalability — initial capacity target.

### Still open (not resolved by this ADR, and not architecture blockers)

- Exact community role/permission matrix beyond owner and moderator.
- Sanction duration tiers (e.g., suspension length policy).
- Legal escalation path specifics (requires legal review).
- Whether push/email/SMS notification channels ship at MVP launch versus in-app only (notification architecture already treats each as an optional adapter).
- Specific cloud region/vendor selection and numeric RPO/RTO (deliberately deferred per §13 above).
- Secondary launch-country sequencing and diaspora-targeting priority beyond "Nigeria first, multi-country-ready."

None of these require further architecture design work — they are policy, legal, or vendor-evaluation decisions that fit inside the architecture as already specified.
