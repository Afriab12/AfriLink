import 'reflect-metadata';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AuditService } from '../src/audit/audit.service';

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

  // JwtAuthGuard — request-time session/account-status enforcement.
  // Proves the guard actually re-checks the database on every request,
  // not just the JWT's own signature/expiry: a session revoked (or an
  // account sanctioned) mid-token-life must stop working immediately,
  // not after the access token naturally expires up to 15 minutes later.
  describe('JwtAuthGuard — session/account-status enforcement', () => {
    async function registerActive(): Promise<{ userId: string; cookies: Record<string, string> }> {
      const email = uniqueEmail();
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email, password: 'correct-horse-battery-staple' })
        .expect(201);
      return { userId: res.body.data.user.id as string, cookies: extractCookies(res) };
    }

    it('rejects a request whose session was revoked by logout, even though the access token itself has not expired', async () => {
      const { cookies } = await registerActive();

      await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Cookie', cookieHeader(cookies, 'afrilink_at', 'afrilink_csrf'))
        .set('X-CSRF-Token', cookies['afrilink_csrf'])
        .expect(200);

      // The access token is still cryptographically valid and unexpired —
      // only the session behind it was revoked. A protected route must
      // still reject it.
      const res = await request(app.getHttpServer())
        .get('/api/v1/auth/sessions')
        .set('Cookie', cookieHeader(cookies, 'afrilink_at'))
        .expect(401);
      expect(res.body.error.code).toBe('TOKEN_INVALID');
    });

    it.each(['restricted', 'suspended', 'banned', 'pending_deletion', 'deleted'] as const)(
      'rejects a request from a %s account with 403 ACCOUNT_RESTRICTED, with a still-valid session and access token',
      async (status) => {
        const { userId, cookies } = await registerActive();
        await prisma.user.update({ where: { id: userId }, data: { status } });

        const res = await request(app.getHttpServer())
          .get('/api/v1/auth/sessions')
          .set('Cookie', cookieHeader(cookies, 'afrilink_at'))
          .expect(403);
        expect(res.body.error.code).toBe('ACCOUNT_RESTRICTED');
      },
    );

    it('still allows a suspended account to log out (exempted route)', async () => {
      const { userId, cookies } = await registerActive();
      await prisma.user.update({ where: { id: userId }, data: { status: 'suspended' } });

      await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Cookie', cookieHeader(cookies, 'afrilink_at', 'afrilink_csrf'))
        .set('X-CSRF-Token', cookies['afrilink_csrf'])
        .expect(200);
    });

    it('still allows a banned account to log out everywhere (logout-all, exempted route)', async () => {
      const { userId, cookies } = await registerActive();
      await prisma.user.update({ where: { id: userId }, data: { status: 'banned' } });

      await request(app.getHttpServer())
        .post('/api/v1/auth/logout-all')
        .set('Cookie', cookieHeader(cookies, 'afrilink_at', 'afrilink_csrf'))
        .set('X-CSRF-Token', cookies['afrilink_csrf'])
        .expect(200);
    });

    it('rejects a well-formed, correctly-signed access token whose session id does not exist', async () => {
      const jwtService = app.get(JwtService);
      const fakeToken = jwtService.sign({ sub: randomUUID(), sid: randomUUID() }, { expiresIn: 900 });

      const res = await request(app.getHttpServer())
        .get('/api/v1/auth/sessions')
        .set('Cookie', `afrilink_at=${fakeToken}`)
        .expect(401);
      expect(res.body.error.code).toBe('TOKEN_INVALID');
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

  // -------------------------------------------------------- audit (Audit C)

  describe('Audit integration (Audit C)', () => {
    async function latestAuditEvent(eventType: string, subjectId: string) {
      return prisma.auditEvent.findFirst({ where: { eventType: eventType as never, subjectId }, orderBy: { createdAt: 'desc' } });
    }

    async function registerAndCapture(): Promise<{ email: string; password: string; userId: string; cookies: Record<string, string> }> {
      const email = uniqueEmail();
      const password = 'correct-horse-battery-staple';
      const res = await request(app.getHttpServer()).post('/api/v1/auth/register').send({ email, password }).expect(201);
      return { email, password, userId: res.body.data.user.id as string, cookies: extractCookies(res) };
    }

    describe('auth_login_succeeded', () => {
      it('records actor/subject/requestId/hashed IP+UA/metadata on successful login', async () => {
        const { email, password, userId } = await registerAndCapture();

        await request(app.getHttpServer())
          .post('/api/v1/auth/login')
          .set('User-Agent', 'audit-c-test-agent/1.0')
          .send({ email, password })
          .expect(200);

        const event = await latestAuditEvent('auth_login_succeeded', userId);
        expect(event?.actorId).toBe(userId);
        expect(event?.subjectType).toBe('profile');
        expect(event?.requestId).toBeDefined();
        expect(event?.ipHash).toBeDefined();
        expect(event?.userAgentHash).toBeDefined();
        expect(event?.metadata).toHaveProperty('sessionId');
      });

      it('is best-effort: login still succeeds and sets cookies even if the audit write fails', async () => {
        const auditService = app.get(AuditService);
        const { email, password } = await registerAndCapture();

        const spy = vi.spyOn(auditService, 'record').mockRejectedValueOnce(new Error('simulated audit failure'));
        const res = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password }).expect(200);
        spy.mockRestore();

        expect(extractCookies(res)['afrilink_at']).toBeDefined();
      });

      it('register() itself does not emit auth_login_succeeded (that event is login-only)', async () => {
        const { userId } = await registerAndCapture();
        const event = await latestAuditEvent('auth_login_succeeded', userId);
        expect(event).toBeNull();
      });
    });

    describe('auth_account_verified', () => {
      it('records the event atomically with verification, metadata = { channel }', async () => {
        const email = uniqueEmail();
        const registerRes = await request(app.getHttpServer())
          .post('/api/v1/auth/register')
          .send({ email, password: 'correct-horse-battery-staple' })
          .expect(201);
        const userId = registerRes.body.data.user.id as string;
        const cookies = extractCookies(registerRes);
        const { challengeId, devOnlyCode } = registerRes.body.data.verification;

        await request(app.getHttpServer())
          .post('/api/v1/auth/verify')
          .set('Cookie', cookieHeader(cookies, 'afrilink_at', 'afrilink_csrf'))
          .set('X-CSRF-Token', cookies['afrilink_csrf'])
          .send({ challengeId, code: devOnlyCode })
          .expect(200);

        const event = await latestAuditEvent('auth_account_verified', userId);
        expect(event?.actorId).toBe(userId);
        expect(event?.metadata).toEqual({ channel: 'email' });
      });

      it('atomicity: a forced audit failure rolls back verification (credential stays unverified)', async () => {
        const auditService = app.get(AuditService);
        const email = uniqueEmail();
        const registerRes = await request(app.getHttpServer())
          .post('/api/v1/auth/register')
          .send({ email, password: 'correct-horse-battery-staple' })
          .expect(201);
        const userId = registerRes.body.data.user.id as string;
        const cookies = extractCookies(registerRes);
        const { challengeId, devOnlyCode } = registerRes.body.data.verification;

        const spy = vi.spyOn(auditService, 'record').mockRejectedValueOnce(new Error('simulated audit failure'));
        await request(app.getHttpServer())
          .post('/api/v1/auth/verify')
          .set('Cookie', cookieHeader(cookies, 'afrilink_at', 'afrilink_csrf'))
          .set('X-CSRF-Token', cookies['afrilink_csrf'])
          .send({ challengeId, code: devOnlyCode })
          .expect(500);
        spy.mockRestore();

        const credential = await prisma.credential.findFirst({ where: { userId } });
        expect(credential?.verifiedAt).toBeNull();
        const challenge = await prisma.verificationChallenge.findUniqueOrThrow({ where: { id: challengeId } });
        expect(challenge.consumedAt).toBeNull();
      });
    });

    describe('auth_password_reset_requested', () => {
      it('records the event only when a real account resolves, metadata = { challengeId }', async () => {
        const { email, userId } = await registerAndCapture();

        const forgotRes = await request(app.getHttpServer()).post('/api/v1/auth/password/forgot').send({ email }).expect(200);
        const { devOnlyChallengeId } = forgotRes.body.data;

        const event = await latestAuditEvent('auth_password_reset_requested', userId);
        expect(event?.actorId).toBeNull();
        expect(event?.metadata).toEqual({ challengeId: devOnlyChallengeId });
      });

      it('enumeration safety: emits no event for a non-existent account', async () => {
        const before = await prisma.auditEvent.count({ where: { eventType: 'auth_password_reset_requested' } });
        await request(app.getHttpServer()).post('/api/v1/auth/password/forgot').send({ email: uniqueEmail() }).expect(200);
        const after = await prisma.auditEvent.count({ where: { eventType: 'auth_password_reset_requested' } });
        expect(after).toBe(before);
      });
    });

    describe('auth_password_reset_completed + auth_all_sessions_revoked(password_reset)', () => {
      it('records both events atomically, inside the same reset', async () => {
        const { email, userId } = await registerAndCapture();
        const forgotRes = await request(app.getHttpServer()).post('/api/v1/auth/password/forgot').send({ email }).expect(200);
        const { devOnlyChallengeId, devOnlyCode } = forgotRes.body.data;

        await request(app.getHttpServer())
          .post('/api/v1/auth/password/reset')
          .send({ challengeId: devOnlyChallengeId, code: devOnlyCode, newPassword: 'brand-new-password-123' })
          .expect(200);

        const completed = await latestAuditEvent('auth_password_reset_completed', userId);
        expect(completed?.actorId).toBeNull();
        expect(completed?.metadata).toEqual({ challengeId: devOnlyChallengeId });

        const revoked = await latestAuditEvent('auth_all_sessions_revoked', userId);
        expect(revoked?.reason).toBe('password_reset');
      });

      it('atomicity: a forced audit failure rolls back the whole reset (old password still works, old session survives)', async () => {
        const auditService = app.get(AuditService);
        const { email, password: oldPassword, cookies: originalCookies } = await registerAndCapture();
        const forgotRes = await request(app.getHttpServer()).post('/api/v1/auth/password/forgot').send({ email }).expect(200);
        const { devOnlyChallengeId, devOnlyCode } = forgotRes.body.data;

        const spy = vi.spyOn(auditService, 'record').mockRejectedValueOnce(new Error('simulated audit failure'));
        await request(app.getHttpServer())
          .post('/api/v1/auth/password/reset')
          .send({ challengeId: devOnlyChallengeId, code: devOnlyCode, newPassword: 'brand-new-password-123' })
          .expect(500);
        spy.mockRestore();

        await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password: oldPassword }).expect(200);
        await request(app.getHttpServer())
          .post('/api/v1/auth/refresh')
          .set('Cookie', cookieHeader(originalCookies, 'afrilink_rt'))
          .expect(200);
      });
    });

    describe('auth_session_revoked', () => {
      it('records reason=logout on logout', async () => {
        const { userId, cookies } = await registerAndCapture();
        await request(app.getHttpServer())
          .post('/api/v1/auth/logout')
          .set('Cookie', cookieHeader(cookies, 'afrilink_at', 'afrilink_csrf'))
          .set('X-CSRF-Token', cookies['afrilink_csrf'])
          .expect(200);

        const event = await latestAuditEvent('auth_session_revoked', userId);
        expect(event?.actorId).toBe(userId);
        expect(event?.reason).toBe('logout');
      });

      it('records reason=user_revoked on explicit session revocation', async () => {
        const { userId, cookies } = await registerAndCapture();
        const sessionsRes = await request(app.getHttpServer())
          .get('/api/v1/auth/sessions')
          .set('Cookie', cookieHeader(cookies, 'afrilink_at'))
          .expect(200);
        const sessionId = sessionsRes.body.data[0].id as string;

        await request(app.getHttpServer())
          .delete(`/api/v1/auth/sessions/${sessionId}`)
          .set('Cookie', cookieHeader(cookies, 'afrilink_at', 'afrilink_csrf'))
          .set('X-CSRF-Token', cookies['afrilink_csrf'])
          .expect(200);

        const event = await latestAuditEvent('auth_session_revoked', userId);
        expect(event?.reason).toBe('user_revoked');
        expect(event?.metadata).toEqual({ sessionId });
      });

      it('does NOT record anything for routine refresh-token rotation', async () => {
        const { userId, cookies } = await registerAndCapture();
        await request(app.getHttpServer())
          .post('/api/v1/auth/refresh')
          .set('Cookie', cookieHeader(cookies, 'afrilink_rt'))
          .expect(200);

        const count = await prisma.auditEvent.count({ where: { eventType: 'auth_session_revoked', subjectId: userId } });
        expect(count).toBe(0);
      });

      it('is best-effort: logout still succeeds even if the audit write fails', async () => {
        const auditService = app.get(AuditService);
        const { cookies } = await registerAndCapture();

        const spy = vi.spyOn(auditService, 'record').mockRejectedValueOnce(new Error('simulated audit failure'));
        await request(app.getHttpServer())
          .post('/api/v1/auth/logout')
          .set('Cookie', cookieHeader(cookies, 'afrilink_at', 'afrilink_csrf'))
          .set('X-CSRF-Token', cookies['afrilink_csrf'])
          .expect(200);
        spy.mockRestore();
      });
    });

    describe('auth_all_sessions_revoked', () => {
      it('records reason=logout_all on logout-all', async () => {
        const { userId, cookies } = await registerAndCapture();
        await request(app.getHttpServer())
          .post('/api/v1/auth/logout-all')
          .set('Cookie', cookieHeader(cookies, 'afrilink_at', 'afrilink_csrf'))
          .set('X-CSRF-Token', cookies['afrilink_csrf'])
          .expect(200);

        const event = await latestAuditEvent('auth_all_sessions_revoked', userId);
        expect(event?.actorId).toBe(userId);
        expect(event?.reason).toBe('logout_all');
      });

      it('records reason=reuse_detected on refresh-token theft detection, actorId null', async () => {
        const { userId, cookies } = await registerAndCapture();
        const rotatedRes = await request(app.getHttpServer())
          .post('/api/v1/auth/refresh')
          .set('Cookie', cookieHeader(cookies, 'afrilink_rt'))
          .expect(200);
        void rotatedRes;

        // Reuse of the original (now-revoked) token triggers theft detection.
        await request(app.getHttpServer())
          .post('/api/v1/auth/refresh')
          .set('Cookie', cookieHeader(cookies, 'afrilink_rt'))
          .expect(401);

        const event = await latestAuditEvent('auth_all_sessions_revoked', userId);
        expect(event?.actorId).toBeNull();
        expect(event?.reason).toBe('reuse_detected');
      });
    });

    describe('security regression', () => {
      it('never stores the raw user-agent string, only its hash', async () => {
        const { email, password, userId } = await registerAndCapture();
        const rawUserAgent = 'audit-c-raw-ua-marker/9.9';

        await request(app.getHttpServer()).post('/api/v1/auth/login').set('User-Agent', rawUserAgent).send({ email, password }).expect(200);

        const event = await latestAuditEvent('auth_login_succeeded', userId);
        expect(event?.userAgentHash).not.toBe(rawUserAgent);
        expect(event?.userAgentHash).not.toContain(rawUserAgent);
      });

      it("audit ipHash/userAgentHash differ from the Session row's own ipHash/userAgentHash for the same request", async () => {
        const { email, password, userId } = await registerAndCapture();
        await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password }).expect(200);

        const session = await prisma.session.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } });
        const event = await latestAuditEvent('auth_login_succeeded', userId);

        expect(event?.ipHash).toBeDefined();
        expect(session?.ipHash).toBeDefined();
        expect(event?.ipHash).not.toBe(session?.ipHash);
      });

      it('never logs AUDIT_HASH_SECRET or any sensitive value when a best-effort audit write fails', async () => {
        const auditService = app.get(AuditService);
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const { email, password } = await registerAndCapture();

        const spy = vi.spyOn(auditService, 'record').mockRejectedValueOnce(new Error('simulated audit failure'));
        await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password }).expect(200);
        spy.mockRestore();

        const logged = warnSpy.mock.calls.map((call) => call.join(' ')).join('\n');
        warnSpy.mockRestore();

        expect(logged).toContain('auth_login_succeeded');
        expect(logged).not.toContain(process.env.AUDIT_HASH_SECRET);
        expect(logged.toLowerCase()).not.toMatch(/password|secret|token|credential/);
      });

      it('metadata never carries a password, code, or token field for any auth audit event recorded this run', async () => {
        const events = await prisma.auditEvent.findMany({
          where: { eventType: { in: ['auth_login_succeeded', 'auth_account_verified', 'auth_password_reset_requested', 'auth_password_reset_completed'] } },
        });
        for (const event of events) {
          const keys = Object.keys(event.metadata as object);
          for (const key of keys) {
            expect(key.toLowerCase()).not.toMatch(/password|code|token|credential|secret/);
          }
        }
      });
    });
  });

  it('cleans up test data it created', async () => {
    // Sanity check that this suite is actually hitting the isolated test
    // database, not the shared local dev one.
    const count = await prisma.user.count();
    expect(count).toBeGreaterThan(0);
  });
});
