import 'reflect-metadata';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { PrismaService } from '../src/common/prisma/prisma.service';

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

describe('Profiles (e2e)', () => {
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

  async function registerUser(): Promise<{ userId: string; cookies: Record<string, string> }> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email: uniqueEmail(), password: 'correct-horse-battery-staple' })
      .expect(201);
    return { userId: res.body.data.user.id as string, cookies: extractCookies(res) };
  }

  describe('GET /me/profile', () => {
    it('requires authentication', async () => {
      await request(app.getHttpServer()).get('/api/v1/me/profile').expect(401);
    });

    it('lazily creates a default profile on first access', async () => {
      const { cookies } = await registerUser();

      const res = await request(app.getHttpServer())
        .get('/api/v1/me/profile')
        .set('Cookie', cookieHeader(cookies, 'afrilink_at'))
        .expect(200);

      expect(res.body.data.displayName).toBeNull();
      expect(res.body.data.visibility).toBe('public');
      expect(res.body.data.primaryLanguage).toBe('en');
      expect(res.body.data.avatarMediaId).toBeUndefined();
      expect(res.body.data.profileMetadata).toBeUndefined();
    });
  });

  describe('PATCH /me/profile', () => {
    it('updates allowed fields and persists them', async () => {
      const { cookies } = await registerUser();

      await request(app.getHttpServer())
        .patch('/api/v1/me/profile')
        .set('Cookie', cookieHeader(cookies, 'afrilink_at', 'afrilink_csrf'))
        .set('X-CSRF-Token', cookies['afrilink_csrf'])
        .send({ displayName: 'Ada', bio: 'Building things', countryCode: 'ng', visibility: 'followers' })
        .expect(200);

      const res = await request(app.getHttpServer())
        .get('/api/v1/me/profile')
        .set('Cookie', cookieHeader(cookies, 'afrilink_at'))
        .expect(200);

      expect(res.body.data.displayName).toBe('Ada');
      expect(res.body.data.bio).toBe('Building things');
      expect(res.body.data.countryCode).toBe('NG'); // normalized uppercase
      expect(res.body.data.visibility).toBe('followers');
    });

    it('rejects an inactive/unknown country code', async () => {
      const { cookies } = await registerUser();

      const res = await request(app.getHttpServer())
        .patch('/api/v1/me/profile')
        .set('Cookie', cookieHeader(cookies, 'afrilink_at', 'afrilink_csrf'))
        .set('X-CSRF-Token', cookies['afrilink_csrf'])
        .send({ countryCode: 'ZZ' })
        .expect(422);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('rejects an invalid visibility value', async () => {
      const { cookies } = await registerUser();

      await request(app.getHttpServer())
        .patch('/api/v1/me/profile')
        .set('Cookie', cookieHeader(cookies, 'afrilink_at', 'afrilink_csrf'))
        .set('X-CSRF-Token', cookies['afrilink_csrf'])
        .send({ visibility: 'friends-only' })
        .expect(422);
    });

    it('rejects mass-assignment of avatarMediaId and profileMetadata', async () => {
      const { cookies } = await registerUser();

      const res = await request(app.getHttpServer())
        .patch('/api/v1/me/profile')
        .set('Cookie', cookieHeader(cookies, 'afrilink_at', 'afrilink_csrf'))
        .set('X-CSRF-Token', cookies['afrilink_csrf'])
        .send({ avatarMediaId: randomUUID(), profileMetadata: { admin: true } })
        .expect(422);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('requires authentication and CSRF', async () => {
      await request(app.getHttpServer()).patch('/api/v1/me/profile').send({ displayName: 'x' }).expect(401);

      const { cookies } = await registerUser();
      await request(app.getHttpServer())
        .patch('/api/v1/me/profile')
        .set('Cookie', cookieHeader(cookies, 'afrilink_at', 'afrilink_csrf'))
        // no X-CSRF-Token header
        .send({ displayName: 'x' })
        .expect(403);
    });

    it("never affects another user's profile", async () => {
      const a = await registerUser();
      const b = await registerUser();

      await request(app.getHttpServer())
        .patch('/api/v1/me/profile')
        .set('Cookie', cookieHeader(a.cookies, 'afrilink_at', 'afrilink_csrf'))
        .set('X-CSRF-Token', a.cookies['afrilink_csrf'])
        .send({ displayName: 'Only A' })
        .expect(200);

      const bProfile = await request(app.getHttpServer()).get(`/api/v1/profiles/${b.userId}`).expect(200);
      expect(bProfile.body.data.displayName).toBeNull();
    });
  });

  describe('GET /profiles/:userIdOrHandle — visibility enforcement', () => {
    it('is visible anonymously when public (the default)', async () => {
      const { userId, cookies } = await registerUser();
      await request(app.getHttpServer())
        .patch('/api/v1/me/profile')
        .set('Cookie', cookieHeader(cookies, 'afrilink_at', 'afrilink_csrf'))
        .set('X-CSRF-Token', cookies['afrilink_csrf'])
        .send({ displayName: 'Public Person' })
        .expect(200);

      const res = await request(app.getHttpServer()).get(`/api/v1/profiles/${userId}`).expect(200);
      expect(res.body.data.displayName).toBe('Public Person');
    });

    it('returns a default view for a user whose profile was never touched, without creating a row', async () => {
      const { userId } = await registerUser();

      const before = await prisma.profile.count({ where: { userId } });
      expect(before).toBe(0);

      const res = await request(app.getHttpServer()).get(`/api/v1/profiles/${userId}`).expect(200);
      expect(res.body.data.visibility).toBe('public');
      expect(res.body.data.displayName).toBeNull();

      const after = await prisma.profile.count({ where: { userId } });
      expect(after).toBe(0);
    });

    it('hides a private profile from anonymous viewers and other users, shows it to the owner', async () => {
      const owner = await registerUser();
      const other = await registerUser();

      await request(app.getHttpServer())
        .patch('/api/v1/me/profile')
        .set('Cookie', cookieHeader(owner.cookies, 'afrilink_at', 'afrilink_csrf'))
        .set('X-CSRF-Token', owner.cookies['afrilink_csrf'])
        .send({ visibility: 'private' })
        .expect(200);

      await request(app.getHttpServer()).get(`/api/v1/profiles/${owner.userId}`).expect(404);

      await request(app.getHttpServer())
        .get(`/api/v1/profiles/${owner.userId}`)
        .set('Cookie', cookieHeader(other.cookies, 'afrilink_at'))
        .expect(404);

      await request(app.getHttpServer())
        .get(`/api/v1/profiles/${owner.userId}`)
        .set('Cookie', cookieHeader(owner.cookies, 'afrilink_at'))
        .expect(200);
    });

    it('hides a followers-only profile until an active follow row exists', async () => {
      const owner = await registerUser();
      const follower = await registerUser();

      await request(app.getHttpServer())
        .patch('/api/v1/me/profile')
        .set('Cookie', cookieHeader(owner.cookies, 'afrilink_at', 'afrilink_csrf'))
        .set('X-CSRF-Token', owner.cookies['afrilink_csrf'])
        .send({ visibility: 'followers' })
        .expect(200);

      // No follow module exists yet (out of scope) — seed the relationship
      // directly, matching the already-approved read-only integration.
      await request(app.getHttpServer())
        .get(`/api/v1/profiles/${owner.userId}`)
        .set('Cookie', cookieHeader(follower.cookies, 'afrilink_at'))
        .expect(404);

      await prisma.follow.create({ data: { followerId: follower.userId, followeeId: owner.userId } });

      await request(app.getHttpServer())
        .get(`/api/v1/profiles/${owner.userId}`)
        .set('Cookie', cookieHeader(follower.cookies, 'afrilink_at'))
        .expect(200);
    });

    it('hides a profile across an active block in either direction', async () => {
      const owner = await registerUser(); // public by default
      const blocked = await registerUser();

      await prisma.block.create({ data: { blockerId: owner.userId, blockedId: blocked.userId } });

      await request(app.getHttpServer())
        .get(`/api/v1/profiles/${owner.userId}`)
        .set('Cookie', cookieHeader(blocked.cookies, 'afrilink_at'))
        .expect(404);
    });

    it('resolves by handle as well as by id', async () => {
      const { userId, cookies } = await registerUser();
      const handle = `user_${randomUUID().slice(0, 8)}`;
      // No "set my handle" endpoint exists yet (known limitation) — set
      // directly for this test.
      await prisma.user.update({ where: { id: userId }, data: { handle } });

      const res = await request(app.getHttpServer()).get(`/api/v1/profiles/${handle}`).expect(200);
      expect(res.body.data.userId).toBe(userId);
      void cookies;
    });

    it('returns 404 for a nonexistent user', async () => {
      await request(app.getHttpServer()).get(`/api/v1/profiles/${randomUUID()}`).expect(404);
    });
  });

  describe('GET /countries and GET /interests', () => {
    it('lists only active countries, ADR-003 §7 starter set', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/countries').expect(200);
      expect(res.body.data).toHaveLength(7);
      expect(res.body.data.every((c: { code: string }) => /^[A-Z]{2}$/.test(c.code))).toBe(true);
    });

    it('lists only active interests, ADR-003 §7 starter set', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/interests').expect(200);
      expect(res.body.data).toHaveLength(18);
    });
  });

  describe('Interests selection', () => {
    it('starts empty, can be set, and replaces (not appends) on repeat calls', async () => {
      const { cookies } = await registerUser();
      const allInterests = await request(app.getHttpServer()).get('/api/v1/interests').expect(200);
      const [first, second, third] = allInterests.body.data;

      const empty = await request(app.getHttpServer())
        .get('/api/v1/me/interests')
        .set('Cookie', cookieHeader(cookies, 'afrilink_at'))
        .expect(200);
      expect(empty.body.data).toHaveLength(0);

      await request(app.getHttpServer())
        .put('/api/v1/me/interests')
        .set('Cookie', cookieHeader(cookies, 'afrilink_at', 'afrilink_csrf'))
        .set('X-CSRF-Token', cookies['afrilink_csrf'])
        .send({ interestIds: [first.id, second.id] })
        .expect(200);

      const afterFirstSet = await request(app.getHttpServer())
        .get('/api/v1/me/interests')
        .set('Cookie', cookieHeader(cookies, 'afrilink_at'))
        .expect(200);
      expect(afterFirstSet.body.data.map((i: { id: string }) => i.id).sort()).toEqual([first.id, second.id].sort());

      // Replace, not append.
      await request(app.getHttpServer())
        .put('/api/v1/me/interests')
        .set('Cookie', cookieHeader(cookies, 'afrilink_at', 'afrilink_csrf'))
        .set('X-CSRF-Token', cookies['afrilink_csrf'])
        .send({ interestIds: [third.id] })
        .expect(200);

      const afterReplace = await request(app.getHttpServer())
        .get('/api/v1/me/interests')
        .set('Cookie', cookieHeader(cookies, 'afrilink_at'))
        .expect(200);
      expect(afterReplace.body.data.map((i: { id: string }) => i.id)).toEqual([third.id]);
    });

    it('rejects an unknown interest id', async () => {
      const { cookies } = await registerUser();
      const res = await request(app.getHttpServer())
        .put('/api/v1/me/interests')
        .set('Cookie', cookieHeader(cookies, 'afrilink_at', 'afrilink_csrf'))
        .set('X-CSRF-Token', cookies['afrilink_csrf'])
        .send({ interestIds: [randomUUID()] })
        .expect(422);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('requires authentication', async () => {
      await request(app.getHttpServer()).get('/api/v1/me/interests').expect(401);
      await request(app.getHttpServer()).put('/api/v1/me/interests').send({ interestIds: [] }).expect(401);
    });
  });
});
