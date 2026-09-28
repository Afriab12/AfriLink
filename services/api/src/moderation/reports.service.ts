import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Report } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { ContentModerationService } from '../content/content-moderation.service';
import { MessagingModerationService } from '../messaging/messaging-moderation.service';
import { CommunityModerationService } from '../communities/community-moderation.service';
import { sha256 } from '../auth/token.util';
import { ConflictException, InvalidCursorException, PolicyRejectedException, ResourceNotFoundException } from '../common/errors/api-exception';
import { clampLimit, decodeCursor, toPage, type CursorPageResult } from '../common/pagination/cursor';
import type { CreateReportDto } from './dto/create-report.dto';
import type { ListReportsQueryDto } from './dto/list-reports-query.dto';
import type { CursorQueryDto } from '../common/dto/cursor-query.dto';

export interface ReportResponse {
  id: string;
  targetType: string;
  targetId: string;
  reasonCode: string;
  description: string | null;
  status: string;
  createdAt: Date;
  resolvedAt: Date | null;
}

export interface ModerationReportResponse extends ReportResponse {
  reporterUserId: string;
}

type ReportTargetType = 'profile' | 'post' | 'comment' | 'share' | 'message' | 'conversation' | 'community';

// Report intake and read access (moderation.md §2/§6). Reports + Cases only
// — no Action/Sanction/Appeal work here (docs/10-decisions §K.1 scope).
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly contentModeration: ContentModerationService,
    private readonly messagingModeration: MessagingModerationService,
    private readonly communityModeration: CommunityModerationService,
  ) {}

  // Privileged, visibility-independent existence checks — never the
  // ordinary user-facing access services (PostAccessService etc.), which
  // hide blocked/private/removed content. A report must be accepted for
  // content the reporter cannot currently see; it must be rejected only for
  // a target that plainly does not exist.
  private async targetExists(targetType: ReportTargetType, targetId: string): Promise<boolean> {
    switch (targetType) {
      case 'profile': {
        const user = await this.prisma.user.findUnique({ where: { id: targetId }, select: { id: true } });
        return user !== null;
      }
      case 'post':
      case 'comment':
      case 'share':
        return (await this.contentModeration.resolveContentOwnerId(targetType, targetId)) !== null;
      case 'message':
        return (await this.messagingModeration.resolveMessageOwnerId(targetId)) !== null;
      case 'conversation': {
        const conversation = await this.prisma.conversation.findUnique({ where: { id: targetId }, select: { id: true } });
        return conversation !== null;
      }
      case 'community':
        return (await this.communityModeration.resolveCommunityOwnerId(targetId)) !== null;
    }
  }

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

  async createReport(reporterUserId: string, dto: CreateReportDto): Promise<ReportResponse> {
    if (dto.targetType === 'profile' && dto.targetId === reporterUserId) {
      throw new PolicyRejectedException('You cannot report your own profile.');
    }

    const exists = await this.targetExists(dto.targetType, dto.targetId);
    if (!exists) {
      throw new ResourceNotFoundException();
    }

    // Same-reporter dedup only (reports_active_dedup_key is a partial
    // unique index scoped to open/under_review) — different reporters
    // targeting the same thing are independent, never collapsed
    // (moderation.md §15 item 4).
    const dedupKey = sha256(`${reporterUserId}:${dto.targetType}:${dto.targetId}:${dto.reasonCode}`);

    try {
      const report = await this.prisma.report.create({
        data: {
          reporterUserId,
          targetType: dto.targetType,
          targetId: dto.targetId,
          reasonCode: dto.reasonCode,
          description: dto.description,
          dedupKey,
        },
      });
      return this.toResponse(report);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('CONFLICT', 'You have already reported this.');
      }
      throw error;
    }
  }

  async listMyReports(reporterUserId: string, query: CursorQueryDto): Promise<CursorPageResult<ReportResponse>> {
    const take = clampLimit(query.limit);
    const decoded = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !decoded) {
      throw new InvalidCursorException();
    }

    const rows = await this.prisma.report.findMany({
      where: {
        reporterUserId,
        ...(decoded && { OR: [{ createdAt: { lt: decoded.createdAt } }, { createdAt: decoded.createdAt, id: { lt: decoded.id } }] }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
    });

    const page = toPage(rows, take);
    return { data: page.data.map((r) => this.toResponse(r)), nextCursor: page.nextCursor, hasMore: page.hasMore };
  }

  // Non-enumerating: "doesn't exist" and "exists but caller may not see it"
  // collapse into the identical 404 (matches PostAccessService/
  // AccountAppealsService's established rule).
  async getReport(callerId: string, reportId: string): Promise<ReportResponse> {
    const report = await this.prisma.report.findUnique({ where: { id: reportId } });
    if (!report) {
      throw new ResourceNotFoundException();
    }
    if (report.reporterUserId !== callerId && !(await this.isModerator(callerId))) {
      throw new ResourceNotFoundException();
    }
    return this.toResponse(report);
  }

  async listModerationReports(query: ListReportsQueryDto): Promise<CursorPageResult<ModerationReportResponse>> {
    const take = clampLimit(query.limit);
    const decoded = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !decoded) {
      throw new InvalidCursorException();
    }

    const rows = await this.prisma.report.findMany({
      where: {
        ...(query.status && { status: query.status }),
        ...(query.priority && { priority: query.priority }),
        ...(query.targetType && { targetType: query.targetType }),
        ...(query.reasonCode && { reasonCode: query.reasonCode }),
        ...(decoded && { OR: [{ createdAt: { lt: decoded.createdAt } }, { createdAt: decoded.createdAt, id: { lt: decoded.id } }] }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
    });

    const page = toPage(rows, take);
    return { data: page.data.map((r) => this.toModerationResponse(r)), nextCursor: page.nextCursor, hasMore: page.hasMore };
  }

  private toResponse(report: Report): ReportResponse {
    return {
      id: report.id,
      targetType: report.targetType,
      targetId: report.targetId,
      reasonCode: report.reasonCode,
      description: report.description,
      status: report.status,
      createdAt: report.createdAt,
      resolvedAt: report.resolvedAt,
    };
  }

  private toModerationResponse(report: Report): ModerationReportResponse {
    return { ...this.toResponse(report), reporterUserId: report.reporterUserId };
  }
}
