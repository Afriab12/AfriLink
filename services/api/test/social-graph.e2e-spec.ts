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

describe('Social graph (e2e)', () => {
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

  function auth(u: { cookies: Record<string, string> }) {
    return { Cookie: cookieHeader(u.cookies, 'afrilink_at', 'afrilink_csrf'), 'X-CSRF-Token': u.cookies['afrilink_csrf'] };
  }

  // ============================================================
  // Follows
  // ============================================================

  describe('Follow / unfollow', () => {
    it('follows successfully and appears in both lists', async () => {
      const a = await registerUser();
      const b = await registerUser();

      await request(app.getHttpServer()).post(`/api/v1/users/${b.userId}/follow`).set(auth(a)).expect(201);

      const followers = await request(app.getHttpServer()).get(`/api/v1/users/${b.userId}/followers`).expect(200);
      expect(followers.body.data.map((f: { userId: string }) => f.userId)).toContain(a.userId);

      const following = await request(app.getHttpServer()).get(`/api/v1/users/${a.userId}/following`).expect(200);
      expect(following.body.data.map((f: { userId: string }) => f.userId)).toContain(b.userId);
    });

    it('rejects self-follow with 422 POLICY_REJECTED', async () => {
      const a = await registerUser();
      const res = await request(app.getHttpServer()).post(`/api/v1/users/${a.userId}/follow`).set(auth(a)).expect(422);
      expect(res.body.error.code).toBe('POLICY_REJECTED');
    });

    it('is idempotent — following twice does not error or duplicate', async () => {
      const a = await registerUser();
      const b = await registerUser();

      await request(app.getHttpServer()).post(`/api/v1/users/${b.userId}/follow`).set(auth(a)).expect(201);
      await request(app.getHttpServer()).post(`/api/v1/users/${b.userId}/follow`).set(auth(a)).expect(201);

      const count = await prisma.follow.count({ where: { followerId: a.userId, followeeId: b.userId, deletedAt: null } });
      expect(count).toBe(1);
    });

    it('unfollow is idempotent and removes the relationship', async () => {
      const a = await registerUser();
      const b = await registerUser();
      await request(app.getHttpServer()).post(`/api/v1/users/${b.userId}/follow`).set(auth(a));

      await request(app.getHttpServer()).delete(`/api/v1/users/${b.userId}/follow`).set(auth(a)).expect(200);
      // Idempotent — unfollowing again is still a success, not an error.
      await request(app.getHttpServer()).delete(`/api/v1/users/${b.userId}/follow`).set(auth(a)).expect(200);

      const followers = await request(app.getHttpServer()).get(`/api/v1/users/${b.userId}/followers`).expect(200);
      expect(followers.body.data.map((f: { userId: string }) => f.userId)).not.toContain(a.userId);
    });

    it('returns 404 following a nonexistent user', async () => {
      const a = await registerUser();
      await request(app.getHttpServer()).post(`/api/v1/users/${randomUUID()}/follow`).set(auth(a)).expect(404);
    });

    it('requires authentication and CSRF', async () => {
      const b = await registerUser();
      await request(app.getHttpServer()).post(`/api/v1/users/${b.userId}/follow`).expect(401);

      const a = await registerUser();
      await request(app.getHttpServer())
        .post(`/api/v1/users/${b.userId}/follow`)
        .set('Cookie', cookieHeader(a.cookies, 'afrilink_at', 'afrilink_csrf'))
        .expect(403);
    });
  });

  describe('Follower/following list visibility', () => {
    it('hides lists for a private profile from non-owners, shows to the owner', async () => {
      const owner = await registerUser();
      const other = await registerUser();
      await request(app.getHttpServer())
        .patch('/api/v1/me/profile')
        .set(auth(owner))
        .send({ visibility: 'private' })
        .expect(200);

      await request(app.getHttpServer()).get(`/api/v1/users/${owner.userId}/followers`).expect(404);
      await request(app.getHttpServer())
        .get(`/api/v1/users/${owner.userId}/followers`)
        .set('Cookie', cookieHeader(other.cookies, 'afrilink_at'))
        .expect(404);
      await request(app.getHttpServer())
        .get(`/api/v1/users/${owner.userId}/followers`)
        .set('Cookie', cookieHeader(owner.cookies, 'afrilink_at'))
        .expect(200);
    });
  });

  // ============================================================
  // Friendships
  // ============================================================

  describe('Friend requests', () => {
    it('sends, lists as incoming/outgoing, and accepts', async () => {
      const a = await registerUser();
      const b = await registerUser();

      const sendRes = await request(app.getHttpServer())
        .post(`/api/v1/users/${b.userId}/friend-requests`)
        .set(auth(a))
        .expect(201);
      const friendshipId = sendRes.body.data.id as string;
      expect(sendRes.body.data.status).toBe('pending');

      const outgoing = await request(app.getHttpServer())
        .get('/api/v1/me/friend-requests?direction=outgoing')
        .set('Cookie', cookieHeader(a.cookies, 'afrilink_at'))
        .expect(200);
      expect(outgoing.body.data.map((f: { id: string }) => f.id)).toContain(friendshipId);

      const incoming = await request(app.getHttpServer())
        .get('/api/v1/me/friend-requests?direction=incoming')
        .set('Cookie', cookieHeader(b.cookies, 'afrilink_at'))
        .expect(200);
      expect(incoming.body.data.map((f: { id: string }) => f.id)).toContain(friendshipId);

      const acceptRes = await request(app.getHttpServer())
        .post(`/api/v1/friend-requests/${friendshipId}/accept`)
        .set(auth(b))
        .expect(200);
      expect(acceptRes.body.data.status).toBe('accepted');
    });

    it('rejects a self-request with 422 POLICY_REJECTED', async () => {
      const a = await registerUser();
      const res = await request(app.getHttpServer())
        .post(`/api/v1/users/${a.userId}/friend-requests`)
        .set(auth(a))
        .expect(422);
      expect(res.body.error.code).toBe('POLICY_REJECTED');
    });

    it('rejects a duplicate request in the SAME direction with 409', async () => {
      const a = await registerUser();
      const b = await registerUser();
      await request(app.getHttpServer()).post(`/api/v1/users/${b.userId}/friend-requests`).set(auth(a)).expect(201);
      const res = await request(app.getHttpServer())
        .post(`/api/v1/users/${b.userId}/friend-requests`)
        .set(auth(a))
        .expect(409);
      expect(res.body.error.code).toBe('CONFLICT');
    });

    it('rejects a duplicate request in the REVERSE direction with 409 (unordered-pair uniqueness)', async () => {
      const a = await registerUser();
      const b = await registerUser();
      await request(app.getHttpServer()).post(`/api/v1/users/${b.userId}/friend-requests`).set(auth(a)).expect(201);
      // B tries to friend-request A while A's request to B is still pending.
      const res = await request(app.getHttpServer())
        .post(`/api/v1/users/${a.userId}/friend-requests`)
        .set(auth(b))
        .expect(409);
      expect(res.body.error.code).toBe('CONFLICT');
    });

    it('only the addressee can accept or decline; only the requester can cancel', async () => {
      const a = await registerUser();
      const b = await registerUser();
      const c = await registerUser();
      const sendRes = await request(app.getHttpServer())
        .post(`/api/v1/users/${b.userId}/friend-requests`)
        .set(auth(a))
        .expect(201);
      const id = sendRes.body.data.id as string;

      // Requester cannot accept their own outgoing request.
      await request(app.getHttpServer()).post(`/api/v1/friend-requests/${id}/accept`).set(auth(a)).expect(404);
      // An unrelated third party cannot act on it either.
      await request(app.getHttpServer()).post(`/api/v1/friend-requests/${id}/accept`).set(auth(c)).expect(404);
      // The addressee can cancel? No — cancel is requester-only.
      await request(app.getHttpServer()).delete(`/api/v1/friend-requests/${id}`).set(auth(b)).expect(404);
    });

    it('declining allows a fresh request afterward (terminal state does not block re-request)', async () => {
      const a = await registerUser();
      const b = await registerUser();
      const first = await request(app.getHttpServer()).post(`/api/v1/users/${b.userId}/friend-requests`).set(auth(a)).expect(201);
      await request(app.getHttpServer())
        .post(`/api/v1/friend-requests/${first.body.data.id}/decline`)
        .set(auth(b))
        .expect(200);

      // A new request between the same pair is now allowed.
      await request(app.getHttpServer()).post(`/api/v1/users/${b.userId}/friend-requests`).set(auth(a)).expect(201);
    });

    it('cancelling a pending request removes it and it can no longer be accepted', async () => {
      const a = await registerUser();
      const b = await registerUser();
      const sendRes = await request(app.getHttpServer()).post(`/api/v1/users/${b.userId}/friend-requests`).set(auth(a)).expect(201);
      const id = sendRes.body.data.id as string;

      await request(app.getHttpServer()).delete(`/api/v1/friend-requests/${id}`).set(auth(a)).expect(200);
      await request(app.getHttpServer()).post(`/api/v1/friend-requests/${id}/accept`).set(auth(b)).expect(404);
    });

    it('removing an accepted friendship ends it, and a new request can be sent afterward', async () => {
      const a = await registerUser();
      const b = await registerUser();
      const sendRes = await request(app.getHttpServer()).post(`/api/v1/users/${b.userId}/friend-requests`).set(auth(a)).expect(201);
      const id = sendRes.body.data.id as string;
      await request(app.getHttpServer()).post(`/api/v1/friend-requests/${id}/accept`).set(auth(b)).expect(200);

      await request(app.getHttpServer()).delete(`/api/v1/friendships/${id}`).set(auth(b)).expect(200);

      const aFriends = await request(app.getHttpServer())
        .get(`/api/v1/users/${a.userId}/friends`)
        .set('Cookie', cookieHeader(a.cookies, 'afrilink_at'))
        .expect(200);
      expect(aFriends.body.data.map((f: { userId: string }) => f.userId)).not.toContain(b.userId);

      await request(app.getHttpServer()).post(`/api/v1/users/${b.userId}/friend-requests`).set(auth(a)).expect(201);
    });

    it('friend-requesting a blocked user returns 404', async () => {
      const a = await registerUser();
      const b = await registerUser();
      await request(app.getHttpServer()).post(`/api/v1/users/${b.userId}/block`).set(auth(a)).expect(201);
      await request(app.getHttpServer()).post(`/api/v1/users/${a.userId}/friend-requests`).set(auth(b)).expect(404);
    });
  });

  describe('Friends list privacy', () => {
    it('is hidden from non-owners by default, visible to the owner always', async () => {
      const a = await registerUser();
      const b = await registerUser();
      const other = await registerUser();
      const sendRes = await request(app.getHttpServer()).post(`/api/v1/users/${b.userId}/friend-requests`).set(auth(a)).expect(201);
      await request(app.getHttpServer()).post(`/api/v1/friend-requests/${sendRes.body.data.id}/accept`).set(auth(b)).expect(200);

      // Default friendListVisible = false.
      await request(app.getHttpServer())
        .get(`/api/v1/users/${a.userId}/friends`)
        .set('Cookie', cookieHeader(other.cookies, 'afrilink_at'))
        .expect(404);

      await request(app.getHttpServer())
        .get(`/api/v1/users/${a.userId}/friends`)
        .set('Cookie', cookieHeader(a.cookies, 'afrilink_at'))
        .expect(200);
    });

    it('is visible to others once friendListVisible is set (no dedicated preferences endpoint yet — set directly)', async () => {
      const a = await registerUser();
      const b = await registerUser();
      const other = await registerUser();
      const sendRes = await request(app.getHttpServer()).post(`/api/v1/users/${b.userId}/friend-requests`).set(auth(a)).expect(201);
      await request(app.getHttpServer()).post(`/api/v1/friend-requests/${sendRes.body.data.id}/accept`).set(auth(b)).expect(200);

      await prisma.userPreference.upsert({
        where: { userId: a.userId },
        update: { friendListVisible: true },
        create: { userId: a.userId, friendListVisible: true },
      });

      const res = await request(app.getHttpServer())
        .get(`/api/v1/users/${a.userId}/friends`)
        .set('Cookie', cookieHeader(other.cookies, 'afrilink_at'))
        .expect(200);
      expect(res.body.data.map((f: { userId: string }) => f.userId)).toContain(b.userId);
    });
  });

  // ============================================================
  // Blocks
  // ============================================================

  describe('Block / unblock', () => {
    it('blocks successfully, is idempotent, and appears in the blocker\'s list only', async () => {
      const a = await registerUser();
      const b = await registerUser();

      await request(app.getHttpServer()).post(`/api/v1/users/${b.userId}/block`).set(auth(a)).expect(201);
      await request(app.getHttpServer()).post(`/api/v1/users/${b.userId}/block`).set(auth(a)).expect(201); // idempotent

      const count = await prisma.block.count({ where: { blockerId: a.userId, blockedId: b.userId, deletedAt: null } });
      expect(count).toBe(1);

      const blocks = await request(app.getHttpServer()).get('/api/v1/me/blocks').set('Cookie', cookieHeader(a.cookies, 'afrilink_at')).expect(200);
      expect(blocks.body.data.map((x: { userId: string }) => x.userId)).toContain(b.userId);

      // B's own block list must NOT show A (B didn't block anyone).
      const bBlocks = await request(app.getHttpServer()).get('/api/v1/me/blocks').set('Cookie', cookieHeader(b.cookies, 'afrilink_at')).expect(200);
      expect(bBlocks.body.data).toHaveLength(0);
    });

    it('rejects self-block with 422 POLICY_REJECTED', async () => {
      const a = await registerUser();
      const res = await request(app.getHttpServer()).post(`/api/v1/users/${a.userId}/block`).set(auth(a)).expect(422);
      expect(res.body.error.code).toBe('POLICY_REJECTED');
    });

    it('unblock is idempotent and removes the block', async () => {
      const a = await registerUser();
      const b = await registerUser();
      await request(app.getHttpServer()).post(`/api/v1/users/${b.userId}/block`).set(auth(a)).expect(201);

      await request(app.getHttpServer()).delete(`/api/v1/users/${b.userId}/block`).set(auth(a)).expect(200);
      await request(app.getHttpServer()).delete(`/api/v1/users/${b.userId}/block`).set(auth(a)).expect(200); // idempotent

      const count = await prisma.block.count({ where: { blockerId: a.userId, blockedId: b.userId, deletedAt: null } });
      expect(count).toBe(0);
    });

    it('blocking cascades: severs an existing active follow in both directions', async () => {
      const a = await registerUser();
      const b = await registerUser();
      await request(app.getHttpServer()).post(`/api/v1/users/${b.userId}/follow`).set(auth(a)).expect(201);
      await request(app.getHttpServer()).post(`/api/v1/users/${a.userId}/follow`).set(auth(b)).expect(201);

      await request(app.getHttpServer()).post(`/api/v1/users/${b.userId}/block`).set(auth(a)).expect(201);

      const aFollowsCount = await prisma.follow.count({ where: { followerId: a.userId, followeeId: b.userId, deletedAt: null } });
      const bFollowsCount = await prisma.follow.count({ where: { followerId: b.userId, followeeId: a.userId, deletedAt: null } });
      expect(aFollowsCount).toBe(0);
      expect(bFollowsCount).toBe(0);
    });

    it('blocking cascades: ends an existing accepted friendship', async () => {
      const a = await registerUser();
      const b = await registerUser();
      const sendRes = await request(app.getHttpServer()).post(`/api/v1/users/${b.userId}/friend-requests`).set(auth(a)).expect(201);
      await request(app.getHttpServer()).post(`/api/v1/friend-requests/${sendRes.body.data.id}/accept`).set(auth(b)).expect(200);

      await request(app.getHttpServer()).post(`/api/v1/users/${b.userId}/block`).set(auth(a)).expect(201);

      const friendship = await prisma.friendship.findUnique({ where: { id: sendRes.body.data.id } });
      expect(friendship?.status).toBe('removed');
    });

    it('a block suppresses profile/list visibility in both directions', async () => {
      const a = await registerUser();
      const b = await registerUser();
      await request(app.getHttpServer()).post(`/api/v1/users/${b.userId}/block`).set(auth(a)).expect(201);

      // Blocked party cannot view the blocker's profile.
      await request(app.getHttpServer())
        .get(`/api/v1/profiles/${a.userId}`)
        .set('Cookie', cookieHeader(b.cookies, 'afrilink_at'))
        .expect(404);
      // Blocker cannot view the blocked party's profile either — symmetric.
      await request(app.getHttpServer())
        .get(`/api/v1/profiles/${b.userId}`)
        .set('Cookie', cookieHeader(a.cookies, 'afrilink_at'))
        .expect(404);
    });

    it('returns 404 blocking a nonexistent user', async () => {
      const a = await registerUser();
      await request(app.getHttpServer()).post(`/api/v1/users/${randomUUID()}/block`).set(auth(a)).expect(404);
    });

    it('requires authentication and CSRF', async () => {
      const b = await registerUser();
      await request(app.getHttpServer()).post(`/api/v1/users/${b.userId}/block`).expect(401);

      const a = await registerUser();
      await request(app.getHttpServer())
        .post(`/api/v1/users/${b.userId}/block`)
        .set('Cookie', cookieHeader(a.cookies, 'afrilink_at', 'afrilink_csrf'))
        .expect(403);
    });
  });
});
