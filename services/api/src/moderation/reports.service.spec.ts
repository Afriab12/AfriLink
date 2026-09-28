import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../common/prisma/prisma.service';
import { ContentModerationService } from '../content/content-moderation.service';
import { MessagingModerationService } from '../messaging/messaging-moderation.service';
import { CommunityModerationService } from '../communities/community-moderation.service';
import { ReportsService } from './reports.service';
import { ConflictException, InvalidCursorException, PolicyRejectedException, ResourceNotFoundException } from '../common/errors/api-exception';

// Unit-level, real PrismaService — same pattern as every other moderation
// spec this increment (account-appeals.service.spec.ts, content-moderation.
// service.spec.ts, etc.).
describe('ReportsService', () => {
  let prisma: PrismaService;
  let service: ReportsService;
  let moderatorRoleId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new ReportsService(prisma, new ContentModerationService(prisma), new MessagingModerationService(prisma), new CommunityModerationService(prisma));
    const role = await prisma.role.upsert({
      where: { key: 'moderator' },
      update: {},
      create: { key: 'moderator', name: 'Moderator', description: 'test fixture' },
    });
    moderatorRoleId = role.id;
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  async function makeUser() {
    return prisma.user.create({ data: { updatedAt: new Date() } });
  }

  async function grantModerator(userId: string) {
    await prisma.userRole.create({ data: { userId, roleId: moderatorRoleId } });
  }

  async function makePost(authorId: string) {
    return prisma.post.create({ data: { authorId, body: 'hello' } });
  }

  async function makeConversation(createdBy: string) {
    const other = await makeUser();
    const [a, b] = [createdBy, other.id].sort();
    return prisma.conversation.create({ data: { createdBy, directParticipantAId: a, directParticipantBId: b } });
  }

  // ---------------------------------------------------------------- create

  describe('createReport', () => {
    it('creates a report against an existing post target, 201-shape response, never echoes reporterUserId', async () => {
      const reporter = await makeUser();
      const author = await makeUser();
      const post = await makePost(author.id);

      const result = await service.createReport(reporter.id, { targetType: 'post', targetId: post.id, reasonCode: 'spam' });

      expect(result.targetType).toBe('post');
      expect(result.targetId).toBe(post.id);
      expect(result.status).toBe('open');
      expect((result as unknown as { reporterUserId?: string }).reporterUserId).toBeUndefined();
    });

    it('rejects a self-report (profile target === reporter) with PolicyRejectedException', async () => {
      const reporter = await makeUser();
      await expect(service.createReport(reporter.id, { targetType: 'profile', targetId: reporter.id, reasonCode: 'spam' })).rejects.toThrow(
        PolicyRejectedException,
      );
    });

    it('rejects a nonexistent post target with ResourceNotFoundException', async () => {
      const reporter = await makeUser();
      await expect(service.createReport(reporter.id, { targetType: 'post', targetId: randomUUID(), reasonCode: 'spam' })).rejects.toThrow(
        ResourceNotFoundException,
      );
    });

    it('rejects a nonexistent profile target with ResourceNotFoundException', async () => {
      const reporter = await makeUser();
      await expect(service.createReport(reporter.id, { targetType: 'profile', targetId: randomUUID(), reasonCode: 'spam' })).rejects.toThrow(
        ResourceNotFoundException,
      );
    });

    it('rejects a nonexistent conversation target with ResourceNotFoundException', async () => {
      const reporter = await makeUser();
      await expect(service.createReport(reporter.id, { targetType: 'conversation', targetId: randomUUID(), reasonCode: 'spam' })).rejects.toThrow(
        ResourceNotFoundException,
      );
    });

    it('accepts an existing conversation target', async () => {
      const reporter = await makeUser();
      const creator = await makeUser();
      const conversation = await makeConversation(creator.id);
      const result = await service.createReport(reporter.id, { targetType: 'conversation', targetId: conversation.id, reasonCode: 'spam' });
      expect(result.targetType).toBe('conversation');
    });

    it('accepts reporting another profile that exists', async () => {
      const reporter = await makeUser();
      const target = await makeUser();
      const result = await service.createReport(reporter.id, { targetType: 'profile', targetId: target.id, reasonCode: 'harassment' });
      expect(result.targetId).toBe(target.id);
    });

    it('rejects a same-reporter active duplicate (same target/reasonCode) with ConflictException', async () => {
      const reporter = await makeUser();
      const author = await makeUser();
      const post = await makePost(author.id);
      await service.createReport(reporter.id, { targetType: 'post', targetId: post.id, reasonCode: 'spam' });

      await expect(service.createReport(reporter.id, { targetType: 'post', targetId: post.id, reasonCode: 'spam' })).rejects.toThrow(ConflictException);
    });

    it('allows a different reporter to independently report the same target', async () => {
      const reporter1 = await makeUser();
      const reporter2 = await makeUser();
      const author = await makeUser();
      const post = await makePost(author.id);
      await service.createReport(reporter1.id, { targetType: 'post', targetId: post.id, reasonCode: 'spam' });

      const result = await service.createReport(reporter2.id, { targetType: 'post', targetId: post.id, reasonCode: 'spam' });
      expect(result.targetId).toBe(post.id);
    });

    it('allows the same reporter to report an already-blocked/removed target — existence, not visibility, gates intake', async () => {
      const reporter = await makeUser();
      const author = await makeUser();
      const post = await makePost(author.id);
      await prisma.post.update({ where: { id: post.id }, data: { status: 'removed' } });

      const result = await service.createReport(reporter.id, { targetType: 'post', targetId: post.id, reasonCode: 'spam' });
      expect(result.targetId).toBe(post.id);
    });
  });

  // ------------------------------------------------------------- read access

  describe('getReport', () => {
    it('returns the report to its own reporter', async () => {
      const reporter = await makeUser();
      const author = await makeUser();
      const post = await makePost(author.id);
      const created = await service.createReport(reporter.id, { targetType: 'post', targetId: post.id, reasonCode: 'spam' });

      const fetched = await service.getReport(reporter.id, created.id);
      expect(fetched.id).toBe(created.id);
    });

    it("rejects another user's report with ResourceNotFoundException", async () => {
      const reporter = await makeUser();
      const stranger = await makeUser();
      const author = await makeUser();
      const post = await makePost(author.id);
      const created = await service.createReport(reporter.id, { targetType: 'post', targetId: post.id, reasonCode: 'spam' });

      await expect(service.getReport(stranger.id, created.id)).rejects.toThrow(ResourceNotFoundException);
    });

    it('allows a moderator to retrieve another user\'s report', async () => {
      const reporter = await makeUser();
      const moderator = await makeUser();
      await grantModerator(moderator.id);
      const author = await makeUser();
      const post = await makePost(author.id);
      const created = await service.createReport(reporter.id, { targetType: 'post', targetId: post.id, reasonCode: 'spam' });

      const fetched = await service.getReport(moderator.id, created.id);
      expect(fetched.id).toBe(created.id);
    });

    it('rejects a nonexistent report with ResourceNotFoundException', async () => {
      const caller = await makeUser();
      await expect(service.getReport(caller.id, randomUUID())).rejects.toThrow(ResourceNotFoundException);
    });

    it('produces the identical error for "does not exist" and "belongs to someone else" (non-enumerating)', async () => {
      const reporter = await makeUser();
      const stranger = await makeUser();
      const author = await makeUser();
      const post = await makePost(author.id);
      const created = await service.createReport(reporter.id, { targetType: 'post', targetId: post.id, reasonCode: 'spam' });

      const [otherUsers, nonexistent] = await Promise.allSettled([service.getReport(stranger.id, created.id), service.getReport(stranger.id, randomUUID())]);
      expect(otherUsers.status).toBe('rejected');
      expect(nonexistent.status).toBe('rejected');
      expect((otherUsers as PromiseRejectedResult).reason).toBeInstanceOf(ResourceNotFoundException);
      expect((nonexistent as PromiseRejectedResult).reason).toBeInstanceOf(ResourceNotFoundException);
    });
  });

  // ---------------------------------------------------------------- listing

  describe('listMyReports', () => {
    it('returns only the caller\'s own reports, ordered (createdAt, id) desc', async () => {
      const reporter = await makeUser();
      const other = await makeUser();
      const author = await makeUser();
      const postA = await makePost(author.id);
      const postB = await makePost(author.id);
      await service.createReport(other.id, { targetType: 'post', targetId: postA.id, reasonCode: 'spam' });
      const r1 = await service.createReport(reporter.id, { targetType: 'post', targetId: postA.id, reasonCode: 'spam' });
      const r2 = await service.createReport(reporter.id, { targetType: 'post', targetId: postB.id, reasonCode: 'harassment' });

      const page = await service.listMyReports(reporter.id, {});
      expect(page.data.map((r) => r.id)).toEqual([r2.id, r1.id]);
    });

    it('throws InvalidCursorException for a malformed cursor', async () => {
      const reporter = await makeUser();
      await expect(service.listMyReports(reporter.id, { cursor: 'not-a-real-cursor' })).rejects.toThrow(InvalidCursorException);
    });

    it('closed reports remain visible (status is never filtered on /me/reports)', async () => {
      const reporter = await makeUser();
      const author = await makeUser();
      const post = await makePost(author.id);
      const created = await service.createReport(reporter.id, { targetType: 'post', targetId: post.id, reasonCode: 'spam' });
      await prisma.report.update({ where: { id: created.id }, data: { status: 'closed' } });

      const page = await service.listMyReports(reporter.id, {});
      expect(page.data.some((r) => r.id === created.id && r.status === 'closed')).toBe(true);
    });
  });

  describe('listModerationReports', () => {
    it('exposes reporterUserId on the moderator-only surface', async () => {
      const reporter = await makeUser();
      const author = await makeUser();
      const post = await makePost(author.id);
      const created = await service.createReport(reporter.id, { targetType: 'post', targetId: post.id, reasonCode: 'spam' });

      const page = await service.listModerationReports({});
      const row = page.data.find((r) => r.id === created.id);
      expect(row?.reporterUserId).toBe(reporter.id);
    });

    it('filters by status', async () => {
      const reporter = await makeUser();
      const author = await makeUser();
      const post = await makePost(author.id);
      const created = await service.createReport(reporter.id, { targetType: 'post', targetId: post.id, reasonCode: 'spam' });
      await prisma.report.update({ where: { id: created.id }, data: { status: 'closed' } });

      const openPage = await service.listModerationReports({ status: 'open' });
      const closedPage = await service.listModerationReports({ status: 'closed' });
      expect(openPage.data.some((r) => r.id === created.id)).toBe(false);
      expect(closedPage.data.some((r) => r.id === created.id)).toBe(true);
    });

    it('filters by targetType and reasonCode', async () => {
      const reporter = await makeUser();
      const author = await makeUser();
      const post = await makePost(author.id);
      const created = await service.createReport(reporter.id, { targetType: 'post', targetId: post.id, reasonCode: 'harassment' });

      const matching = await service.listModerationReports({ targetType: 'post', reasonCode: 'harassment' });
      const nonMatching = await service.listModerationReports({ targetType: 'post', reasonCode: 'spam' });
      expect(matching.data.some((r) => r.id === created.id)).toBe(true);
      expect(nonMatching.data.some((r) => r.id === created.id)).toBe(false);
    });

    it('closed reports remain queryable (status filter absent returns all)', async () => {
      const reporter = await makeUser();
      const author = await makeUser();
      const post = await makePost(author.id);
      const created = await service.createReport(reporter.id, { targetType: 'post', targetId: post.id, reasonCode: 'spam' });
      await prisma.report.update({ where: { id: created.id }, data: { status: 'closed' } });

      const page = await service.listModerationReports({});
      expect(page.data.some((r) => r.id === created.id)).toBe(true);
    });
  });
});
