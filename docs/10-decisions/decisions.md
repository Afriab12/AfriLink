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
