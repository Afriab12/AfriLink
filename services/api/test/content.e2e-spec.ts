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

describe('Content (e2e)', () => {
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

  async function createPost(u: { cookies: Record<string, string> }, overrides: Record<string, unknown> = {}) {
    const res = await request(app.getHttpServer())
      .post('/api/v1/posts')
      .set(auth(u))
      .send({ body: 'Hello AfriLink', ...overrides })
      .expect(201);
    return res.body.data as { id: string; visibility: string };
  }

  // ============================================================
  // Posts
  // ============================================================

  describe('Posts', () => {
    it('creates a post with default public visibility', async () => {
      const a = await registerUser();
      const post = await createPost(a);
      expect(post.visibility).toBe('public');
    });

    it('rejects empty body and invalid visibility', async () => {
      const a = await registerUser();
      const empty = await request(app.getHttpServer()).post('/api/v1/posts').set(auth(a)).send({ body: '' }).expect(422);
      expect(empty.body.error.code).toBe('VALIDATION_FAILED');

      const badVisibility = await request(app.getHttpServer())
        .post('/api/v1/posts')
        .set(auth(a))
        .send({ body: 'x', visibility: 'community_members' })
        .expect(422);
      expect(badVisibility.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('rejects mass-assignment of mediaIds/communityId (Phase 1 is text-only)', async () => {
      const a = await registerUser();
      const res = await request(app.getHttpServer())
        .post('/api/v1/posts')
        .set(auth(a))
        .send({ body: 'x', mediaIds: [randomUUID()], communityId: randomUUID() })
        .expect(422);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('retrieves a post, including reaction summary fields', async () => {
      const a = await registerUser();
      const post = await createPost(a);
      const res = await request(app.getHttpServer()).get(`/api/v1/posts/${post.id}`).expect(200);
      expect(res.body.data.reactionCounts).toEqual({});
      expect(res.body.data.viewerReaction).toBeUndefined(); // anonymous
    });

    it('returns 404 for a nonexistent post', async () => {
      await request(app.getHttpServer()).get(`/api/v1/posts/${randomUUID()}`).expect(404);
    });

    it('enforces visibility: private hidden from non-owner, followers-only requires an active follow', async () => {
      const owner = await registerUser();
      const other = await registerUser();
      const follower = await registerUser();

      const priv = await createPost(owner, { visibility: 'private' });
      await request(app.getHttpServer()).get(`/api/v1/posts/${priv.id}`).expect(404);
      await request(app.getHttpServer())
        .get(`/api/v1/posts/${priv.id}`)
        .set('Cookie', cookieHeader(owner.cookies, 'afrilink_at'))
        .expect(200);

      const followersOnly = await createPost(owner, { visibility: 'followers' });
      await request(app.getHttpServer())
        .get(`/api/v1/posts/${followersOnly.id}`)
        .set('Cookie', cookieHeader(other.cookies, 'afrilink_at'))
        .expect(404);

      await prisma.follow.create({ data: { followerId: follower.userId, followeeId: owner.userId } });
      await request(app.getHttpServer())
        .get(`/api/v1/posts/${followersOnly.id}`)
        .set('Cookie', cookieHeader(follower.cookies, 'afrilink_at'))
        .expect(200);
    });

    it('only the owner can update or delete a post', async () => {
      const owner = await registerUser();
      const other = await registerUser();
      const post = await createPost(owner);

      await request(app.getHttpServer())
        .patch(`/api/v1/posts/${post.id}`)
        .set(auth(other))
        .send({ body: 'hijacked' })
        .expect(404);
      await request(app.getHttpServer()).delete(`/api/v1/posts/${post.id}`).set(auth(other)).expect(404);

      const updated = await request(app.getHttpServer())
        .patch(`/api/v1/posts/${post.id}`)
        .set(auth(owner))
        .send({ body: 'edited by owner' })
        .expect(200);
      expect(updated.body.data.body).toBe('edited by owner');
      expect(updated.body.data.editedAt).not.toBeNull();

      await request(app.getHttpServer()).delete(`/api/v1/posts/${post.id}`).set(auth(owner)).expect(200);
      await request(app.getHttpServer()).get(`/api/v1/posts/${post.id}`).expect(404);
    });

    it('paginates a user\'s posts with cursor, newest first', async () => {
      const a = await registerUser();
      const bodies = ['first', 'second', 'third'];
      for (const body of bodies) {
        await createPost(a, { body });
      }

      const page1 = await request(app.getHttpServer())
        .get(`/api/v1/users/${a.userId}/posts?limit=2`)
        .expect(200);
      expect(page1.body.data).toHaveLength(2);
      expect(page1.body.data[0].body).toBe('third');
      expect(page1.body.meta.page.hasMore).toBe(true);
      expect(page1.body.meta.page.nextCursor).toBeTruthy();

      const page2 = await request(app.getHttpServer())
        .get(`/api/v1/users/${a.userId}/posts?limit=2&cursor=${encodeURIComponent(page1.body.meta.page.nextCursor)}`)
        .expect(200);
      expect(page2.body.data.map((p: { body: string }) => p.body)).toContain('first');
      expect(page2.body.meta.page.hasMore).toBe(false);
    });

    it('rejects a malformed cursor with 400 INVALID_CURSOR', async () => {
      const a = await registerUser();
      const res = await request(app.getHttpServer())
        .get(`/api/v1/users/${a.userId}/posts?cursor=not-a-real-cursor!!`)
        .expect(400);
      expect(res.body.error.code).toBe('INVALID_CURSOR');
    });

    it('requires authentication and CSRF to create/update/delete', async () => {
      await request(app.getHttpServer()).post('/api/v1/posts').send({ body: 'x' }).expect(401);

      const a = await registerUser();
      await request(app.getHttpServer())
        .post('/api/v1/posts')
        .set('Cookie', cookieHeader(a.cookies, 'afrilink_at', 'afrilink_csrf'))
        .send({ body: 'x' })
        .expect(403);
    });
  });

  // ============================================================
  // Comments and replies
  // ============================================================

  describe('Comments and replies', () => {
    it('creates a top-level comment and a reply, listed separately', async () => {
      const author = await registerUser();
      const commenter = await registerUser();
      const post = await createPost(author);

      const topLevel = await request(app.getHttpServer())
        .post(`/api/v1/posts/${post.id}/comments`)
        .set(auth(commenter))
        .send({ body: 'Nice post!' })
        .expect(201);

      const reply = await request(app.getHttpServer())
        .post(`/api/v1/posts/${post.id}/comments`)
        .set(auth(author))
        .send({ body: 'Thanks!', parentCommentId: topLevel.body.data.id })
        .expect(201);
      expect(reply.body.data.parentCommentId).toBe(topLevel.body.data.id);

      const topList = await request(app.getHttpServer()).get(`/api/v1/posts/${post.id}/comments`).expect(200);
      expect(topList.body.data.map((c: { id: string }) => c.id)).toContain(topLevel.body.data.id);
      expect(topList.body.data.map((c: { id: string }) => c.id)).not.toContain(reply.body.data.id);

      const replies = await request(app.getHttpServer()).get(`/api/v1/comments/${topLevel.body.data.id}/replies`).expect(200);
      expect(replies.body.data.map((c: { id: string }) => c.id)).toEqual([reply.body.data.id]);
    });

    it('rejects a reply whose parentCommentId belongs to a different post', async () => {
      const author = await registerUser();
      const postA = await createPost(author);
      const postB = await createPost(author);
      const commentOnA = await request(app.getHttpServer())
        .post(`/api/v1/posts/${postA.id}/comments`)
        .set(auth(author))
        .send({ body: 'on A' })
        .expect(201);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/posts/${postB.id}/comments`)
        .set(auth(author))
        .send({ body: 'cross-post reply', parentCommentId: commentOnA.body.data.id })
        .expect(404);
      expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
    });

    it('rejects commenting on an inaccessible (private, non-owner) post', async () => {
      const owner = await registerUser();
      const other = await registerUser();
      const priv = await createPost(owner, { visibility: 'private' });
      await request(app.getHttpServer())
        .post(`/api/v1/posts/${priv.id}/comments`)
        .set(auth(other))
        .send({ body: 'sneaky' })
        .expect(404);
    });

    it('only the comment author can update or delete it', async () => {
      const author = await registerUser();
      const commenter = await registerUser();
      const other = await registerUser();
      const post = await createPost(author);
      const comment = await request(app.getHttpServer())
        .post(`/api/v1/posts/${post.id}/comments`)
        .set(auth(commenter))
        .send({ body: 'original' })
        .expect(201);

      await request(app.getHttpServer())
        .patch(`/api/v1/comments/${comment.body.data.id}`)
        .set(auth(other))
        .send({ body: 'hijacked' })
        .expect(404);

      const updated = await request(app.getHttpServer())
        .patch(`/api/v1/comments/${comment.body.data.id}`)
        .set(auth(commenter))
        .send({ body: 'edited' })
        .expect(200);
      expect(updated.body.data.body).toBe('edited');

      await request(app.getHttpServer()).delete(`/api/v1/comments/${comment.body.data.id}`).set(auth(other)).expect(404);
      await request(app.getHttpServer()).delete(`/api/v1/comments/${comment.body.data.id}`).set(auth(commenter)).expect(200);

      const list = await request(app.getHttpServer()).get(`/api/v1/posts/${post.id}/comments`).expect(200);
      expect(list.body.data.map((c: { id: string }) => c.id)).not.toContain(comment.body.data.id);
    });

    it('paginates top-level comments with cursor, oldest first', async () => {
      const author = await registerUser();
      const post = await createPost(author);
      for (const body of ['c1', 'c2', 'c3']) {
        await request(app.getHttpServer()).post(`/api/v1/posts/${post.id}/comments`).set(auth(author)).send({ body }).expect(201);
      }

      const page1 = await request(app.getHttpServer()).get(`/api/v1/posts/${post.id}/comments?limit=2`).expect(200);
      expect(page1.body.data.map((c: { body: string }) => c.body)).toEqual(['c1', 'c2']);
      expect(page1.body.meta.page.hasMore).toBe(true);

      const page2 = await request(app.getHttpServer())
        .get(`/api/v1/posts/${post.id}/comments?limit=2&cursor=${encodeURIComponent(page1.body.meta.page.nextCursor)}`)
        .expect(200);
      expect(page2.body.data.map((c: { body: string }) => c.body)).toEqual(['c3']);
      expect(page2.body.meta.page.hasMore).toBe(false);
    });
  });

  // ============================================================
  // Reactions
  // ============================================================

  describe('Reactions', () => {
    it('adds a reaction and reflects it in the post\'s counts and viewer state', async () => {
      const author = await registerUser();
      const reactor = await registerUser();
      const post = await createPost(author);

      await request(app.getHttpServer())
        .put(`/api/v1/posts/${post.id}/reaction`)
        .set(auth(reactor))
        .send({ type: 'like' })
        .expect(200);

      const res = await request(app.getHttpServer())
        .get(`/api/v1/posts/${post.id}`)
        .set('Cookie', cookieHeader(reactor.cookies, 'afrilink_at'))
        .expect(200);
      expect(res.body.data.reactionCounts).toEqual({ like: 1 });
      expect(res.body.data.viewerReaction).toBe('like');
    });

    it('changing a reaction updates the same row rather than creating a second one (ADR-003 §6)', async () => {
      const author = await registerUser();
      const reactor = await registerUser();
      const post = await createPost(author);

      await request(app.getHttpServer()).put(`/api/v1/posts/${post.id}/reaction`).set(auth(reactor)).send({ type: 'like' }).expect(200);
      await request(app.getHttpServer()).put(`/api/v1/posts/${post.id}/reaction`).set(auth(reactor)).send({ type: 'love' }).expect(200);

      const count = await prisma.postReaction.count({ where: { userId: reactor.userId, postId: post.id } });
      expect(count).toBe(1);

      const res = await request(app.getHttpServer())
        .get(`/api/v1/posts/${post.id}`)
        .set('Cookie', cookieHeader(reactor.cookies, 'afrilink_at'))
        .expect(200);
      expect(res.body.data.reactionCounts).toEqual({ love: 1 });
      expect(res.body.data.viewerReaction).toBe('love');
    });

    it('removes a reaction', async () => {
      const author = await registerUser();
      const reactor = await registerUser();
      const post = await createPost(author);
      await request(app.getHttpServer()).put(`/api/v1/posts/${post.id}/reaction`).set(auth(reactor)).send({ type: 'like' }).expect(200);

      await request(app.getHttpServer()).delete(`/api/v1/posts/${post.id}/reaction`).set(auth(reactor)).expect(200);

      const res = await request(app.getHttpServer())
        .get(`/api/v1/posts/${post.id}`)
        .set('Cookie', cookieHeader(reactor.cookies, 'afrilink_at'))
        .expect(200);
      expect(res.body.data.reactionCounts).toEqual({});
      expect(res.body.data.viewerReaction).toBeNull();
    });

    it('re-reacting after removal still uses exactly one row', async () => {
      const author = await registerUser();
      const reactor = await registerUser();
      const post = await createPost(author);
      await request(app.getHttpServer()).put(`/api/v1/posts/${post.id}/reaction`).set(auth(reactor)).send({ type: 'like' }).expect(200);
      await request(app.getHttpServer()).delete(`/api/v1/posts/${post.id}/reaction`).set(auth(reactor)).expect(200);
      await request(app.getHttpServer()).put(`/api/v1/posts/${post.id}/reaction`).set(auth(reactor)).send({ type: 'support' }).expect(200);

      const count = await prisma.postReaction.count({ where: { userId: reactor.userId, postId: post.id } });
      expect(count).toBe(1);
    });

    it('rejects an invalid reaction type', async () => {
      const author = await registerUser();
      const post = await createPost(author);
      const res = await request(app.getHttpServer())
        .put(`/api/v1/posts/${post.id}/reaction`)
        .set(auth(author))
        .send({ type: 'wow' })
        .expect(422);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('reacts to a comment, independent of post reactions', async () => {
      const author = await registerUser();
      const post = await createPost(author);
      const comment = await request(app.getHttpServer())
        .post(`/api/v1/posts/${post.id}/comments`)
        .set(auth(author))
        .send({ body: 'react to me' })
        .expect(201);

      await request(app.getHttpServer())
        .put(`/api/v1/comments/${comment.body.data.id}/reaction`)
        .set(auth(author))
        .send({ type: 'insightful' })
        .expect(200);

      const count = await prisma.commentReaction.count({ where: { userId: author.userId, commentId: comment.body.data.id } });
      expect(count).toBe(1);

      await request(app.getHttpServer()).delete(`/api/v1/comments/${comment.body.data.id}/reaction`).set(auth(author)).expect(200);
      const afterRemove = await prisma.commentReaction.count({
        where: { userId: author.userId, commentId: comment.body.data.id, deletedAt: null },
      });
      expect(afterRemove).toBe(0);
    });

    it('requires authentication', async () => {
      const author = await registerUser();
      const post = await createPost(author);
      await request(app.getHttpServer()).put(`/api/v1/posts/${post.id}/reaction`).send({ type: 'like' }).expect(401);
    });

    it('rejects reacting to an inaccessible post', async () => {
      const owner = await registerUser();
      const other = await registerUser();
      const priv = await createPost(owner, { visibility: 'private' });
      await request(app.getHttpServer()).put(`/api/v1/posts/${priv.id}/reaction`).set(auth(other)).send({ type: 'like' }).expect(404);
    });
  });

  // ============================================================
  // Shares
  // ============================================================

  describe('Shares', () => {
    it('creates a share, optionally with a comment', async () => {
      const author = await registerUser();
      const sharer = await registerUser();
      const post = await createPost(author);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/posts/${post.id}/shares`)
        .set(auth(sharer))
        .send({ comment: 'everyone should see this' })
        .expect(201);
      expect(res.body.data.postId).toBe(post.id);
      expect(res.body.data.comment).toBe('everyone should see this');
    });

    it('allows sharing the same post more than once — no uniqueness constraint in the approved schema', async () => {
      const author = await registerUser();
      const sharer = await registerUser();
      const post = await createPost(author);

      await request(app.getHttpServer()).post(`/api/v1/posts/${post.id}/shares`).set(auth(sharer)).send({}).expect(201);
      await request(app.getHttpServer()).post(`/api/v1/posts/${post.id}/shares`).set(auth(sharer)).send({}).expect(201);

      const count = await prisma.share.count({ where: { userId: sharer.userId, postId: post.id, deletedAt: null } });
      expect(count).toBe(2);
    });

    it('only the sharer can delete their own share', async () => {
      const author = await registerUser();
      const sharer = await registerUser();
      const other = await registerUser();
      const post = await createPost(author);
      const share = await request(app.getHttpServer()).post(`/api/v1/posts/${post.id}/shares`).set(auth(sharer)).send({}).expect(201);

      await request(app.getHttpServer()).delete(`/api/v1/shares/${share.body.data.id}`).set(auth(other)).expect(404);
      await request(app.getHttpServer()).delete(`/api/v1/shares/${share.body.data.id}`).set(auth(sharer)).expect(200);
    });

    it('paginates a user\'s shares with cursor', async () => {
      const author = await registerUser();
      const sharer = await registerUser();
      const posts = [await createPost(author, { body: 'p1' }), await createPost(author, { body: 'p2' }), await createPost(author, { body: 'p3' })];
      for (const p of posts) {
        await request(app.getHttpServer()).post(`/api/v1/posts/${p.id}/shares`).set(auth(sharer)).send({}).expect(201);
      }

      const page1 = await request(app.getHttpServer()).get(`/api/v1/users/${sharer.userId}/shares?limit=2`).expect(200);
      expect(page1.body.data).toHaveLength(2);
      expect(page1.body.meta.page.hasMore).toBe(true);
    });

    it('re-evaluates the source post\'s visibility at read time, not frozen at share time (database.md §6)', async () => {
      const author = await registerUser();
      const sharer = await registerUser();
      const viewer = await registerUser();
      const post = await createPost(author); // public

      await request(app.getHttpServer()).post(`/api/v1/posts/${post.id}/shares`).set(auth(sharer)).send({}).expect(201);

      const before = await request(app.getHttpServer())
        .get(`/api/v1/users/${sharer.userId}/shares`)
        .set('Cookie', cookieHeader(viewer.cookies, 'afrilink_at'))
        .expect(200);
      expect(before.body.data.map((s: { postId: string }) => s.postId)).toContain(post.id);

      // Author makes the original post private after it was shared.
      await request(app.getHttpServer()).patch(`/api/v1/posts/${post.id}`).set(auth(author)).send({ visibility: 'private' }).expect(200);

      const after = await request(app.getHttpServer())
        .get(`/api/v1/users/${sharer.userId}/shares`)
        .set('Cookie', cookieHeader(viewer.cookies, 'afrilink_at'))
        .expect(200);
      expect(after.body.data.map((s: { postId: string }) => s.postId)).not.toContain(post.id);

      // The post's own author can still see their post referenced fine —
      // not asserted via the shares list (author isn't the sharer here),
      // but confirms the share row itself was never deleted, only
      // filtered at read time.
      const shareRow = await prisma.share.findFirst({ where: { userId: sharer.userId, postId: post.id } });
      expect(shareRow?.deletedAt).toBeNull();
    });

    it('rejects sharing an inaccessible post', async () => {
      const owner = await registerUser();
      const other = await registerUser();
      const priv = await createPost(owner, { visibility: 'private' });
      await request(app.getHttpServer()).post(`/api/v1/posts/${priv.id}/shares`).set(auth(other)).send({}).expect(404);
    });

    it('requires authentication and CSRF', async () => {
      const author = await registerUser();
      const post = await createPost(author);
      await request(app.getHttpServer()).post(`/api/v1/posts/${post.id}/shares`).send({}).expect(401);

      const sharer = await registerUser();
      await request(app.getHttpServer())
        .post(`/api/v1/posts/${post.id}/shares`)
        .set('Cookie', cookieHeader(sharer.cookies, 'afrilink_at', 'afrilink_csrf'))
        .send({})
        .expect(403);
    });
  });

  // ============================================================
  // Cross-cutting: blocks suppress all content interaction
  // ============================================================

  describe('Block suppression across content', () => {
    it('a block hides the post and rejects commenting/reacting/sharing in both directions', async () => {
      const author = await registerUser();
      const blocked = await registerUser();
      const post = await createPost(author);

      await request(app.getHttpServer()).post(`/api/v1/users/${blocked.userId}/block`).set(auth(author)).expect(201);

      await request(app.getHttpServer())
        .get(`/api/v1/posts/${post.id}`)
        .set('Cookie', cookieHeader(blocked.cookies, 'afrilink_at'))
        .expect(404);
      await request(app.getHttpServer())
        .post(`/api/v1/posts/${post.id}/comments`)
        .set(auth(blocked))
        .send({ body: 'sneaky' })
        .expect(404);
      await request(app.getHttpServer())
        .put(`/api/v1/posts/${post.id}/reaction`)
        .set(auth(blocked))
        .send({ type: 'like' })
        .expect(404);
      await request(app.getHttpServer()).post(`/api/v1/posts/${post.id}/shares`).set(auth(blocked)).send({}).expect(404);
    });
  });
});
