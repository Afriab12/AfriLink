import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../common/prisma/prisma.service';
import { ContentModerationService } from './content-moderation.service';

// Unit-level (no HTTP layer, direct PrismaService instantiation — same
// pattern as media-access.service.spec.ts/platform-role.guard.spec.ts):
// ContentModerationService is the cross-module surface Moderation will call
// (docs/05-api/moderation.md §7) — applyContentModerationStatus to execute
// remove_content/restrict_content, resolveContentOwnerId as the privileged,
// visibility/deletion-agnostic lookup appeal eligibility needs. Not yet
// consumed by any module (Moderation doesn't exist yet) — built and tested
// in isolation now so it is correct before anything depends on it.
describe('ContentModerationService', () => {
  let prisma: PrismaService;
  let service: ContentModerationService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new ContentModerationService(prisma);
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  async function makeUser(overrides: Partial<{ status: string }> = {}) {
    return prisma.user.create({ data: { status: (overrides.status as never) ?? 'active', updatedAt: new Date() } });
  }

  async function makePost(authorId: string, overrides: Partial<{ status: string; deletedAt: Date }> = {}) {
    return prisma.post.create({
      data: {
        authorId,
        body: 'test post',
        status: (overrides.status as never) ?? 'published',
        deletedAt: overrides.deletedAt ?? null,
      },
    });
  }

  async function makeComment(postId: string, authorId: string, overrides: Partial<{ status: string; deletedAt: Date }> = {}) {
    return prisma.comment.create({
      data: {
        postId,
        authorId,
        body: 'test comment',
        status: (overrides.status as never) ?? 'published',
        deletedAt: overrides.deletedAt ?? null,
      },
    });
  }

  async function makeShare(userId: string, postId: string) {
    return prisma.share.create({ data: { userId, postId } });
  }

  describe('applyContentModerationStatus', () => {
    it("sets a post's status to removed", async () => {
      const author = await makeUser();
      const post = await makePost(author.id);
      await service.applyContentModerationStatus('post', post.id, 'removed');
      const updated = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
      expect(updated.status).toBe('removed');
    });

    it("sets a post's status to hidden", async () => {
      const author = await makeUser();
      const post = await makePost(author.id);
      await service.applyContentModerationStatus('post', post.id, 'hidden');
      const updated = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
      expect(updated.status).toBe('hidden');
    });

    it("sets a comment's status to removed", async () => {
      const author = await makeUser();
      const post = await makePost(author.id);
      const comment = await makeComment(post.id, author.id);
      await service.applyContentModerationStatus('comment', comment.id, 'removed');
      const updated = await prisma.comment.findUniqueOrThrow({ where: { id: comment.id } });
      expect(updated.status).toBe('removed');
    });

    it('restores a previously removed post back to published (appeal-overturned round trip)', async () => {
      const author = await makeUser();
      const post = await makePost(author.id, { status: 'removed' });
      await service.applyContentModerationStatus('post', post.id, 'published');
      const updated = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
      expect(updated.status).toBe('published');
    });

    it("does not touch deletedAt — moderation status and a user's own soft-delete are independent axes", async () => {
      const author = await makeUser();
      const post = await makePost(author.id);
      await service.applyContentModerationStatus('post', post.id, 'removed');
      const updated = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
      expect(updated.deletedAt).toBeNull();
    });

    it('throws (propagating Prisma P2025) for a nonexistent post id', async () => {
      await expect(service.applyContentModerationStatus('post', randomUUID(), 'removed')).rejects.toMatchObject({ code: 'P2025' });
    });

    it('throws (propagating Prisma P2025) for a nonexistent comment id', async () => {
      await expect(service.applyContentModerationStatus('comment', randomUUID(), 'removed')).rejects.toMatchObject({ code: 'P2025' });
    });

    it('applies and commits inside a passed-in transaction', async () => {
      const author = await makeUser();
      const post = await makePost(author.id);
      await prisma.$transaction(async (tx) => {
        await service.applyContentModerationStatus('post', post.id, 'removed', tx);
      });
      const updated = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
      expect(updated.status).toBe('removed');
    });

    it('rolls back with the rest of the transaction when the transaction fails after the call', async () => {
      const author = await makeUser();
      const post = await makePost(author.id);
      await expect(
        prisma.$transaction(async (tx) => {
          await service.applyContentModerationStatus('post', post.id, 'removed', tx);
          throw new Error('simulated failure after the status update');
        }),
      ).rejects.toThrow('simulated failure after the status update');
      const unchanged = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
      expect(unchanged.status).toBe('published');
    });
  });

  describe('resolveContentOwnerId', () => {
    it("resolves a post's authorId regardless of status='removed'", async () => {
      const author = await makeUser();
      const post = await makePost(author.id, { status: 'removed' });
      await expect(service.resolveContentOwnerId('post', post.id)).resolves.toBe(author.id);
    });

    it("resolves a post's authorId regardless of a set deletedAt (soft-deleted)", async () => {
      const author = await makeUser();
      const post = await makePost(author.id, { deletedAt: new Date() });
      await expect(service.resolveContentOwnerId('post', post.id)).resolves.toBe(author.id);
    });

    it("resolves a comment's authorId regardless of status='hidden' and deletedAt", async () => {
      const author = await makeUser();
      const post = await makePost(author.id);
      const comment = await makeComment(post.id, author.id, { status: 'hidden', deletedAt: new Date() });
      await expect(service.resolveContentOwnerId('comment', comment.id)).resolves.toBe(author.id);
    });

    it("resolves a share's userId, normalized under the same return shape as post/comment", async () => {
      const author = await makeUser();
      const sharer = await makeUser();
      const post = await makePost(author.id);
      const share = await makeShare(sharer.id, post.id);
      await expect(service.resolveContentOwnerId('share', share.id)).resolves.toBe(sharer.id);
    });

    it("resolves an owner even when their account status is suspended/banned/deleted — visibility-agnostic beyond content status alone", async () => {
      const author = await makeUser({ status: 'banned' });
      const post = await makePost(author.id);
      await expect(service.resolveContentOwnerId('post', post.id)).resolves.toBe(author.id);
    });

    it('returns null (never throws) for a nonexistent post id', async () => {
      await expect(service.resolveContentOwnerId('post', randomUUID())).resolves.toBeNull();
    });

    it('returns null (never throws) for a nonexistent comment id', async () => {
      await expect(service.resolveContentOwnerId('comment', randomUUID())).resolves.toBeNull();
    });

    it('returns null (never throws) for a nonexistent share id', async () => {
      await expect(service.resolveContentOwnerId('share', randomUUID())).resolves.toBeNull();
    });
  });
});
