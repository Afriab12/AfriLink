import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../common/prisma/prisma.service';
import { CasesService } from './cases.service';
import { ConflictException, PolicyRejectedException, ResourceNotFoundException, ValidationFailedException } from '../common/errors/api-exception';

describe('CasesService', () => {
  let prisma: PrismaService;
  let service: CasesService;
  let moderatorRoleId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new CasesService(prisma);
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

  async function makeModerator() {
    const u = await makeUser();
    await grantModerator(u.id);
    return u;
  }

  async function makeReport(overrides: Partial<{ status: string; reporterUserId: string }> = {}) {
    const reporter = overrides.reporterUserId ? { id: overrides.reporterUserId } : await makeUser();
    const author = await makeUser();
    const post = await prisma.post.create({ data: { authorId: author.id, body: 'hi' } });
    return prisma.report.create({
      data: {
        reporterUserId: reporter.id,
        targetType: 'post',
        targetId: post.id,
        reasonCode: 'spam',
        status: (overrides.status as never) ?? 'open',
        dedupKey: randomUUID(),
      },
    });
  }

  // --------------------------------------------------------------- creation

  describe('createCase', () => {
    it('creates a case linking a single open report, transitions it to under_review', async () => {
      const report = await makeReport();
      const result = await service.createCase({ reportIds: [report.id], queue: 'platform', source: 'user_report' });

      expect(result.reportCount).toBe(1);
      expect(result.reports[0].id).toBe(report.id);
      const reloaded = await prisma.report.findUniqueOrThrow({ where: { id: report.id } });
      expect(reloaded.status).toBe('under_review');
    });

    it('creates a case linking multiple open reports', async () => {
      const r1 = await makeReport();
      const r2 = await makeReport();
      const result = await service.createCase({ reportIds: [r1.id, r2.id], queue: 'platform', source: 'user_report' });
      expect(result.reportCount).toBe(2);
    });

    it('defaults priority to normal', async () => {
      const report = await makeReport();
      const result = await service.createCase({ reportIds: [report.id], queue: 'platform', source: 'user_report' });
      expect(result.priority).toBe('normal');
    });

    it('rejects a nonexistent reportId with ResourceNotFoundException', async () => {
      await expect(service.createCase({ reportIds: [randomUUID()], queue: 'platform', source: 'user_report' })).rejects.toThrow(ResourceNotFoundException);
    });

    it('rejects a report that is not currently open with ConflictException', async () => {
      const report = await makeReport({ status: 'closed' });
      await expect(service.createCase({ reportIds: [report.id], queue: 'platform', source: 'user_report' })).rejects.toThrow(ConflictException);
    });

    it('rejects a report already belonging to a case with ConflictException', async () => {
      const report = await makeReport();
      await service.createCase({ reportIds: [report.id], queue: 'platform', source: 'user_report' });
      const other = await makeReport();

      await expect(service.createCase({ reportIds: [report.id, other.id], queue: 'platform', source: 'user_report' })).rejects.toThrow(ConflictException);
      // The unaffected report must not have been linked or transitioned either — the whole request failed atomically.
      const reloadedOther = await prisma.report.findUniqueOrThrow({ where: { id: other.id } });
      expect(reloadedOther.status).toBe('open');
    });

    it('the database uniqueness constraint is the real backstop against duplicate CaseReport linkage (bypassing the service pre-check)', async () => {
      const report = await makeReport();
      const caseA = await prisma.case.create({ data: { queue: 'platform', source: 'user_report' } });
      const caseB = await prisma.case.create({ data: { queue: 'platform', source: 'user_report' } });
      await prisma.caseReport.create({ data: { caseId: caseA.id, reportId: report.id } });

      await expect(prisma.caseReport.create({ data: { caseId: caseB.id, reportId: report.id } })).rejects.toThrow();
    });
  });

  // ------------------------------------------------------------------- read

  describe('getCase', () => {
    it('returns case detail with linked reports and an empty actions array', async () => {
      const report = await makeReport();
      const created = await service.createCase({ reportIds: [report.id], queue: 'platform', source: 'user_report' });
      const fetched = await service.getCase(created.id);
      expect(fetched.actions).toEqual([]);
      expect(fetched.reports).toHaveLength(1);
    });

    it('throws ResourceNotFoundException for a nonexistent case', async () => {
      await expect(service.getCase(randomUUID())).rejects.toThrow(ResourceNotFoundException);
    });
  });

  describe('listCases', () => {
    it('filters by status/queue/priority', async () => {
      const report = await makeReport();
      const created = await service.createCase({ reportIds: [report.id], queue: 'content', source: 'user_report', priority: 'high' } as never);
      const caller = await makeModerator();

      const matching = await service.listCases({ queue: 'content', priority: 'high' } as never, caller.id);
      const nonMatching = await service.listCases({ queue: 'messaging' } as never, caller.id);
      expect(matching.data.some((c) => c.id === created.id)).toBe(true);
      expect(nonMatching.data.some((c) => c.id === created.id)).toBe(false);
    });

    it('assignedModeratorId=me resolves to the caller', async () => {
      const report = await makeReport();
      const created = await service.createCase({ reportIds: [report.id], queue: 'platform', source: 'user_report' });
      const moderator = await makeModerator();
      await service.assignCase(created.id, moderator.id, {});

      const page = await service.listCases({ assignedModeratorId: 'me' } as never, moderator.id);
      expect(page.data.some((c) => c.id === created.id)).toBe(true);
    });

    it('rejects an assignedModeratorId that is neither "me" nor a UUID with ValidationFailedException', async () => {
      const caller = await makeModerator();
      await expect(service.listCases({ assignedModeratorId: 'not-a-uuid-or-me' } as never, caller.id)).rejects.toThrow(ValidationFailedException);
    });

    it('reportCount is derived from linked CaseReport rows', async () => {
      const r1 = await makeReport();
      const r2 = await makeReport();
      const created = await service.createCase({ reportIds: [r1.id, r2.id], queue: 'platform', source: 'user_report' });
      const caller = await makeModerator();

      const page = await service.listCases({}, caller.id);
      const row = page.data.find((c) => c.id === created.id);
      expect(row?.reportCount).toBe(2);
    });
  });

  // -------------------------------------------------------------- assignment

  describe('assignCase', () => {
    it('self-assigns and sets status to in_review', async () => {
      const report = await makeReport();
      const created = await service.createCase({ reportIds: [report.id], queue: 'platform', source: 'user_report' });
      const moderator = await makeModerator();

      const result = await service.assignCase(created.id, moderator.id, {});
      expect(result.assignedModeratorId).toBe(moderator.id);
      expect(result.status).toBe('in_review');
    });

    it('assigns to another moderator by moderatorId', async () => {
      const report = await makeReport();
      const created = await service.createCase({ reportIds: [report.id], queue: 'platform', source: 'user_report' });
      const caller = await makeModerator();
      const target = await makeModerator();

      const result = await service.assignCase(created.id, caller.id, { moderatorId: target.id });
      expect(result.assignedModeratorId).toBe(target.id);
    });

    it('rejects assigning to a user who does not hold the moderator role with PolicyRejectedException', async () => {
      const report = await makeReport();
      const created = await service.createCase({ reportIds: [report.id], queue: 'platform', source: 'user_report' });
      const caller = await makeModerator();
      const nonModerator = await makeUser();

      await expect(service.assignCase(created.id, caller.id, { moderatorId: nonModerator.id })).rejects.toThrow(PolicyRejectedException);
    });

    it('rejects assigning to a nonexistent user with ResourceNotFoundException', async () => {
      const report = await makeReport();
      const created = await service.createCase({ reportIds: [report.id], queue: 'platform', source: 'user_report' });
      const caller = await makeModerator();

      await expect(service.assignCase(created.id, caller.id, { moderatorId: randomUUID() })).rejects.toThrow(ResourceNotFoundException);
    });

    it('allows reassignment on a non-closed case', async () => {
      const report = await makeReport();
      const created = await service.createCase({ reportIds: [report.id], queue: 'platform', source: 'user_report' });
      const first = await makeModerator();
      const second = await makeModerator();
      await service.assignCase(created.id, first.id, {});

      const result = await service.assignCase(created.id, first.id, { moderatorId: second.id });
      expect(result.assignedModeratorId).toBe(second.id);
    });

    it('rejects assigning a closed case with ConflictException', async () => {
      const report = await makeReport();
      const created = await service.createCase({ reportIds: [report.id], queue: 'platform', source: 'user_report' });
      const moderator = await makeModerator();
      await service.closeCase(created.id);

      await expect(service.assignCase(created.id, moderator.id, {})).rejects.toThrow(ConflictException);
    });

    it('throws ResourceNotFoundException for a nonexistent case', async () => {
      const moderator = await makeModerator();
      await expect(service.assignCase(randomUUID(), moderator.id, {})).rejects.toThrow(ResourceNotFoundException);
    });
  });

  // ---------------------------------------------------------------- priority

  describe('updateCasePriority', () => {
    it('updates priority and nothing else', async () => {
      const report = await makeReport();
      const created = await service.createCase({ reportIds: [report.id], queue: 'platform', source: 'user_report' });

      const result = await service.updateCasePriority(created.id, { priority: 'critical' });
      expect(result.priority).toBe('critical');
      expect(result.status).toBe('open');
    });

    it('throws ResourceNotFoundException for a nonexistent case', async () => {
      await expect(service.updateCasePriority(randomUUID(), { priority: 'high' })).rejects.toThrow(ResourceNotFoundException);
    });
  });

  // ---------------------------------------------------------------- closure

  describe('closeCase', () => {
    it('closes the case and transitions linked open reports to closed', async () => {
      const report = await makeReport();
      const created = await service.createCase({ reportIds: [report.id], queue: 'platform', source: 'user_report' });

      const result = await service.closeCase(created.id);
      expect(result.status).toBe('closed');
      const reloaded = await prisma.report.findUniqueOrThrow({ where: { id: report.id } });
      expect(reloaded.status).toBe('closed');
    });

    it('leaves an already-closed linked report unchanged', async () => {
      const r1 = await makeReport();
      const r2 = await makeReport();
      const created = await service.createCase({ reportIds: [r1.id, r2.id], queue: 'platform', source: 'user_report' });
      const before = await prisma.report.update({ where: { id: r2.id }, data: { status: 'closed', resolvedAt: new Date('2020-01-01') } });

      await service.closeCase(created.id);
      const after = await prisma.report.findUniqueOrThrow({ where: { id: r2.id } });
      expect(after.resolvedAt?.getTime()).toBe(before.resolvedAt?.getTime());
    });

    it('is idempotent: closing an already-closed case succeeds and returns closed', async () => {
      const report = await makeReport();
      const created = await service.createCase({ reportIds: [report.id], queue: 'platform', source: 'user_report' });
      await service.closeCase(created.id);

      const result = await service.closeCase(created.id);
      expect(result.status).toBe('closed');
    });

    it('throws ResourceNotFoundException for a nonexistent case', async () => {
      await expect(service.closeCase(randomUUID())).rejects.toThrow(ResourceNotFoundException);
    });

    it('is safe under concurrent close calls (no throw, both settle closed)', async () => {
      const report = await makeReport();
      const created = await service.createCase({ reportIds: [report.id], queue: 'platform', source: 'user_report' });

      const [a, b] = await Promise.allSettled([service.closeCase(created.id), service.closeCase(created.id)]);
      expect(a.status).toBe('fulfilled');
      expect(b.status).toBe('fulfilled');
      const reloaded = await prisma.report.findUniqueOrThrow({ where: { id: report.id } });
      expect(reloaded.status).toBe('closed');
    });

    it('performs the case-close and linked-report-close inside exactly one $transaction call — structural proof of atomicity, not just the happy-path outcome', async () => {
      const report = await makeReport();
      const created = await service.createCase({ reportIds: [report.id], queue: 'platform', source: 'user_report' });

      const spy = vi.spyOn(prisma, '$transaction');
      await service.closeCase(created.id);
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });

    it('an assign/close race never leaves an assigned-but-closed case: the assign either wins cleanly or is rejected as CONFLICT', async () => {
      const report = await makeReport();
      const created = await service.createCase({ reportIds: [report.id], queue: 'platform', source: 'user_report' });
      const moderator = await makeModerator();

      const [assignResult, closeResult] = await Promise.allSettled([service.assignCase(created.id, moderator.id, {}), service.closeCase(created.id)]);
      expect(closeResult.status).toBe('fulfilled');

      const final = await service.getCase(created.id);
      if (assignResult.status === 'fulfilled') {
        // The assign won the race before the close — a legal, non-closed intermediate state at assign time.
        expect(['in_review', 'closed']).toContain(final.status);
      } else {
        expect((assignResult as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
      }
      // Whichever branch won, the case is never left "in_review" with closedAt also set.
      if (final.status === 'in_review') {
        expect(final.closedAt).toBeNull();
      }
    });
  });
});
