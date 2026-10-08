import 'reflect-metadata';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { NotificationsService } from '../src/notifications/notifications.service';

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

  async function notificationsFor(type: string, recipientUserId: string) {
    return prisma.notification.findMany({ where: { type, recipientUserId } });
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
        .send({ body: 'x', visibility: 'everyone' }) // (community_members is a valid audience now, but only together with a communityId)
        .expect(422);
      expect(badVisibility.body.error.code).toBe('VALIDATION_FAILED');
    });

    // communityId is a real, validated field now (see community-posts.e2e-spec.ts); media is still not.
    it('rejects mass-assignment of mediaIds (posts are text-only until the media schema exists)', async () => {
      const a = await registerUser();
      const res = await request(app.getHttpServer())
        .post('/api/v1/posts')
        .set(auth(a))
        .send({ body: 'x', mediaIds: [randomUUID()] })
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

    // ============================================================
    // Notifications A2 — content producers
    // ============================================================

    describe('Notifications A2: reactions', () => {
      it('notifies the post author once per reacting actor/target pair across changes, removal and re-reaction', async () => {
        const author = await registerUser();
        const reactor = await registerUser();
        const post = await createPost(author);

        await request(app.getHttpServer()).put(`/api/v1/posts/${post.id}/reaction`).set(auth(reactor)).send({ type: 'like' }).expect(200);
        const first = await notificationsFor('post_reaction', author.userId);
        expect(first).toHaveLength(1);
        expect(first[0]).toMatchObject({
          actorUserId: reactor.userId,
          targetType: 'post',
          targetId: post.id,
          groupKey: null,
          dedupKey: `post_reaction:${post.id}:${reactor.userId}`,
          payload: null,
        });

        await request(app.getHttpServer()).put(`/api/v1/posts/${post.id}/reaction`).set(auth(reactor)).send({ type: 'love' }).expect(200);
        await request(app.getHttpServer()).delete(`/api/v1/posts/${post.id}/reaction`).set(auth(reactor)).expect(200);
        await request(app.getHttpServer()).put(`/api/v1/posts/${post.id}/reaction`).set(auth(reactor)).send({ type: 'support' }).expect(200);
        expect(await notificationsFor('post_reaction', author.userId)).toHaveLength(1);
      });

      it('does not notify on a self-reaction', async () => {
        const author = await registerUser();
        const post = await createPost(author);

        await request(app.getHttpServer()).put(`/api/v1/posts/${post.id}/reaction`).set(auth(author)).send({ type: 'like' }).expect(200);
        expect(await notificationsFor('post_reaction', author.userId)).toHaveLength(0);
      });

      it('keeps the reaction successful when notification recording fails', async () => {
        const author = await registerUser();
        const reactor = await registerUser();
        const post = await createPost(author);
        const notifications = app.get(NotificationsService);
        const spy = vi.spyOn(notifications, 'record').mockRejectedValueOnce(new Error('simulated notification failure'));

        await request(app.getHttpServer()).put(`/api/v1/posts/${post.id}/reaction`).set(auth(reactor)).send({ type: 'like' }).expect(200);
        spy.mockRestore();
        expect(await prisma.postReaction.findUnique({ where: { userId_postId: { userId: reactor.userId, postId: post.id } } })).not.toBeNull();
      });

      it('notifies the comment author, uses the comment target and suppresses blocked pairs', async () => {
        const postAuthor = await registerUser();
        const commentAuthor = await registerUser();
        const reactor = await registerUser();
        const post = await createPost(postAuthor);
        const comment = await request(app.getHttpServer())
          .post(`/api/v1/posts/${post.id}/comments`)
          .set(auth(commentAuthor))
          .send({ body: 'comment target' })
          .expect(201);
        const commentId = comment.body.data.id as string;

        await request(app.getHttpServer()).put(`/api/v1/comments/${commentId}/reaction`).set(auth(reactor)).send({ type: 'like' }).expect(200);
        await request(app.getHttpServer()).put(`/api/v1/comments/${commentId}/reaction`).set(auth(reactor)).send({ type: 'love' }).expect(200);
        await request(app.getHttpServer()).delete(`/api/v1/comments/${commentId}/reaction`).set(auth(reactor)).expect(200);
        await request(app.getHttpServer()).put(`/api/v1/comments/${commentId}/reaction`).set(auth(reactor)).send({ type: 'support' }).expect(200);
        const events = await notificationsFor('comment_reaction', commentAuthor.userId);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          actorUserId: reactor.userId,
          targetType: 'comment',
          targetId: commentId,
          groupKey: null,
          dedupKey: `comment_reaction:${commentId}:${reactor.userId}`,
          payload: null,
        });
      });

      it.each([
        ['recipient blocks actor', 'recipient'],
        ['actor blocks recipient', 'actor'],
      ])('suppresses comment-reaction notifications when the pair is blocked (%s)', async (_label, blocker) => {
        const postAuthor = await registerUser();
        const commentAuthor = await registerUser();
        const reactor = await registerUser();
        const post = await createPost(postAuthor);
        const comment = await request(app.getHttpServer())
          .post(`/api/v1/posts/${post.id}/comments`)
          .set(auth(commentAuthor))
          .send({ body: 'comment target' })
          .expect(201);
        const commentId = comment.body.data.id as string;
        const blockerUser = blocker === 'recipient' ? commentAuthor : reactor;
        const blockedUser = blocker === 'recipient' ? reactor : commentAuthor;

        await request(app.getHttpServer()).post(`/api/v1/users/${blockedUser.userId}/block`).set(auth(blockerUser)).expect(201);
        await request(app.getHttpServer()).put(`/api/v1/comments/${commentId}/reaction`).set(auth(reactor)).send({ type: 'like' }).expect(200);

        expect(await notificationsFor('comment_reaction', commentAuthor.userId)).toHaveLength(0);
        expect(await prisma.commentReaction.findUnique({ where: { userId_commentId: { userId: reactor.userId, commentId } } })).not.toBeNull();
      });

      it('does not notify on a self-reaction to a comment', async () => {
        const postAuthor = await registerUser();
        const commentAuthor = await registerUser();
        const post = await createPost(postAuthor);
        const comment = await request(app.getHttpServer())
          .post(`/api/v1/posts/${post.id}/comments`)
          .set(auth(commentAuthor))
          .send({ body: 'own comment' })
          .expect(201);

        await request(app.getHttpServer())
          .put(`/api/v1/comments/${comment.body.data.id}/reaction`)
          .set(auth(commentAuthor))
          .send({ type: 'like' })
          .expect(200);
        expect(await notificationsFor('comment_reaction', commentAuthor.userId)).toHaveLength(0);
      });

      it('keeps the comment reaction successful when notification recording fails', async () => {
        const postAuthor = await registerUser();
        const commentAuthor = await registerUser();
        const reactor = await registerUser();
        const post = await createPost(postAuthor);
        const comment = await request(app.getHttpServer())
          .post(`/api/v1/posts/${post.id}/comments`)
          .set(auth(commentAuthor))
          .send({ body: 'comment target' })
          .expect(201);
        const commentId = comment.body.data.id as string;
        const notifications = app.get(NotificationsService);
        const spy = vi.spyOn(notifications, 'record').mockRejectedValueOnce(new Error('simulated notification failure'));

        await request(app.getHttpServer()).put(`/api/v1/comments/${commentId}/reaction`).set(auth(reactor)).send({ type: 'like' }).expect(200);
        spy.mockRestore();
        expect(await prisma.commentReaction.findUnique({ where: { userId_commentId: { userId: reactor.userId, commentId } } })).not.toBeNull();
      });
    });

    describe('Notifications A2: comments and replies', () => {
      it('notifies the post author for a top-level comment without storing its body', async () => {
        const postAuthor = await registerUser();
        const commenter = await registerUser();
        const post = await createPost(postAuthor);
        const comment = await request(app.getHttpServer())
          .post(`/api/v1/posts/${post.id}/comments`)
          .set(auth(commenter))
          .send({ body: 'private comment content' })
          .expect(201);
        const commentId = comment.body.data.id as string;

        const events = await notificationsFor('post_comment', postAuthor.userId);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          actorUserId: commenter.userId,
          targetType: 'post',
          targetId: post.id,
          groupKey: null,
          dedupKey: `post_comment:${commentId}`,
          payload: null,
        });
        expect(JSON.stringify(events[0])).not.toContain('private comment content');
      });

      it('creates a distinct notification for each separately-created top-level comment', async () => {
        const postAuthor = await registerUser();
        const commenter = await registerUser();
        const post = await createPost(postAuthor);

        const first = await request(app.getHttpServer())
          .post(`/api/v1/posts/${post.id}/comments`)
          .set(auth(commenter))
          .send({ body: 'first comment' })
          .expect(201);
        const second = await request(app.getHttpServer())
          .post(`/api/v1/posts/${post.id}/comments`)
          .set(auth(commenter))
          .send({ body: 'second comment' })
          .expect(201);

        const events = await notificationsFor('post_comment', postAuthor.userId);
        expect(events).toHaveLength(2);
        expect(events.map((event) => event.dedupKey).sort()).toEqual(
          [`post_comment:${first.body.data.id}`, `post_comment:${second.body.data.id}`].sort(),
        );
      });

      it('does not notify for a self-comment or a self-reply', async () => {
        const author = await registerUser();
        const post = await createPost(author);
        const ownComment = await request(app.getHttpServer())
          .post(`/api/v1/posts/${post.id}/comments`)
          .set(auth(author))
          .send({ body: 'self comment' })
          .expect(201);
        const anotherCommenter = await registerUser();
        const parent = await request(app.getHttpServer())
          .post(`/api/v1/posts/${post.id}/comments`)
          .set(auth(anotherCommenter))
          .send({ body: 'parent' })
          .expect(201);

        await request(app.getHttpServer())
          .post(`/api/v1/posts/${post.id}/comments`)
          .set(auth(anotherCommenter))
          .send({ body: 'self reply', parentCommentId: parent.body.data.id })
          .expect(201);

        expect(await notificationsFor('post_comment', author.userId)).toHaveLength(1);
        expect((await notificationsFor('post_comment', author.userId))[0].targetId).toBe(post.id);
        expect(await notificationsFor('comment_reply', anotherCommenter.userId)).toHaveLength(0);
        expect(ownComment.body.data.authorId).toBe(author.userId);
      });

      it('notifies only the direct parent author for replies at each nesting level', async () => {
        const postAuthor = await registerUser();
        const rootAuthor = await registerUser();
        const firstReplier = await registerUser();
        const secondReplier = await registerUser();
        const post = await createPost(postAuthor);
        const root = await request(app.getHttpServer())
          .post(`/api/v1/posts/${post.id}/comments`)
          .set(auth(rootAuthor))
          .send({ body: 'root' })
          .expect(201);
        const firstReply = await request(app.getHttpServer())
          .post(`/api/v1/posts/${post.id}/comments`)
          .set(auth(firstReplier))
          .send({ body: 'reply body must not be stored', parentCommentId: root.body.data.id })
          .expect(201);
        const secondReply = await request(app.getHttpServer())
          .post(`/api/v1/posts/${post.id}/comments`)
          .set(auth(secondReplier))
          .send({ body: 'nested reply', parentCommentId: firstReply.body.data.id })
          .expect(201);

        const rootEvent = (await notificationsFor('comment_reply', rootAuthor.userId))[0];
        expect(rootEvent).toMatchObject({
          actorUserId: firstReplier.userId,
          targetType: 'comment',
          targetId: root.body.data.id,
          dedupKey: `comment_reply:${firstReply.body.data.id}`,
          groupKey: null,
          payload: null,
        });
        const nestedEvent = (await notificationsFor('comment_reply', firstReplier.userId))[0];
        expect(nestedEvent).toMatchObject({
          actorUserId: secondReplier.userId,
          targetType: 'comment',
          targetId: firstReply.body.data.id,
          dedupKey: `comment_reply:${secondReply.body.data.id}`,
          payload: null,
        });
        expect(await notificationsFor('comment_reply', postAuthor.userId)).toHaveLength(0);
        expect(await notificationsFor('comment_reply', rootAuthor.userId)).toHaveLength(1);
        expect(JSON.stringify(rootEvent)).not.toContain('reply body must not be stored');
      });

      it.each([
        ['recipient blocks actor', 'recipient'],
        ['actor blocks recipient', 'actor'],
      ])('suppresses reply notifications when the pair is blocked (%s)', async (_label, blocker) => {
        const postAuthor = await registerUser();
        const parentAuthor = await registerUser();
        const replier = await registerUser();
        const post = await createPost(postAuthor);
        const parent = await request(app.getHttpServer())
          .post(`/api/v1/posts/${post.id}/comments`)
          .set(auth(parentAuthor))
          .send({ body: 'parent' })
          .expect(201);
        const blockerUser = blocker === 'recipient' ? parentAuthor : replier;
        const blockedUser = blocker === 'recipient' ? replier : parentAuthor;

        await request(app.getHttpServer()).post(`/api/v1/users/${blockedUser.userId}/block`).set(auth(blockerUser)).expect(201);
        const reply = await request(app.getHttpServer())
          .post(`/api/v1/posts/${post.id}/comments`)
          .set(auth(replier))
          .send({ body: 'reply', parentCommentId: parent.body.data.id })
          .expect(201);

        expect(await notificationsFor('comment_reply', parentAuthor.userId)).toHaveLength(0);
        expect(await prisma.comment.findUnique({ where: { id: reply.body.data.id } })).not.toBeNull();
      });

      it('keeps comment creation successful when notification recording fails', async () => {
        const postAuthor = await registerUser();
        const commenter = await registerUser();
        const post = await createPost(postAuthor);
        const notifications = app.get(NotificationsService);
        const spy = vi.spyOn(notifications, 'record').mockRejectedValueOnce(new Error('simulated notification failure'));

        const comment = await request(app.getHttpServer())
          .post(`/api/v1/posts/${post.id}/comments`)
          .set(auth(commenter))
          .send({ body: 'still created' })
          .expect(201);
        spy.mockRestore();
        expect(await prisma.comment.findUnique({ where: { id: comment.body.data.id } })).not.toBeNull();
      });

      it('keeps reply creation successful when notification recording fails', async () => {
        const postAuthor = await registerUser();
        const parentAuthor = await registerUser();
        const replier = await registerUser();
        const post = await createPost(postAuthor);
        const parent = await request(app.getHttpServer())
          .post(`/api/v1/posts/${post.id}/comments`)
          .set(auth(parentAuthor))
          .send({ body: 'parent' })
          .expect(201);
        const notifications = app.get(NotificationsService);
        const spy = vi.spyOn(notifications, 'record').mockRejectedValueOnce(new Error('simulated notification failure'));

        const reply = await request(app.getHttpServer())
          .post(`/api/v1/posts/${post.id}/comments`)
          .set(auth(replier))
          .send({ body: 'still created', parentCommentId: parent.body.data.id })
          .expect(201);
        spy.mockRestore();
        expect(await prisma.comment.findUnique({ where: { id: reply.body.data.id } })).not.toBeNull();
      });
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
  // Moderation state (existing content.posts/content.comments `status`
  // field — ContentStatus: published/hidden/removed)
  // ============================================================
  // No moderation-action endpoints exist yet (out of scope for the
  // Content API) — these tests seed `status` directly via Prisma to
  // confirm the existing filtering in PostAccessService/posts.service.ts/
  // comments.service.ts actually holds, since nothing previously
  // exercised it. Note: this filtering doesn't special-case the owner —
  // a hidden/removed post or comment disappears for its own author too,
  // since no moderation actions exist yet to expose it differently.

  describe('Moderation state filtering', () => {
    it('a hidden post is not retrievable by ID and is excluded from the author\'s own listing', async () => {
      const author = await registerUser();
      const post = await createPost(author);
      await prisma.post.update({ where: { id: post.id }, data: { status: 'hidden' } });

      await request(app.getHttpServer())
        .get(`/api/v1/posts/${post.id}`)
        .set('Cookie', cookieHeader(author.cookies, 'afrilink_at'))
        .expect(404);

      const list = await request(app.getHttpServer())
        .get(`/api/v1/users/${author.userId}/posts`)
        .set('Cookie', cookieHeader(author.cookies, 'afrilink_at'))
        .expect(200);
      expect(list.body.data.map((p: { id: string }) => p.id)).not.toContain(post.id);
    });

    it('a removed post is not retrievable by ID and is excluded from the author\'s own listing', async () => {
      const author = await registerUser();
      const post = await createPost(author);
      await prisma.post.update({ where: { id: post.id }, data: { status: 'removed' } });

      await request(app.getHttpServer())
        .get(`/api/v1/posts/${post.id}`)
        .set('Cookie', cookieHeader(author.cookies, 'afrilink_at'))
        .expect(404);

      const list = await request(app.getHttpServer())
        .get(`/api/v1/users/${author.userId}/posts`)
        .set('Cookie', cookieHeader(author.cookies, 'afrilink_at'))
        .expect(200);
      expect(list.body.data.map((p: { id: string }) => p.id)).not.toContain(post.id);
    });

    it('a hidden post also blocks commenting, reacting, and sharing (interaction never exceeds visibility)', async () => {
      const author = await registerUser();
      const other = await registerUser();
      const post = await createPost(author);
      await prisma.post.update({ where: { id: post.id }, data: { status: 'hidden' } });

      await request(app.getHttpServer())
        .post(`/api/v1/posts/${post.id}/comments`)
        .set(auth(other))
        .send({ body: 'sneaky' })
        .expect(404);
      await request(app.getHttpServer())
        .put(`/api/v1/posts/${post.id}/reaction`)
        .set(auth(other))
        .send({ type: 'like' })
        .expect(404);
      await request(app.getHttpServer()).post(`/api/v1/posts/${post.id}/shares`).set(auth(other)).send({}).expect(404);
    });

    it('a hidden top-level comment is excluded from the post\'s comment list', async () => {
      const author = await registerUser();
      const post = await createPost(author);
      const comment = await request(app.getHttpServer())
        .post(`/api/v1/posts/${post.id}/comments`)
        .set(auth(author))
        .send({ body: 'will be hidden' })
        .expect(201);
      await prisma.comment.update({ where: { id: comment.body.data.id }, data: { status: 'hidden' } });

      const list = await request(app.getHttpServer()).get(`/api/v1/posts/${post.id}/comments`).expect(200);
      expect(list.body.data.map((c: { id: string }) => c.id)).not.toContain(comment.body.data.id);
    });

    it('a removed reply is excluded from its parent comment\'s replies list', async () => {
      const author = await registerUser();
      const post = await createPost(author);
      const topLevel = await request(app.getHttpServer())
        .post(`/api/v1/posts/${post.id}/comments`)
        .set(auth(author))
        .send({ body: 'top level' })
        .expect(201);
      const reply = await request(app.getHttpServer())
        .post(`/api/v1/posts/${post.id}/comments`)
        .set(auth(author))
        .send({ body: 'will be removed', parentCommentId: topLevel.body.data.id })
        .expect(201);
      await prisma.comment.update({ where: { id: reply.body.data.id }, data: { status: 'removed' } });

      const replies = await request(app.getHttpServer()).get(`/api/v1/comments/${topLevel.body.data.id}/replies`).expect(200);
      expect(replies.body.data.map((c: { id: string }) => c.id)).not.toContain(reply.body.data.id);
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
      expect(await notificationsFor('post_reaction', author.userId)).toHaveLength(0);
    });
  });
});