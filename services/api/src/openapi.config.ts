import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';

// Shared by main.ts (the live `/api/docs` endpoint) and
// generate-openapi.ts (the static file for the frontend team / CI) so
// there's exactly one place that defines what the spec covers — never
// two DocumentBuilder configs that could drift apart.
//
// Error responses are documented once here, in prose, rather than
// repeated as an @ApiResponse on every one of the ~35 endpoints — the
// canonical envelope ({error:{code,message,details?,requestId}}) is
// identical everywhere, matching how docs/05-api/api.md documents it
// once globally instead of per-endpoint.
const DESCRIPTION = `
AfriLink Phase 1 REST API. All routes are under \`/api/v1\`, except this
documentation itself (\`/api/docs\`).

**Implemented in Phase 1:** Authentication, Profiles, Social Graph, Content
(posts/comments/reactions/shares). Every other module (feed, communities,
messaging, notifications, media, moderation, search, admin) is
**not implemented yet** — see \`docs/05-api/api.md\` for the full future
contract.

**Authentication:** HttpOnly cookies — \`afrilink_at\` (JWT access token,
15 min) and \`afrilink_rt\` (opaque refresh token, path-scoped to
\`/api/v1/auth/refresh\`). State-changing requests (POST/PATCH/PUT/DELETE)
additionally require the \`X-CSRF-Token\` header to match the non-HttpOnly
\`afrilink_csrf\` cookie (double-submit pattern).

**Errors:** every error response uses one canonical envelope —
\`{ "error": { "code": string, "message": string, "details"?: object,
"requestId": string } }\`. Common codes: \`VALIDATION_FAILED\` (422),
\`AUTHENTICATION_REQUIRED\` / \`TOKEN_INVALID\` / \`TOKEN_EXPIRED\` (401),
\`FORBIDDEN_ACTION\` (403), \`RESOURCE_NOT_FOUND\` (404, also returned
instead of 403 for blocked/ownership violations to avoid enumeration),
\`CONFLICT\` (409), \`INVALID_CURSOR\` (400), \`RATE_LIMITED\` (429, carries
a \`Retry-After\` header).

**Pagination:** list endpoints use opaque, forward-only cursor pagination
(\`?cursor=...&limit=...\`, default 20, max 50) — never offset pagination.
`.trim();

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('AfriLink API')
    .setDescription(DESCRIPTION)
    .setVersion('0.1.0')
    .addCookieAuth('afrilink_at', { type: 'apiKey', in: 'cookie', name: 'afrilink_at' }, 'accessTokenCookie')
    .addApiKey({ type: 'apiKey', in: 'header', name: 'X-CSRF-Token' }, 'csrfHeader')
    .addTag('Auth', 'Registration, login, verification, password reset, sessions')
    .addTag('Profiles', 'Profile read/update, interests, visibility')
    .addTag('Social Graph', 'Follows, friend requests, friendships, blocks')
    .addTag('Content', 'Posts, comments/replies, reactions, shares')
    .addTag('Messaging', 'Conversations, messages, read receipts (REST) — see docs/10-decisions/ADR-006 for the WebSocket delivery layer')
    .build();

  return SwaggerModule.createDocument(app, config);
}
