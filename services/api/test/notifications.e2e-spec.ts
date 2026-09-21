import 'reflect-metadata';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
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

type TestUser = { userId: string; cookies: Record<string, string> };

// The Notifications API has no producers yet, so every test seeds rows
// directly (approved). `type` is an opaque string: no notification type
// vocabulary exists to close over.
describe('Notifications (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let seq = 0;

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

  async function registerUser(): Promise<TestUser> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email: uniqueEmail(), password: 'correct-horse-battery-staple' })
      .expect(201);
    return { userId: res.body.data.user.id as string, cookies: extractCookies(res) };
  }

  function auth(u: TestUser) {
    return { Cookie: cookieHeader(u.cookies, 'afrilink_at', 'afrilink_csrf'), 'X-CSRF-Token': u.cookies['afrilink_csrf'] };
  }

  interface SeedOptions {
    recipient: string;
    actor?: string | null;
    createdAt?: Date;
    readAt?: Date | null;
    deletedAt?: Date | null;
    dedupKey?: string;
    groupKey?: string;
    target?: { type: string; id: string };
    payload?: Prisma.InputJsonValue;
  }

  // Default createdAt steps backwards one second per seeded row, so rows are
  // strictly ordered unless a test overrides it.
  async function seed(o: SeedOptions) {
    return prisma.notification.create({
      data: {
        recipientUserId: o.recipient,
        actorUserId: o.actor ?? null,
        type: 'test.notification',
        targetType: o.target?.type,
        targetId: o.target?.id,
        groupKey: o.groupKey,
        dedupKey: o.dedupKey,
        payload: o.payload,
        createdAt: o.createdAt ?? new Date(Date.now() - ++seq * 1000),
        readAt: o.readAt ?? null,
        deletedAt: o.deletedAt ?? null,
      },
    });
  }

  async function seedMany(recipient: string, count: number, extra: { actor?: string | null; readAt?: Date | null } = {}) {
    const base = Date.now();
    await prisma.notification.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        recipientUserId: recipient,
        actorUserId: extra.actor ?? null,
        type: 'test.notification',
        createdAt: new Date(base - (++seq + i) * 1000),
        readAt: extra.readAt ?? null,
      })),
    });
  }

  // Not `async`: supertest's Test must stay chainable (`.expect(...)`).
  function list(u: TestUser, query = '') {
    return request(app.getHttpServer()).get(`/api/v1/notifications${query}`).set(auth(u));
  }

  async function listIds(u: TestUser, query = ''): Promise<string[]> {
    const res = await list(u, query).expect(200);
    return res.body.data.map((n: { id: string }) => n.id);
  }

  async function count(u: TestUser) {
    const res = await request(app.getHttpServer()).get('/api/v1/notifications/unread-count').set(auth(u)).expect(200);
    return res.body.data as { count: number; capped: boolean };
  }

  async function walkAllPages(u: TestUser, limit: number): Promise<string[]> {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 50; guard++) {
      const qs: string = `?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res: request.Response = await list(u, qs).expect(200);
      seen.push(...res.body.data.map((n: { id: string }) => n.id));
      if (!res.body.meta.page.hasMore) {
        return seen;
      }
      cursor = res.body.meta.page.nextCursor as string;
    }
    throw new Error('pagination did not terminate');
  }

  async function block(blocker: TestUser, blocked: TestUser) {
    await request(app.getHttpServer()).post(`/api/v1/users/${blocked.userId}/block`).set(auth(blocker)).expect(201);
  }

  async function unblock(blocker: TestUser, blocked: TestUser) {
    await request(app.getHttpServer()).delete(`/api/v1/users/${blocked.userId}/block`).set(auth(blocker)).expect(200);
  }

  // ============================================================
  // GET /notifications
  // ============================================================

  describe('GET /notifications', () => {
    it('requires authentication', async () => {
      await request(app.getHttpServer()).get('/api/v1/notifications').expect(401);
    });

    it('returns an empty page for a user with no notifications', async () => {
      const u = await registerUser();
      const res = await list(u).expect(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.meta.page).toEqual({ nextCursor: null, hasMore: false });
    });

    it('lists newest first, breaking createdAt ties by id descending', async () => {
      const u = await registerUser();
      const t = Date.now() - 60_000;
      const older = await seed({ recipient: u.userId, createdAt: new Date(t) });
      const tieA = await seed({ recipient: u.userId, createdAt: new Date(t + 10_000) });
      const tieB = await seed({ recipient: u.userId, createdAt: new Date(t + 10_000) });
      const newest = await seed({ recipient: u.userId, createdAt: new Date(t + 20_000) });

      const tie = [tieA.id, tieB.id].sort().reverse(); // UUIDv7 ids sort in creation order
      expect(await listIds(u)).toEqual([newest.id, ...tie, older.id]);
    });

    it('paginates with a cursor without skipping or duplicating', async () => {
      const u = await registerUser();
      await seedMany(u.userId, 7);
      const all = await listIds(u);
      expect(all).toHaveLength(7);
      expect(await walkAllPages(u, 1)).toEqual(all);
      expect(await walkAllPages(u, 3)).toEqual(all);
    });

    it('paginates across rows that share a createdAt without skipping or duplicating', async () => {
      const u = await registerUser();
      const same = new Date(Date.now() - 120_000);
      const rows = [];
      for (let i = 0; i < 5; i++) {
        rows.push(await seed({ recipient: u.userId, createdAt: same }));
      }
      const expected = rows.map((r) => r.id).sort().reverse();
      expect(await walkAllPages(u, 1)).toEqual(expected);
      expect(await walkAllPages(u, 2)).toEqual(expected);
    });

    it('clamps an oversized limit to the maximum page size', async () => {
      const u = await registerUser();
      await seedMany(u.userId, 55);
      const res = await list(u, '?limit=500').expect(200);
      expect(res.body.data).toHaveLength(50);
      expect(res.body.meta.page.hasMore).toBe(true);
    });

    it('rejects a malformed cursor with INVALID_CURSOR', async () => {
      const u = await registerUser();
      const res = await list(u, '?cursor=not-a-real-cursor!!').expect(400);
      expect(res.body.error.code).toBe('INVALID_CURSOR');
    });

    it("never returns another user's notifications", async () => {
      const a = await registerUser();
      const b = await registerUser();
      const mine = await seed({ recipient: a.userId });
      const theirs = await seed({ recipient: b.userId });

      expect(await listIds(a)).toEqual([mine.id]);
      expect(await listIds(b)).toEqual([theirs.id]);
    });

    it('excludes dismissed notifications', async () => {
      const u = await registerUser();
      const kept = await seed({ recipient: u.userId });
      await seed({ recipient: u.userId, deletedAt: new Date() });
      expect(await listIds(u)).toEqual([kept.id]);
    });

    it('unread=true returns only unread, non-dismissed notifications', async () => {
      const u = await registerUser();
      const unread = await seed({ recipient: u.userId });
      await seed({ recipient: u.userId, readAt: new Date() });
      await seed({ recipient: u.userId, deletedAt: new Date() });

      expect(await listIds(u, '?unread=true')).toEqual([unread.id]);
      expect(await listIds(u)).toHaveLength(2); // unread + read; the dismissed one stays hidden
    });

    it('accepts only the literal unread=true; anything else is 422', async () => {
      const u = await registerUser();
      for (const bad of ['false', 'yes', '1', 'TRUE', '']) {
        const res = await list(u, `?unread=${bad}`).expect(422);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
        expect(res.body.error.details[0].field).toBe('unread');
      }
    });

    it('includes system notifications that have no actor', async () => {
      const u = await registerUser();
      const system = await seed({ recipient: u.userId, actor: null });
      const res = await list(u).expect(200);
      expect(res.body.data.map((n: { id: string }) => n.id)).toEqual([system.id]);
      expect(res.body.data[0].actor).toBeNull();
    });

    it('returns exactly the documented fields and never internal ones', async () => {
      const u = await registerUser();
      const actor = await registerUser();
      const targetId = randomUUID();
      await seed({
        recipient: u.userId,
        actor: actor.userId,
        target: { type: 'post', id: targetId },
        groupKey: 'post:reactions',
        dedupKey: `dedup-${randomUUID()}`,
        payload: { postTitle: 'hello' },
      });

      const res = await list(u).expect(200);
      const item = res.body.data[0];
      expect(Object.keys(item).sort()).toEqual(
        ['actor', 'createdAt', 'groupKey', 'id', 'payload', 'readAt', 'targetId', 'targetType', 'type'].sort(),
      );
      expect(item).toMatchObject({
        type: 'test.notification',
        targetType: 'post',
        targetId,
        groupKey: 'post:reactions',
        payload: { postTitle: 'hello' },
        readAt: null,
      });
      expect(JSON.stringify(res.body)).not.toContain('dedup-');
      expect(JSON.stringify(res.body)).not.toContain(u.userId); // recipient id is never echoed
    });

    it('sets Cache-Control: private, no-store', async () => {
      const u = await registerUser();
      const res = await list(u).expect(200);
      expect(res.headers['cache-control']).toBe('private, no-store');
    });

    // ---------- actor summary (public-profile-only exposure) ----------

    describe('actor summary', () => {
      async function actorOf(recipient: TestUser, actor: TestUser): Promise<unknown> {
        await seed({ recipient: recipient.userId, actor: actor.userId });
        const res = await list(recipient).expect(200);
        return res.body.data[0].actor;
      }

      it('exposes id, displayName and handle for a public profile', async () => {
        const r = await registerUser();
        const a = await registerUser();
        const handle = `h${randomUUID().replace(/-/g, '').slice(0, 10)}`;
        await prisma.user.update({ where: { id: a.userId }, data: { handle } });
        await prisma.profile.upsert({
          where: { userId: a.userId },
          create: { userId: a.userId, displayName: 'Amina', visibility: 'public' },
          update: { displayName: 'Amina', visibility: 'public' },
        });
        expect(await actorOf(r, a)).toEqual({ id: a.userId, displayName: 'Amina', handle });
      });

      it('treats an actor with no profile row as public (existing visibility rule)', async () => {
        const r = await registerUser();
        const a = await registerUser();
        expect(await actorOf(r, a)).toEqual({ id: a.userId, displayName: null, handle: null });
      });

      it('exposes only the id for a private profile', async () => {
        const r = await registerUser();
        const a = await registerUser();
        await prisma.profile.upsert({
          where: { userId: a.userId },
          create: { userId: a.userId, displayName: 'Hidden', visibility: 'private' },
          update: { displayName: 'Hidden', visibility: 'private' },
        });
        expect(await actorOf(r, a)).toEqual({ id: a.userId });
      });

      it('exposes only the id for a followers-only profile, even to a follower', async () => {
        const r = await registerUser();
        const a = await registerUser();
        await prisma.profile.upsert({
          where: { userId: a.userId },
          create: { userId: a.userId, displayName: 'Followers', visibility: 'followers' },
          update: { displayName: 'Followers', visibility: 'followers' },
        });
        await prisma.follow.create({ data: { followerId: r.userId, followeeId: a.userId } });
        expect(await actorOf(r, a)).toEqual({ id: a.userId });
      });

      it('returns actor null, and keeps the notification, when the actor is not active', async () => {
        const r = await registerUser();
        const a = await registerUser();
        await prisma.user.update({ where: { id: a.userId }, data: { status: 'suspended' } });
        const n = await seed({ recipient: r.userId, actor: a.userId });
        const res = await list(r).expect(200);
        expect(res.body.data.map((x: { id: string }) => x.id)).toEqual([n.id]);
        expect(res.body.data[0].actor).toBeNull();
      });

      it('returns actor null, and keeps the notification, when the actor is soft-deleted', async () => {
        const r = await registerUser();
        const a = await registerUser();
        await prisma.user.update({ where: { id: a.userId }, data: { deletedAt: new Date() } });
        const n = await seed({ recipient: r.userId, actor: a.userId });
        const res = await list(r).expect(200);
        expect(res.body.data.map((x: { id: string }) => x.id)).toEqual([n.id]);
        expect(res.body.data[0].actor).toBeNull();
      });
    });

    // ---------- blocked actors ----------

    describe('blocked actors', () => {
      it('hides notifications from an actor the recipient blocked, and restores them on unblock', async () => {
        const r = await registerUser();
        const a = await registerUser();
        const fromA = await seed({ recipient: r.userId, actor: a.userId });
        const system = await seed({ recipient: r.userId, actor: null });

        await block(r, a);
        expect(await listIds(r)).toEqual([system.id]);

        await unblock(r, a);
        expect(await listIds(r)).toEqual([fromA.id, system.id]);
      });

      it('hides notifications from an actor who blocked the recipient', async () => {
        const r = await registerUser();
        const a = await registerUser();
        const fromA = await seed({ recipient: r.userId, actor: a.userId });
        const system = await seed({ recipient: r.userId, actor: null });

        await block(a, r);
        expect(await listIds(r)).toEqual([system.id]);

        await unblock(a, r);
        expect(await listIds(r)).toEqual([fromA.id, system.id]);
      });

      it('applies to the unread filter as well', async () => {
        const r = await registerUser();
        const a = await registerUser();
        await seed({ recipient: r.userId, actor: a.userId });
        const keep = await seed({ recipient: r.userId, actor: null });
        await block(r, a);
        expect(await listIds(r, '?unread=true')).toEqual([keep.id]);
      });

      it("is not affected by blocks between other users", async () => {
        const r = await registerUser();
        const a = await registerUser();
        const other = await registerUser();
        const fromA = await seed({ recipient: r.userId, actor: a.userId });
        await block(other, a);
        await block(a, other);
        expect(await listIds(r)).toEqual([fromA.id]);
      });
    });
  });

  // ============================================================
  // GET /notifications/unread-count
  // ============================================================

  describe('GET /notifications/unread-count', () => {
    it('requires authentication', async () => {
      await request(app.getHttpServer()).get('/api/v1/notifications/unread-count').expect(401);
    });

    it('is zero for a user with no notifications', async () => {
      const u = await registerUser();
      expect(await count(u)).toEqual({ count: 0, capped: false });
    });

    it("counts only the caller's unread, non-dismissed notifications", async () => {
      const u = await registerUser();
      const other = await registerUser();
      await seed({ recipient: u.userId });
      await seed({ recipient: u.userId });
      await seed({ recipient: u.userId, readAt: new Date() });
      await seed({ recipient: u.userId, deletedAt: new Date() });
      await seed({ recipient: other.userId });
      expect(await count(u)).toEqual({ count: 2, capped: false });
    });

    it('sets Cache-Control: private, no-store', async () => {
      const u = await registerUser();
      const res = await request(app.getHttpServer()).get('/api/v1/notifications/unread-count').set(auth(u)).expect(200);
      expect(res.headers['cache-control']).toBe('private, no-store');
    });

    it('is exact up to 100 and reports capped beyond it', async () => {
      const at100 = await registerUser();
      await seedMany(at100.userId, 100);
      expect(await count(at100)).toEqual({ count: 100, capped: false });

      const at101 = await registerUser();
      await seedMany(at101.userId, 101);
      expect(await count(at101)).toEqual({ count: 100, capped: true });

      const at130 = await registerUser();
      await seedMany(at130.userId, 130);
      expect(await count(at130)).toEqual({ count: 100, capped: true });
    });

    it('always equals the length of the unread list, in both block directions', async () => {
      const r = await registerUser();
      const blockedByMe = await registerUser();
      const blockedMe = await registerUser();
      const fine = await registerUser();
      for (const actor of [blockedByMe, blockedMe, fine]) {
        await seed({ recipient: r.userId, actor: actor.userId });
        await seed({ recipient: r.userId, actor: actor.userId });
      }
      await seed({ recipient: r.userId, actor: null });

      await block(r, blockedByMe);
      await block(blockedMe, r);

      const unreadIds = await listIds(r, '?unread=true');
      expect(unreadIds).toHaveLength(3); // two from `fine`, one system
      expect(await count(r)).toEqual({ count: 3, capped: false });
    });

    it('applies the cap after block filtering, not before', async () => {
      const r = await registerUser();
      const noisy = await registerUser();
      await seedMany(r.userId, 150, { actor: noisy.userId }); // a flood from one actor...
      await seedMany(r.userId, 5, { actor: null }); // ...and a few real notifications, older than none of them
      await block(r, noisy);
      expect(await count(r)).toEqual({ count: 5, capped: false });
    });
  });

  // ============================================================
  // POST /notifications/:id/read
  // ============================================================

  describe('POST /notifications/:id/read', () => {
    function markRead(u: TestUser, id: string) {
      return request(app.getHttpServer()).post(`/api/v1/notifications/${id}/read`).set(auth(u));
    }

    it('requires authentication and CSRF', async () => {
      const u = await registerUser();
      const n = await seed({ recipient: u.userId });
      await request(app.getHttpServer()).post(`/api/v1/notifications/${n.id}/read`).expect(401);
      await request(app.getHttpServer())
        .post(`/api/v1/notifications/${n.id}/read`)
        .set('Cookie', cookieHeader(u.cookies, 'afrilink_at', 'afrilink_csrf'))
        .expect(403);
      expect((await prisma.notification.findUniqueOrThrow({ where: { id: n.id } })).readAt).toBeNull();
    });

    it('marks a notification read, returns 204 with no body, and lowers the unread count', async () => {
      const u = await registerUser();
      const n = await seed({ recipient: u.userId });
      await seed({ recipient: u.userId });
      expect((await count(u)).count).toBe(2);

      const res = await markRead(u, n.id).expect(204);
      expect(res.text).toBe('');

      expect((await prisma.notification.findUniqueOrThrow({ where: { id: n.id } })).readAt).not.toBeNull();
      expect((await count(u)).count).toBe(1);
      const item = (await list(u).expect(200)).body.data.find((x: { id: string }) => x.id === n.id);
      expect(item.readAt).not.toBeNull();
    });

    it('is idempotent: a repeat returns 204 and keeps the first read time', async () => {
      const u = await registerUser();
      const n = await seed({ recipient: u.userId });
      await markRead(u, n.id).expect(204);
      const first = (await prisma.notification.findUniqueOrThrow({ where: { id: n.id } })).readAt;
      await new Promise((r) => setTimeout(r, 25));
      await markRead(u, n.id).expect(204);
      const second = (await prisma.notification.findUniqueOrThrow({ where: { id: n.id } })).readAt;
      expect(second?.getTime()).toBe(first?.getTime());
    });

    it("returns 404 for another user's notification and leaves it untouched", async () => {
      const owner = await registerUser();
      const intruder = await registerUser();
      const n = await seed({ recipient: owner.userId });
      await markRead(intruder, n.id).expect(404);
      expect((await prisma.notification.findUniqueOrThrow({ where: { id: n.id } })).readAt).toBeNull();
    });

    it('returns 404 for a nonexistent notification', async () => {
      const u = await registerUser();
      await markRead(u, randomUUID()).expect(404);
    });

    it('returns 404 for a dismissed notification', async () => {
      const u = await registerUser();
      const n = await seed({ recipient: u.userId, deletedAt: new Date() });
      await markRead(u, n.id).expect(404);
    });

    it('rejects a malformed id with 422 VALIDATION_FAILED', async () => {
      const u = await registerUser();
      const res = await markRead(u, 'not-a-uuid').expect(422);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.details[0].field).toBe('id');
    });

    it("still works for a notification from a blocked actor (only the list and count hide those)", async () => {
      const r = await registerUser();
      const a = await registerUser();
      const n = await seed({ recipient: r.userId, actor: a.userId });
      await block(r, a);
      await markRead(r, n.id).expect(204);
      expect((await prisma.notification.findUniqueOrThrow({ where: { id: n.id } })).readAt).not.toBeNull();
    });
  });

  // ============================================================
  // DELETE /notifications/:id  (dismiss)
  // ============================================================

  describe('DELETE /notifications/:id', () => {
    function dismiss(u: TestUser, id: string) {
      return request(app.getHttpServer()).delete(`/api/v1/notifications/${id}`).set(auth(u));
    }

    it('requires authentication and CSRF', async () => {
      const u = await registerUser();
      const n = await seed({ recipient: u.userId });
      await request(app.getHttpServer()).delete(`/api/v1/notifications/${n.id}`).expect(401);
      await request(app.getHttpServer())
        .delete(`/api/v1/notifications/${n.id}`)
        .set('Cookie', cookieHeader(u.cookies, 'afrilink_at', 'afrilink_csrf'))
        .expect(403);
      expect((await prisma.notification.findUniqueOrThrow({ where: { id: n.id } })).deletedAt).toBeNull();
    });

    it('dismisses: 204 with no body, gone from the list and the count, row kept, read state untouched', async () => {
      const u = await registerUser();
      const n = await seed({ recipient: u.userId });
      const keep = await seed({ recipient: u.userId });

      const res = await dismiss(u, n.id).expect(204);
      expect(res.text).toBe('');

      expect(await listIds(u)).toEqual([keep.id]);
      expect((await count(u)).count).toBe(1);
      const row = await prisma.notification.findUniqueOrThrow({ where: { id: n.id } });
      expect(row.deletedAt).not.toBeNull(); // soft delete: the row stays
      expect(row.readAt).toBeNull(); // dismissing is not reading
    });

    it('does not disturb an existing read time', async () => {
      const u = await registerUser();
      const readAt = new Date(Date.now() - 3_600_000);
      const n = await seed({ recipient: u.userId, readAt });
      await dismiss(u, n.id).expect(204);
      expect((await prisma.notification.findUniqueOrThrow({ where: { id: n.id } })).readAt?.getTime()).toBe(readAt.getTime());
    });

    it('is idempotent: a repeat returns 204 and keeps the first dismissal time', async () => {
      const u = await registerUser();
      const n = await seed({ recipient: u.userId });
      await dismiss(u, n.id).expect(204);
      const first = (await prisma.notification.findUniqueOrThrow({ where: { id: n.id } })).deletedAt;
      await new Promise((r) => setTimeout(r, 25));
      await dismiss(u, n.id).expect(204);
      const second = (await prisma.notification.findUniqueOrThrow({ where: { id: n.id } })).deletedAt;
      expect(second?.getTime()).toBe(first?.getTime());
    });

    it("returns 404 for another user's notification and leaves it untouched", async () => {
      const owner = await registerUser();
      const intruder = await registerUser();
      const n = await seed({ recipient: owner.userId });
      await dismiss(intruder, n.id).expect(404);
      expect((await prisma.notification.findUniqueOrThrow({ where: { id: n.id } })).deletedAt).toBeNull();
      expect(await listIds(owner)).toEqual([n.id]);
    });

    it('returns 404 for a nonexistent notification', async () => {
      const u = await registerUser();
      await dismiss(u, randomUUID()).expect(404);
    });

    it('rejects a malformed id with 422 VALIDATION_FAILED', async () => {
      const u = await registerUser();
      const res = await dismiss(u, 'not-a-uuid').expect(422);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.details[0].field).toBe('id');
    });

    it('keeps the dedup key claimed, so a replayed event cannot resurrect a dismissed notification', async () => {
      const u = await registerUser();
      const dedupKey = `evt-${randomUUID()}`;
      const n = await seed({ recipient: u.userId, dedupKey });
      await dismiss(u, n.id).expect(204);

      await expect(seed({ recipient: u.userId, dedupKey })).rejects.toThrow(); // unique (recipient_user_id, dedup_key)
      expect(await listIds(u)).toEqual([]);
    });
  });
});
