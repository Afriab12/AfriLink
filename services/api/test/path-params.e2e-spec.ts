import 'reflect-metadata';
import { RequestMethod, ValidationPipe, type INestApplication } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { PrismaService } from '../src/common/prisma/prisma.service';

// Tracked follow-up T-1 (api.md section 18): a malformed UUID in a path parameter must be a
// 422 VALIDATION_FAILED at the request boundary, never a 500 from the database driver failing to
// cast it. This file proves it for EVERY route that takes a UUID path parameter, not a sample.

interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: object;
  // What the route answers today for a well-formed id that matches nothing. Most routes are 404;
  // four idempotent deletes answer 200 by design, and must keep doing so.
  unknown: 200 | 404;
}

// Valid bodies are sent everywhere, so the ONLY thing wrong with a request is its path id.
const ROUTES: Route[] = [
  // auth
  { method: 'DELETE', path: '/auth/sessions/:sessionId', unknown: 404 },
  // content
  { method: 'DELETE', path: '/comments/:commentId', unknown: 404 },
  { method: 'DELETE', path: '/comments/:commentId/reaction', unknown: 200 },
  { method: 'GET', path: '/comments/:commentId/replies', unknown: 404 },
  { method: 'PATCH', path: '/comments/:commentId', body: { body: 'edited' }, unknown: 404 },
  { method: 'PUT', path: '/comments/:commentId/reaction', body: { type: 'like' }, unknown: 404 },
  { method: 'DELETE', path: '/posts/:postId', unknown: 404 },
  { method: 'DELETE', path: '/posts/:postId/reaction', unknown: 200 },
  { method: 'GET', path: '/posts/:postId', unknown: 404 },
  { method: 'GET', path: '/posts/:postId/comments', unknown: 404 },
  { method: 'PATCH', path: '/posts/:postId', body: { body: 'edited' }, unknown: 404 },
  { method: 'POST', path: '/posts/:postId/comments', body: { body: 'hi' }, unknown: 404 },
  { method: 'POST', path: '/posts/:postId/shares', body: {}, unknown: 404 },
  { method: 'PUT', path: '/posts/:postId/reaction', body: { type: 'like' }, unknown: 404 },
  { method: 'DELETE', path: '/shares/:shareId', unknown: 404 },
  { method: 'GET', path: '/users/:userId/posts', unknown: 404 },
  { method: 'GET', path: '/users/:userId/shares', unknown: 404 },
  // messaging
  { method: 'DELETE', path: '/messages/:messageId', unknown: 404 },
  { method: 'PATCH', path: '/messages/:messageId', body: { body: 'edited' }, unknown: 404 },
  { method: 'GET', path: '/conversations/:conversationId', unknown: 404 },
  { method: 'GET', path: '/conversations/:conversationId/messages', unknown: 404 },
  { method: 'POST', path: '/conversations/:conversationId/accept', unknown: 404 },
  { method: 'POST', path: '/conversations/:conversationId/decline', unknown: 404 },
  { method: 'POST', path: '/conversations/:conversationId/messages', body: { body: 'hi', clientMessageId: randomUUID() }, unknown: 404 },
  { method: 'POST', path: '/conversations/:conversationId/read', body: { messageId: randomUUID() }, unknown: 404 },
  // communities (two-parameter routes are checked once per parameter)
  { method: 'PATCH', path: '/communities/:communityId', body: { name: 'edited' }, unknown: 404 },
  { method: 'DELETE', path: '/communities/:communityId', unknown: 404 },
  { method: 'PUT', path: '/communities/:communityId/membership', unknown: 404 },
  { method: 'DELETE', path: '/communities/:communityId/membership', unknown: 404 },
  { method: 'GET', path: '/communities/:communityId/members', unknown: 404 },
  { method: 'POST', path: '/communities/:communityId/members/:userId/approve', unknown: 404 },
  { method: 'POST', path: '/communities/:communityId/members/:userId/reject', unknown: 404 },
  { method: 'DELETE', path: '/communities/:communityId/members/:userId', unknown: 404 },
  { method: 'PATCH', path: '/communities/:communityId/members/:userId', body: { role: 'member' }, unknown: 404 },
  { method: 'GET', path: '/communities/:communityId/posts', unknown: 404 },
  // social graph
  { method: 'DELETE', path: '/friend-requests/:friendshipId', unknown: 404 },
  { method: 'DELETE', path: '/friendships/:friendshipId', unknown: 404 },
  { method: 'POST', path: '/friend-requests/:friendshipId/accept', unknown: 404 },
  { method: 'POST', path: '/friend-requests/:friendshipId/decline', unknown: 404 },
  { method: 'DELETE', path: '/users/:userId/block', unknown: 200 },
  { method: 'DELETE', path: '/users/:userId/follow', unknown: 200 },
  { method: 'GET', path: '/users/:userId/followers', unknown: 404 },
  { method: 'GET', path: '/users/:userId/following', unknown: 404 },
  { method: 'GET', path: '/users/:userId/friends', unknown: 404 },
  { method: 'POST', path: '/users/:userId/block', unknown: 404 },
  { method: 'POST', path: '/users/:userId/follow', unknown: 404 },
  { method: 'POST', path: '/users/:userId/friend-requests', unknown: 404 },
  // notifications: already validated through a param DTO before T-1; covered here so the
  // "every UUID route" claim has no exceptions
  { method: 'DELETE', path: '/notifications/:id', unknown: 404 },
  { method: 'POST', path: '/notifications/:id/read', unknown: 404 },
  // media
  { method: 'POST', path: '/media/uploads/:uploadId/complete', unknown: 404 },
  { method: 'GET', path: '/media/:assetId', unknown: 404 },
  { method: 'DELETE', path: '/media/:assetId', unknown: 404 },
];

// The parametrised routes that are NOT pure UUID routes: each accepts a UUID or another identifier
// (a profile handle, a community slug), and treats anything that is not a UUID as that identifier.
// Malformed input there is a normal 404, never a 500 and never a validation error.
const NOT_A_UUID_ROUTES = ['GET /profiles/:userIdOrHandle', 'GET /communities/:communityIdOrSlug'];

const paramNames = (path: string): string[] => [...path.matchAll(/:(\w+)/g)].map((m) => m[1]);
const label = (r: Route): string => `${r.method} ${r.path}`;
// A valid UUID for every parameter other than the one under test.
const VALID_OTHER = '018f0000-0000-7000-8000-000000000123';
// Replaces path parameter number `which` (0-based) with `id`; every other parameter gets a valid UUID.
function withId(path: string, id: string, which = 0): string {
  let i = 0;
  return '/api/v1' + path.replace(/:\w+/g, () => (i++ === which ? encodeURIComponent(id) : VALID_OTHER));
}

function extractCookies(res: request.Response): Record<string, string> {
  const setCookie = res.headers['set-cookie'];
  const list: string[] = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const cookies: Record<string, string> = {};
  for (const raw of list) {
    const [pair] = raw.split(';');
    const [name, value] = pair.split('=');
    cookies[name] = value;
  }
  return cookies;
}

function newApp(app: INestApplication): void {
  app.setGlobalPrefix('api/v1');
  app.use(cookieParser());
  // identical to main.ts and to every other e2e spec
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new HttpExceptionFilter());
}

function call(app: INestApplication, r: Route, id: string, headers: Record<string, string>, which = 0) {
  const req = request(app.getHttpServer())[r.method.toLowerCase() as 'get'](withId(r.path, id, which)).set(headers);
  return r.body ? req.send(r.body) : req;
}

// ================================================================================================
// A. The request boundary: with a database that EXPLODES if touched.
//    PrismaService is replaced by a tripwire, and the access token is minted directly. JwtAuthGuard
//    itself now does one legitimate, expected database lookup on every authenticated request (the
//    request-time session/account-status check) — the tripwire allowlists exactly that one access
//    (`.session`, stubbed to resolve as a valid active session) and still explodes on anything else.
//    So a 422 here still proves the request was rejected before any BUSINESS/route-handler database
//    logic ran, which is what T-1 actually guarantees — not that authentication itself is DB-free.
// ================================================================================================

describe('Path parameter validation at the request boundary (T-1)', () => {
  let app: INestApplication;
  let dbHits: string[];
  let auth: Record<string, string>;

  beforeAll(async () => {
    dbHits = [];
    const guardSessionId = randomUUID();
    const passthrough = new Set(['onModuleInit', 'onModuleDestroy', 'onApplicationBootstrap', 'onApplicationShutdown', 'beforeApplicationShutdown', 'then']);
    const tripwire = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'constructor') return Object;
          if (typeof prop === 'symbol' || passthrough.has(prop)) return undefined; // lifecycle probes
          if (prop === 'session') {
            // JwtAuthGuard's own request-time session/account-status check
            // — legitimate on every authenticated request, not a T-1
            // violation. Allowed *only* for a lookup by the token's own
            // fixed sid (stubbed as a valid active session); any other
            // session access — e.g. DELETE /auth/sessions/:id operating on
            // a *different* session id — falls through to the ordinary
            // tripwire below, unaffected and still provable as a real hit.
            return {
              findUnique: async (args: { where: { id: string } }) => {
                if (args.where.id === guardSessionId) {
                  return { revokedAt: null, expiresAt: new Date(Date.now() + 3_600_000), user: { status: 'active' } };
                }
                dbHits.push('session');
                throw new Error('DATABASE TOUCHED through PrismaService.session');
              },
            };
          }
          dbHits.push(prop);
          throw new Error(`DATABASE TOUCHED through PrismaService.${prop}`);
        },
      },
    );
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(tripwire)
      .compile();
    app = moduleRef.createNestApplication();
    newApp(app);
    await app.init();

    const token = new JwtService({ secret: process.env.JWT_ACCESS_SECRET }).sign({ sub: randomUUID(), sid: guardSessionId }, { expiresIn: '10m' });
    const csrf = randomUUID();
    auth = { Cookie: `afrilink_at=${token}; afrilink_csrf=${csrf}`, 'X-CSRF-Token': csrf };
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    dbHits.length = 0;
  });

  // one case per (route, path parameter): a two-parameter route is checked for each of its ids
  const CASES = ROUTES.flatMap((r) => paramNames(r.path).map((param, which) => ({ label: label(r), param, which, r })));

  it.each(CASES)('$label rejects a malformed $param with 422 and never reaches the database', async ({ r, param, which }) => {
    const res = await call(app, r, 'not-a-uuid', auth, which);
    const field = param;

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details).toEqual([{ field, reason: `${field} must be a UUID` }]);
    expect(typeof res.body.error.requestId).toBe('string');
    expect(dbHits).toEqual([]);
  });

  // Several shapes of "not a UUID", on one representative route per controller.
  const REPRESENTATIVES: Route[] = [
    ROUTES.find((r) => label(r) === 'GET /posts/:postId')!,
    ROUTES.find((r) => label(r) === 'POST /posts/:postId/comments')!,
    ROUTES.find((r) => label(r) === 'GET /conversations/:conversationId')!,
    ROUTES.find((r) => label(r) === 'PATCH /messages/:messageId')!,
    ROUTES.find((r) => label(r) === 'POST /users/:userId/follow')!,
    ROUTES.find((r) => label(r) === 'POST /friend-requests/:friendshipId/accept')!,
    ROUTES.find((r) => label(r) === 'DELETE /shares/:shareId')!,
    ROUTES.find((r) => label(r) === 'DELETE /auth/sessions/:sessionId')!,
  ];
  const MALFORMED_FORMS: Array<[string, string]> = [
    ['a number', '12345'],
    ['a non-hex character', 'g1234567-89ab-cdef-0123-456789abcdef'],
    ['one character short', '01234567-89ab-cdef-0123-456789abcde'],
    ['one character long', '01234567-89ab-cdef-0123-456789abcdef0'],
    ['no hyphens', '0123456789abcdef0123456789abcdef'],
    ['a SQL fragment', "1' OR '1'='1"],
    ['an encoded slash', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/../x'],
    ['non-ASCII text', 'идентификатор'],
    ['a very long string', 'a'.repeat(5000)],
  ];

  it.each(MALFORMED_FORMS)('%s is rejected with 422 on every representative route, without touching the database', async (_name, value) => {
    for (const r of REPRESENTATIVES) {
      dbHits.length = 0;
      const res = await call(app, r, value, auth);
      expect(res.status, `${label(r)} with ${_name}`).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(dbHits, `${label(r)} touched the database`).toEqual([]);
    }
  });

  it('positive control: the tripwire really trips, so the "never reaches the database" assertions are not vacuous', async () => {
    const r = ROUTES.find((x) => label(x) === 'GET /posts/:postId')!;
    const res = await call(app, r, randomUUID(), auth);
    expect(res.status).toBe(500); // a well-formed id gets past validation and reaches the (exploding) database
    expect(dbHits.length).toBeGreaterThan(0);
  });

  it.each([
    ['lower case', () => randomUUID()],
    ['upper case', () => randomUUID().toUpperCase()],
    ['a UUIDv7', () => '018f4a6e-7b3c-7d2e-9a41-5c8e2f1b0a37'],
    ['the nil UUID', () => '00000000-0000-0000-0000-000000000000'],
  ])('a well-formed %s UUID is NOT rejected by validation (it proceeds to business logic)', async (_name, make) => {
    for (const r of REPRESENTATIVES) {
      dbHits.length = 0;
      const res = await call(app, r, make(), auth);
      expect(res.status, `${label(r)} with ${_name}`).not.toBe(422);
      expect(dbHits.length, `${label(r)} should have reached the database`).toBeGreaterThan(0);
    }
  });

  it('authentication and CSRF still come first: they are unchanged by path validation', async () => {
    const protectedGet = ROUTES.find((r) => label(r) === 'GET /conversations/:conversationId')!;
    const unauthenticated = await request(app.getHttpServer()).get(withId(protectedGet.path, 'not-a-uuid'));
    expect(unauthenticated.status).toBe(401);

    const mutation = ROUTES.find((r) => label(r) === 'DELETE /shares/:shareId')!;
    const noCsrf = await request(app.getHttpServer()).delete(withId(mutation.path, 'not-a-uuid')).set('Cookie', auth.Cookie);
    expect(noCsrf.status).toBe(403);
    expect(dbHits).toEqual([]);
  });

  it('the public read routes (optional authentication) validate too', async () => {
    const res = await request(app.getHttpServer()).get(withId('/posts/:postId', 'not-a-uuid')); // no cookies at all
    expect(res.status).toBe(422);
    expect(res.body.error.details).toEqual([{ field: 'postId', reason: 'postId must be a UUID' }]);
    expect(dbHits).toEqual([]);
  });

  it.each(['/api/v1/profiles/not-a-uuid', '/api/v1/communities/not-a-uuid'])('the id-or-name route %s is unaffected: a non-UUID is a handle or slug, never a validation error', async (path) => {
    dbHits.length = 0;
    // (the tripwire makes this a 500 by design; what matters is that it is NOT rejected as a validation error)
    const res = await request(app.getHttpServer()).get(path);
    expect(res.status).not.toBe(422);
  });
});

// ================================================================================================
// B. Completeness: every parametrised route the application registers is accounted for.
//    Read from Nest's own route metadata, so a new route cannot be added without deciding how its
//    path parameter is validated.
// ================================================================================================

describe('Every parametrised route is covered (T-1)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    newApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('the route table above matches the routes the app really registers, exactly', () => {
    const discovered: string[] = [];
    for (const mod of app.get(ModulesContainer).values()) {
      for (const wrapper of mod.controllers.values()) {
        const controller = wrapper.metatype as unknown as { prototype: Record<string, unknown> };
        const base = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '').replace(/^\//, '');
        for (const name of Object.getOwnPropertyNames(controller.prototype)) {
          const handler = controller.prototype[name];
          if (name === 'constructor' || typeof handler !== 'function') continue;
          const method = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
          if (method === undefined) continue;
          const sub = String(Reflect.getMetadata(PATH_METADATA, handler) ?? '').replace(/^\//, '');
          const path = '/' + [base, sub].filter(Boolean).join('/');
          if (path.includes(':')) discovered.push(`${RequestMethod[method]} ${path}`);
        }
      }
    }

    const covered = ROUTES.map(label);
    const uncovered = discovered.filter((d) => !covered.includes(d) && !NOT_A_UUID_ROUTES.includes(d));
    const stale = covered.filter((c) => !discovered.includes(c));

    expect(uncovered, 'parametrised routes with no path-validation test: add them to ROUTES').toEqual([]);
    expect(stale, 'ROUTES entries that no longer exist').toEqual([]);
    for (const exempt of NOT_A_UUID_ROUTES) expect(discovered, `exempt route ${exempt} no longer exists`).toContain(exempt);
  });
});

// ================================================================================================
// C. Valid ids keep working exactly as before, against the real database.
// ================================================================================================

describe('Valid UUIDs behave as they did before T-1 (real database)', () => {
  let app: INestApplication;
  let headers: Record<string, string>;
  let userId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    newApp(app);
    await app.init();

    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email: `t1-${randomUUID()}@example.com`, password: 'correct-horse-battery-staple' })
      .expect(201);
    const c = extractCookies(res);
    userId = res.body.data.user.id as string;
    headers = { Cookie: `afrilink_at=${c['afrilink_at']}; afrilink_csrf=${c['afrilink_csrf']}`, 'X-CSRF-Token': c['afrilink_csrf'] };
  });

  afterAll(async () => {
    await app.close();
  });

  it.each(ROUTES)('$method $path with a well-formed id that matches nothing answers exactly as before ($unknown)', async (r) => {
    const res = await call(app, r, randomUUID(), headers);
    expect(res.status).toBe(r.unknown);
    if (r.unknown === 404) {
      expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND'); // the business answer, NOT VALIDATION_FAILED
    }
  });

  it('an existing post is still returned, including with an upper-case id', async () => {
    const created = await request(app.getHttpServer()).post('/api/v1/posts').set(headers).send({ body: 'hello' }).expect(201);
    const postId = created.body.data.id as string;

    const lower = await request(app.getHttpServer()).get(`/api/v1/posts/${postId}`).set(headers).expect(200);
    expect(lower.body.data.id).toBe(postId);
    await request(app.getHttpServer()).get(`/api/v1/posts/${postId.toUpperCase()}`).set(headers).expect(200);
  });

  it('an existing conversation and an existing user are still reachable by id', async () => {
    const other = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email: `t1b-${randomUUID()}@example.com`, password: 'correct-horse-battery-staple' })
      .expect(201);
    const otherId = other.body.data.user.id as string;

    const conv = await request(app.getHttpServer()).post('/api/v1/conversations').set(headers).send({ recipientUserId: otherId }).expect(201);
    await request(app.getHttpServer()).get(`/api/v1/conversations/${conv.body.data.id}`).set(headers).expect(200);
    await request(app.getHttpServer()).post(`/api/v1/users/${otherId}/follow`).set(headers).expect(201);
    await request(app.getHttpServer()).get(`/api/v1/users/${userId}/followers`).set(headers).expect(200);
  });

  it.each(['/api/v1/profiles/not-a-uuid', '/api/v1/communities/not-a-uuid'])('the id-or-name route %s still treats a non-UUID as a handle or slug (404, unchanged)', async (path) => {
    const res = await request(app.getHttpServer()).get(path).set(headers);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
  });
});
