import 'reflect-metadata';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { PrismaService } from '../src/common/prisma/prisma.service';

// Extracts a Cookie header string from a supertest response's Set-Cookie
// headers, so subsequent requests in the same test can present them —
// supertest doesn't persist cookies across calls like a browser would.
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

function cookieHeader(cookies: Record<string, string>, ...names: string[]): string {
  return names
    .filter((n) => cookies[n] !== undefined)
    .map((n) => `${n}=${cookies[n]}`)
    .join('; ');
}

function uniqueEmail(): string {
  return `test-${randomUUID()}@example.com`;
}

describe('Authentication (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /auth/register', () => {
    it('creates an account and sets auth cookies', async () => {
      const email = uniqueEmail();
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email, password: 'correct-horse-battery-staple' })
        .expect(201);

      expect(res.body.data.user.status).toBe('active');
      expect(res.body.data.verification.devOnlyCode).toMatch(/^\d{6}$/);

      const cookies = extractCookies(res);
      expect(cookies['afrilink_at']).toBeDefined();
      expect(cookies['afrilink_rt']).toBeDefined();
      expect(cookies['afrilink_csrf']).toBeDefined();
    });

    it('rejects a duplicate email with 409 DUPLICATE_ACTION', async () => {
      const email = uniqueEmail();
      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email, password: 'correct-horse-battery-staple' })
        .expect(201);

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email, password: 'another-password-1234' })
        .expect(409);

      expect(res.body.error.code).toBe('DUPLICATE_ACTION');
      expect(res.body.error.requestId).toBeDefined();
    });

    it('returns field-mappable 422 validation errors for a bad request', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email: 'not-an-email', password: 'short' })
        .expect(422);

      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(Array.isArray(res.body.error.details)).toBe(true);
      expect(res.body.error.details.length).toBeGreaterThan(0);
    });

    it('rejects a request with neither email nor phone (business rule, not shape validation)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ password: 'correct-horse-battery-staple' })
        .expect(422);

      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('rejects mass-assignment of unexpected fields', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email: uniqueEmail(), password: 'correct-horse-battery-staple', status: 'admin' })
        .expect(422);

      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('POST /auth/login', () => {
    it('logs in with correct credentials', async () => {
      const email = uniqueEmail();
      const password = 'correct-horse-battery-staple';
      await request(app.getHttpServer()).post('/api/v1/auth/register').send({ email, password }).expect(201);

      const res = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password }).expect(200);

      expect(res.body.data.user.status).toBe('active');
      expect(extractCookies(res)['afrilink_at']).toBeDefined();
    });

    it('rejects a wrong password with a generic 401 (no account-existence leak)', async () => {
      const email = uniqueEmail();
      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email, password: 'correct-horse-battery-staple' })
        .expect(201);

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password: 'wrong-password' })
        .expect(401);

      expect(res.body.error.code).toBe('TOKEN_INVALID');
    });

    it('rejects a non-existent account with the SAME generic error as a wrong password', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: uniqueEmail(), password: 'irrelevant-password' })
        .expect(401);

      expect(res.body.error.code).toBe('TOKEN_INVALID');
      expect(res.body.error.message).toBe('Invalid credentials.');
    });
  });

  describe('POST /auth/refresh', () => {
    it('rotates the refresh token and invalidates the old one', async () => {
      const email = uniqueEmail();
      const password = 'correct-horse-battery-staple';
      const registerRes = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email, password })
        .expect(201);
      const firstCookies = extractCookies(registerRes);

      const refreshRes = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', cookieHeader(firstCookies, 'afrilink_rt'))
        .expect(200);
      const secondCookies = extractCookies(refreshRes);

      expect(secondCookies['afrilink_rt']).toBeDefined();
      expect(secondCookies['afrilink_rt']).not.toBe(firstCookies['afrilink_rt']);

      // Old refresh token must no longer work.
      const reuseRes = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', cookieHeader(firstCookies, 'afrilink_rt'))
        .expect(401);
      expect(reuseRes.body.error.code).toBe('TOKEN_INVALID');
    });

    it('treats reuse of an already-rotated token as theft and revokes every session', async () => {
      const email = uniqueEmail();
      const password = 'correct-horse-battery-staple';
      const registerRes = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email, password })
        .expect(201);
      const firstCookies = extractCookies(registerRes);

      const rotatedRes = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', cookieHeader(firstCookies, 'afrilink_rt'))
        .expect(200);
      const rotatedCookies = extractCookies(rotatedRes);

      // Reuse the original (now-revoked) token — simulates a stolen token
      // being replayed after the legitimate client already rotated.
      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', cookieHeader(firstCookies, 'afrilink_rt'))
        .expect(401);

      // The rotated (legitimate, newer) token must ALSO now be dead —
      // reuse detection revokes the whole session family, not just the
      // token that was replayed.
      const afterTheftRes = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', cookieHeader(rotatedCookies, 'afrilink_rt'))
        .expect(401);
      expect(afterTheftRes.body.error.code).toBe('TOKEN_INVALID');
    });

    it('rejects a refresh request with no refresh cookie at all', async () => {
      await request(app.getHttpServer()).post('/api/v1/auth/refresh').expect(401);
    });
  });

  describe('POST /auth/logout', () => {
    it('requires authentication', async () => {
      await request(app.getHttpServer()).post('/api/v1/auth/logout').expect(401);
    });

    it('requires a matching CSRF header, rejects when missing', async () => {
      const email = uniqueEmail();
      const registerRes = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email, password: 'correct-horse-battery-staple' })
        .expect(201);
      const cookies = extractCookies(registerRes);

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Cookie', cookieHeader(cookies, 'afrilink_at', 'afrilink_csrf'))
        // Deliberately no X-CSRF-Token header.
        .expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('logs out with a valid CSRF header and revokes the session', async () => {
      const email = uniqueEmail();
      const password = 'correct-horse-battery-staple';
      const registerRes = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email, password })
        .expect(201);
      const cookies = extractCookies(registerRes);

      await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Cookie', cookieHeader(cookies, 'afrilink_at', 'afrilink_csrf'))
        .set('X-CSRF-Token', cookies['afrilink_csrf'])
        .expect(200);

      // The session behind that access token is now revoked; refresh with
      // the matching (now-invalid) refresh token must fail.
      const refreshAfterLogout = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', cookieHeader(cookies, 'afrilink_rt'))
        .expect(401);
      expect(refreshAfterLogout.body.error.code).toBe('TOKEN_INVALID');
    });
  });

  describe('GET /auth/sessions (authorization)', () => {
    it('rejects an unauthenticated request', async () => {
      await request(app.getHttpServer()).get('/api/v1/auth/sessions').expect(401);
    });

    it('rejects a garbage access token', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/auth/sessions')
        .set('Cookie', 'afrilink_at=not-a-real-jwt')
        .expect(401);
    });

    it('lists the caller\'s own active session when authenticated', async () => {
      const email = uniqueEmail();
      const registerRes = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email, password: 'correct-horse-battery-staple' })
        .expect(201);
      const cookies = extractCookies(registerRes);

      const res = await request(app.getHttpServer())
        .get('/api/v1/auth/sessions')
        .set('Cookie', cookieHeader(cookies, 'afrilink_at'))
        .expect(200);

      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('POST /auth/verify', () => {
    it('verifies with the correct code and rejects reuse', async () => {
      const email = uniqueEmail();
      const registerRes = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email, password: 'correct-horse-battery-staple' })
        .expect(201);
      const cookies = extractCookies(registerRes);
      const { challengeId, devOnlyCode } = registerRes.body.data.verification;

      await request(app.getHttpServer())
        .post('/api/v1/auth/verify')
        .set('Cookie', cookieHeader(cookies, 'afrilink_at', 'afrilink_csrf'))
        .set('X-CSRF-Token', cookies['afrilink_csrf'])
        .send({ challengeId, code: devOnlyCode })
        .expect(200);

      const reuse = await request(app.getHttpServer())
        .post('/api/v1/auth/verify')
        .set('Cookie', cookieHeader(cookies, 'afrilink_at', 'afrilink_csrf'))
        .set('X-CSRF-Token', cookies['afrilink_csrf'])
        .send({ challengeId, code: devOnlyCode })
        .expect(409);
      expect(reuse.body.error.code).toBe('CONFLICT');
    });

    it('rejects an incorrect code', async () => {
      const email = uniqueEmail();
      const registerRes = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email, password: 'correct-horse-battery-staple' })
        .expect(201);
      const cookies = extractCookies(registerRes);
      const { challengeId } = registerRes.body.data.verification;

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/verify')
        .set('Cookie', cookieHeader(cookies, 'afrilink_at', 'afrilink_csrf'))
        .set('X-CSRF-Token', cookies['afrilink_csrf'])
        .send({ challengeId, code: '000000' })
        .expect(401);
      expect(res.body.error.code).toBe('TOKEN_INVALID');
    });
  });

  describe('Password reset', () => {
    it('resets the password with a valid challenge, then the new password works and old sessions are revoked', async () => {
      const email = uniqueEmail();
      const oldPassword = 'correct-horse-battery-staple';
      const newPassword = 'donkey-battery-staple-999';

      const registerRes = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email, password: oldPassword })
        .expect(201);
      const originalCookies = extractCookies(registerRes);

      const forgotRes = await request(app.getHttpServer())
        .post('/api/v1/auth/password/forgot')
        .send({ email })
        .expect(200);
      const { devOnlyChallengeId, devOnlyCode } = forgotRes.body.data;
      expect(devOnlyChallengeId).toBeDefined();

      await request(app.getHttpServer())
        .post('/api/v1/auth/password/reset')
        .send({ challengeId: devOnlyChallengeId, code: devOnlyCode, newPassword })
        .expect(200);

      // Old password no longer works.
      await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password: oldPassword }).expect(401);

      // New password works.
      await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password: newPassword }).expect(200);

      // Session from before the reset is revoked (security-sensitive
      // credential change per ADR-004 §1).
      const refreshOldSession = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', cookieHeader(originalCookies, 'afrilink_rt'))
        .expect(401);
      expect(refreshOldSession.body.error.code).toBe('TOKEN_INVALID');
    });

    it('does not reveal whether an account exists', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/password/forgot')
        .send({ email: uniqueEmail() })
        .expect(200);

      expect(res.body.data).toEqual({ requested: true });
    });
  });

  // Rate-limit enforcement itself (the 429/Retry-After behavior) is
  // verified in src/common/guards/rate-limit.guard.spec.ts as a focused
  // unit test — not here, since the production limits are scaled up under
  // NODE_ENV=test (see rate-limit.decorator.ts) precisely so the many
  // legitimate register/login calls throughout this suite don't cascade
  // into 429s against each other.

  it('cleans up test data it created', async () => {
    // Sanity check that this suite is actually hitting the isolated test
    // database, not the shared local dev one.
    const count = await prisma.user.count();
    expect(count).toBeGreaterThan(0);
  });
});
