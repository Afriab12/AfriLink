 # AFRILINK — CLAUDE CODE PROJECT INSTRUCTIONS

## Project
AfriLink is an Africa-first social networking platform.

### Tagline
Africa's Social Network, Built for Africans.

### Vision
To build the digital social infrastructure that connects African people, communities, creators and businesses across borders.

---

# DEVELOPMENT PRINCIPLE
Treat AfriLink as a production-oriented startup product.

Do not generate large amounts of code without first understanding the existing architecture.

Never rebuild or redesign an approved subsystem without explaining why.

Prefer small, reviewable changes.

Use AI as a development collaborator, not as an unquestioned authority.

---

# TECHNOLOGY
Web: Next.js + TypeScript

Mobile: React Native + TypeScript

Backend: NestJS + TypeScript

Database: PostgreSQL

Cache: Redis

API: REST + OpenAPI

Real-time: WebSockets

Storage: S3-compatible object storage

Authentication: JWT access tokens + refresh tokens

Version control: Git + GitHub

Testing: Jest/Vitest + Playwright + API testing

Containers: Docker

CI/CD: GitHub Actions

Monitoring: Sentry + OpenTelemetry

---

# ARCHITECTURE
Start with a modular monolith.

Do not introduce microservices unless there is a documented technical reason.

Keep these layers separated:

- Presentation
- API
- Business logic
- Data access
- Infrastructure
- Background jobs

Business logic should not be tightly coupled to controllers or database implementation.

---

# CORE MODULES
- Auth
- Users
- Profiles
- Countries
- Interests
- Friendships
- Follows
- Posts
- Comments
- Reactions
- Shares
- Feed
- Media
- Communities
- Messaging
- Notifications
- Search
- Reports
- Moderation
- Admin
- Privacy

---

# MVP
The MVP includes:

- Registration
- Login/logout
- Verification
- Password reset
- Profiles
- Friends
- Following
- Feed
- Text posts
- Photo posts
- Video posts
- Reactions
- Comments
- Shares
- Messaging
- Notifications
- Search
- Communities
- Country discovery
- Reporting
- Blocking
- Basic moderation
- Admin dashboard
- Privacy controls

Do not add marketplace, payments, jobs, advanced creator monetization, live streaming, or other future features unless explicitly approved.

---

# AFRILINK PRODUCT DIFFERENTIATION
Prioritize:

- African discovery
- Country-based discovery
- African communities
- Cross-border connection
- African creators
- African businesses
- African cultural context

Do not turn AfriLink into a generic copy of Facebook.

---

# DEVELOPMENT WORKFLOW
For every major feature:

1. Review requirements.
2. Review architecture.
3. Identify dependencies.
4. Explain implementation approach.
5. Identify affected files.
6. Implement the smallest appropriate change.
7. Generate tests.
8. Run tests.
9. Review security.
10. Review performance.
11. Update documentation.
12. Summarize changes.
13. Wait for approval before beginning the next major feature.

---

# IMPORTANT RULE
Never silently change:

- Database architecture
- API contracts
- Authentication design
- Core technology stack
- Folder architecture

If a change is necessary, explain the reason and impact first.

---

# DATABASE
PostgreSQL is the source of truth for relational application data.

Use:

- Foreign keys
- Appropriate indexes
- Unique constraints
- Validation constraints
- Migrations
- Audit fields

Do not introduce duplicate sources of truth.

---

# API
Use versioned REST APIs.

Example:

`/api/v1/auth`
`/api/v1/users`
`/api/v1/posts`
`/api/v1/comments`
`/api/v1/communities`
`/api/v1/messages`
`/api/v1/notifications`
`/api/v1/search`
`/api/v1/reports`
`/api/v1/admin`

Every endpoint must include appropriate:

- Authentication
- Authorization
- Validation
- Error handling
- Pagination
- Rate limiting

---

# SECURITY
Never expose:

- Passwords
- Tokens
- API secrets
- Private user information
- Internal infrastructure details

Always validate untrusted input.

Use secure authentication and authorization.

Consider:

- SQL injection
- XSS
- CSRF where applicable
- Broken access control
- File-upload abuse
- Rate-limit abuse
- IDOR-style access problems
- Privacy leaks

Security is part of implementation, not a final step.

---

# TESTING
Do not consider a feature complete until appropriate tests exist.

Use:

- Unit tests
- Integration tests
- API tests
- End-to-end tests
- Security tests
- Regression tests

Critical user journeys should have automated coverage.

---

# GIT
Use small meaningful commits.

Do not commit:

- `.env` files
- API keys
- passwords
- private certificates
- secret credentials

Before a commit:

- Run tests
- Review changed files
- Review security
- Verify no secrets are included

---

# DOCUMENTATION
Keep documentation synchronized with the implementation.

Important documents:

- `docs/01-product/PRD.md`
- `docs/03-architecture/architecture.md`
- `docs/04-database/database.md`
- `docs/05-api/api.md`
- `docs/06-design/design-system.md`
- `docs/07-security/security.md`
- `docs/08-testing/testing.md`
- `docs/09-deployment/deployment.md`
- `docs/10-decisions/decisions.md`

---

# RESPONSE FORMAT FOR CLAUDE
For major development tasks, report:

## Objective

## Understanding

## Dependencies

## Files to change

## Implementation

## Tests

## Security review

## Performance review

## Documentation updated

## Verification

## Remaining risks

Do not claim that something works unless it has actually been verified.

---

# GOLDEN RULE
Never deploy code that has not been understood, reviewed, tested and secured.

Build AfriLink incrementally.

Build it correctly.
