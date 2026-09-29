import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Action, Case, CaseReport, Report } from '@prisma/client';
import { isUUID } from 'class-validator';
import { PrismaService } from '../common/prisma/prisma.service';
import { ConflictException, InvalidCursorException, PolicyRejectedException, ResourceNotFoundException, ValidationFailedException } from '../common/errors/api-exception';
import { clampLimit, decodeCursor, toPage, type CursorPageResult } from '../common/pagination/cursor';
import type { ModerationReportResponse } from './reports.service';
import type { ActionResponse } from './actions.service';
import type { CreateCaseDto } from './dto/create-case.dto';
import type { AssignCaseDto } from './dto/assign-case.dto';
import type { UpdateCasePriorityDto } from './dto/update-case-priority.dto';
import type { ListCasesQueryDto } from './dto/list-cases-query.dto';

export interface CaseSummaryResponse {
  id: string;
  queue: string;
  status: string;
  priority: string;
  assignedModeratorId: string | null;
  source: string;
  slaDueAt: Date | null;
  createdAt: Date;
  closedAt: Date | null;
  reportCount: number;
}

export interface CaseDetailResponse extends CaseSummaryResponse {
  reports: ModerationReportResponse[];
  actions: ActionResponse[];
}

// Case creation/assignment/priority/closure (moderation.md §7). Manual
// creation only — no auto-case trigger exists yet; an automated caller
// would call createCase with source='automated_signal', same primitive,
// when that increment is designed (not built here).
@Injectable()
export class CasesService {
  constructor(private readonly prisma: PrismaService) {}

  private async isModerator(userId: string): Promise<boolean> {
    const grant = await this.prisma.userRole.findFirst({
      where: {
        userId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        role: { key: 'moderator' },
      },
      select: { id: true },
    });
    return grant !== null;
  }

  // Every report validated before the transaction opens (§8): must exist,
  // must be 'open', must not already belong to a case. The partial-unique
  // case_reports_report_id_key remains the final backstop against a
  // concurrent create racing the same report into two cases.
  async createCase(dto: CreateCaseDto): Promise<CaseDetailResponse> {
    const uniqueIds = [...new Set(dto.reportIds)];
    const reports = await this.prisma.report.findMany({ where: { id: { in: uniqueIds } }, select: { id: true, status: true } });
    if (reports.length !== uniqueIds.length) {
      throw new ResourceNotFoundException();
    }
    if (reports.some((r) => r.status !== 'open')) {
      throw new ConflictException('CONFLICT', 'Every report must currently be open.');
    }
    const alreadyLinked = await this.prisma.caseReport.findFirst({ where: { reportId: { in: uniqueIds } } });
    if (alreadyLinked) {
      throw new ConflictException('CONFLICT', 'One or more reports already belong to a case.');
    }

    let caseId: string;
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const kase = await tx.case.create({ data: { queue: dto.queue, priority: dto.priority ?? 'normal', source: dto.source } });
        await tx.caseReport.createMany({ data: uniqueIds.map((reportId) => ({ caseId: kase.id, reportId })) });
        await tx.report.updateMany({ where: { id: { in: uniqueIds } }, data: { status: 'under_review' } });
        return kase;
      });
      caseId = created.id;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('CONFLICT', 'One or more reports already belong to a case.');
      }
      throw error;
    }
    return this.getCase(caseId);
  }

  async listCases(query: ListCasesQueryDto, callerId: string): Promise<CursorPageResult<CaseSummaryResponse>> {
    const take = clampLimit(query.limit);
    const decoded = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !decoded) {
      throw new InvalidCursorException();
    }

    let assignedModeratorId: string | undefined;
    if (query.assignedModeratorId === 'me') {
      assignedModeratorId = callerId;
    } else if (query.assignedModeratorId !== undefined) {
      if (!isUUID(query.assignedModeratorId)) {
        throw new ValidationFailedException([{ field: 'assignedModeratorId', reason: 'assignedModeratorId must be a UUID or "me"' }]);
      }
      assignedModeratorId = query.assignedModeratorId;
    }

    const rows = await this.prisma.case.findMany({
      where: {
        ...(query.queue && { queue: query.queue }),
        ...(query.status && { status: query.status }),
        ...(query.priority && { priority: query.priority }),
        ...(assignedModeratorId && { assignedModeratorId }),
        ...(decoded && { OR: [{ createdAt: { lt: decoded.createdAt } }, { createdAt: decoded.createdAt, id: { lt: decoded.id } }] }),
      },
      include: { _count: { select: { caseReports: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
    });

    const page = toPage(rows, take);
    return { data: page.data.map((c) => this.toSummaryResponse(c, c._count.caseReports)), nextCursor: page.nextCursor, hasMore: page.hasMore };
  }

  async getCase(caseId: string): Promise<CaseDetailResponse> {
    const kase = await this.prisma.case.findUnique({
      where: { id: caseId },
      include: {
        caseReports: { include: { report: true } },
        actions: { include: { sanctions: { select: { id: true } } }, orderBy: [{ createdAt: 'desc' }] },
      },
    });
    if (!kase) {
      throw new ResourceNotFoundException();
    }
    return this.toDetailResponse(kase);
  }

  // Closed-case protection (§1/§15): a conditional update (WHERE status <>
  // 'closed') is the atomic guard against the assign/close race — the row
  // lock the UPDATE itself takes is sufficient, no explicit database lock.
  async assignCase(caseId: string, callerId: string, dto: AssignCaseDto): Promise<CaseSummaryResponse> {
    const kase = await this.prisma.case.findUnique({ where: { id: caseId }, select: { id: true, status: true } });
    if (!kase) {
      throw new ResourceNotFoundException();
    }
    if (kase.status === 'closed') {
      throw new ConflictException('CONFLICT', 'This case is closed and cannot be assigned.');
    }

    const targetModeratorId = dto.moderatorId ?? callerId;
    if (dto.moderatorId) {
      const targetUser = await this.prisma.user.findUnique({ where: { id: targetModeratorId }, select: { id: true } });
      if (!targetUser) {
        throw new ResourceNotFoundException();
      }
    }
    if (!(await this.isModerator(targetModeratorId))) {
      throw new PolicyRejectedException('The target user does not hold the moderator role.');
    }

    const updated = await this.prisma.case.updateMany({
      where: { id: caseId, status: { not: 'closed' } },
      data: { assignedModeratorId: targetModeratorId, status: 'in_review' },
    });
    if (updated.count === 0) {
      throw new ConflictException('CONFLICT', 'This case is closed and cannot be assigned.');
    }
    return this.getCaseSummary(caseId);
  }

  async updateCasePriority(caseId: string, dto: UpdateCasePriorityDto): Promise<CaseSummaryResponse> {
    const kase = await this.prisma.case.findUnique({ where: { id: caseId }, select: { id: true } });
    if (!kase) {
      throw new ResourceNotFoundException();
    }
    await this.prisma.case.update({ where: { id: caseId }, data: { priority: dto.priority } });
    return this.getCaseSummary(caseId);
  }

  // Idempotent (§13): a second close is a no-op 200, not an error. The
  // conditional updateMany inside the transaction is what makes two
  // concurrent closes safe — only one of them actually transitions the
  // linked reports.
  async closeCase(caseId: string): Promise<CaseSummaryResponse> {
    const kase = await this.prisma.case.findUnique({ where: { id: caseId }, select: { id: true, status: true } });
    if (!kase) {
      throw new ResourceNotFoundException();
    }
    if (kase.status !== 'closed') {
      await this.prisma.$transaction(async (tx) => {
        const closed = await tx.case.updateMany({ where: { id: caseId, status: { not: 'closed' } }, data: { status: 'closed', closedAt: new Date() } });
        if (closed.count === 0) {
          return;
        }
        const links = await tx.caseReport.findMany({ where: { caseId }, select: { reportId: true } });
        await tx.report.updateMany({
          where: { id: { in: links.map((l) => l.reportId) }, status: { in: ['open', 'under_review'] } },
          data: { status: 'closed', resolvedAt: new Date() },
        });
      });
    }
    return this.getCaseSummary(caseId);
  }

  private async getCaseSummary(caseId: string): Promise<CaseSummaryResponse> {
    const kase = await this.prisma.case.findUniqueOrThrow({ where: { id: caseId }, include: { _count: { select: { caseReports: true } } } });
    return this.toSummaryResponse(kase, kase._count.caseReports);
  }

  private toSummaryResponse(kase: Case, reportCount: number): CaseSummaryResponse {
    return {
      id: kase.id,
      queue: kase.queue,
      status: kase.status,
      priority: kase.priority,
      assignedModeratorId: kase.assignedModeratorId,
      source: kase.source,
      slaDueAt: kase.slaDueAt,
      createdAt: kase.createdAt,
      closedAt: kase.closedAt,
      reportCount,
    };
  }

  private toReportSummary(report: Report): ModerationReportResponse {
    return {
      id: report.id,
      targetType: report.targetType,
      targetId: report.targetId,
      reasonCode: report.reasonCode,
      description: report.description,
      status: report.status,
      createdAt: report.createdAt,
      resolvedAt: report.resolvedAt,
      reporterUserId: report.reporterUserId,
    };
  }

  private toActionResponse(action: Action & { sanctions: { id: string }[] }): ActionResponse {
    return {
      id: action.id,
      caseId: action.caseId,
      actorId: action.actorId,
      targetType: action.targetType,
      targetId: action.targetId,
      actionType: action.actionType,
      scope: action.scope,
      reasonCode: action.reasonCode,
      durationSeconds: action.durationSeconds,
      startsAt: action.startsAt,
      endsAt: action.endsAt,
      createdAt: action.createdAt,
      ...(action.sanctions[0] && { sanctionId: action.sanctions[0].id }),
    };
  }

  private toDetailResponse(
    kase: Case & { caseReports: (CaseReport & { report: Report })[]; actions: (Action & { sanctions: { id: string }[] })[] },
  ): CaseDetailResponse {
    return {
      ...this.toSummaryResponse(kase, kase.caseReports.length),
      reports: kase.caseReports.map((cr) => this.toReportSummary(cr.report)),
      actions: kase.actions.map((a) => this.toActionResponse(a)),
    };
  }
}
