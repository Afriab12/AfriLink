import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Action, ModerationScope } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { ContentModerationService } from '../content/content-moderation.service';
import { MessagingModerationService } from '../messaging/messaging-moderation.service';
import { CommunityModerationService } from '../communities/community-moderation.service';
import { AccountSanctionService } from '../auth/account-sanction.service';
import { ConflictException, ForbiddenActionException, PolicyRejectedException, ResourceNotFoundException, ValidationFailedException } from '../common/errors/api-exception';
import type { CreateActionDto } from './dto/create-action.dto';

export interface ActionResponse {
  id: string;
  caseId: string;
  actorId: string | null;
  targetType: string;
  targetId: string;
  actionType: string;
  scope: string;
  reasonCode: string;
  durationSeconds: number | null;
  startsAt: Date;
  endsAt: Date | null;
  createdAt: Date;
  sanctionId?: string;
}

type ActionType = CreateActionDto['actionType'];
type TargetType = CreateActionDto['targetType'];

// Which targetTypes each actionType may legally pair with. `share` is
// deliberately absent from remove_content/restrict_content — approved
// decision #5: ContentModerationService.applyContentModerationStatus has
// no support for it, and none is being added here.
const VALID_TARGET_TYPES: Record<ActionType, ReadonlySet<TargetType>> = {
  remove_content: new Set(['post', 'comment', 'message']),
  restrict_content: new Set(['post', 'comment', 'message']),
  warn_user: new Set(['profile']),
  suspend_account: new Set(['profile']),
  ban_account: new Set(['profile']),
  restrict_community_participation: new Set(['profile']),
};

// Case creation → Action → (Sanction + target-state change), per
// moderation.md §4 / the B1 design review. One endpoint, discriminated by
// actionType — never routed as six separate resources, matching the
// already-approved "one table, one audit trail" reasoning.
//
// Case status is never checked here — closure is not a hard lock
// (moderation.md §3, already approved): an action may be created against
// an open, in_review, or closed case alike.
//
// Duplicate non-sanction actions (remove_content/restrict_content/
// warn_user) are allowed without restriction — approved Option B,
// append-only moderation history. No pre-check, no uniqueness added.
@Injectable()
export class ActionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly contentModeration: ContentModerationService,
    private readonly messagingModeration: MessagingModerationService,
    private readonly communityModeration: CommunityModerationService,
    private readonly accountSanction: AccountSanctionService,
  ) {}

  async createAction(moderatorId: string, caseId: string, dto: CreateActionDto): Promise<ActionResponse> {
    const kase = await this.prisma.case.findUnique({ where: { id: caseId }, select: { id: true, queue: true } });
    if (!kase) {
      throw new ResourceNotFoundException();
    }

    if (!VALID_TARGET_TYPES[dto.actionType].has(dto.targetType)) {
      throw new PolicyRejectedException(`${dto.actionType} cannot target a ${dto.targetType}.`);
    }

    switch (dto.actionType) {
      case 'remove_content':
        return this.createContentAction(moderatorId, kase.id, dto, 'removed');
      case 'restrict_content':
        return this.createContentAction(moderatorId, kase.id, dto, 'hidden');
      case 'warn_user':
        return this.createWarnAction(moderatorId, kase.id, kase.queue, dto);
      case 'suspend_account':
        return this.createAccountSanctionAction(moderatorId, kase.id, dto, 'suspended');
      case 'ban_account':
        return this.createAccountSanctionAction(moderatorId, kase.id, dto, 'banned');
      case 'restrict_community_participation':
        return this.createCommunityAction(moderatorId, kase.id, dto);
    }
  }

  // ------------------------------------------------------- content/message

  // `resolveContentOwnerId`/`resolveMessageOwnerId` are the same
  // privileged, visibility-independent lookups Reports (Increment A) and
  // the account-appeal flow already use — never the ordinary
  // PostAccessService/MessagingAccessService (viewer-relative, would hide
  // already-removed/blocked content a moderator must still be able to act
  // on). Resolving the owner does double duty here: it is both the
  // existence check and the input to the self-action check.
  private async createContentAction(moderatorId: string, caseId: string, dto: CreateActionDto, status: 'removed' | 'hidden'): Promise<ActionResponse> {
    const ownerId =
      dto.targetType === 'message'
        ? await this.messagingModeration.resolveMessageOwnerId(dto.targetId)
        : await this.contentModeration.resolveContentOwnerId(dto.targetType as 'post' | 'comment', dto.targetId);
    if (ownerId === null) {
      throw new ResourceNotFoundException();
    }
    if (ownerId === moderatorId) {
      throw new ForbiddenActionException();
    }

    const action = await this.prisma.$transaction(async (tx) => {
      const created = await tx.action.create({
        data: {
          caseId,
          actorId: moderatorId,
          targetType: dto.targetType,
          targetId: dto.targetId,
          actionType: dto.actionType,
          scope: 'content',
          reasonCode: dto.reasonCode,
        },
      });
      if (dto.targetType === 'message') {
        await this.messagingModeration.applyMessageModerationStatus(dto.targetId, status, tx);
      } else {
        await this.contentModeration.applyContentModerationStatus(dto.targetType as 'post' | 'comment', dto.targetId, status, tx);
      }
      return created;
    });
    return this.toResponse(action);
  }

  // -------------------------------------------------------------- warning

  // No Sanction, no Notification, no producer invented — the Action row
  // itself is the durable moderation record (approved §18). `scope` is
  // informational only for this actionType (moderation.md §4): the
  // case's own queue, not derived from any single report.
  private async createWarnAction(moderatorId: string, caseId: string, queue: ModerationScope, dto: CreateActionDto): Promise<ActionResponse> {
    if (dto.targetId === moderatorId) {
      throw new ForbiddenActionException();
    }
    const user = await this.prisma.user.findUnique({ where: { id: dto.targetId }, select: { id: true } });
    if (!user) {
      throw new ResourceNotFoundException();
    }

    const action = await this.prisma.action.create({
      data: {
        caseId,
        actorId: moderatorId,
        targetType: 'profile',
        targetId: dto.targetId,
        actionType: 'warn_user',
        scope: queue,
        reasonCode: dto.reasonCode,
      },
    });
    return this.toResponse(action);
  }

  // ------------------------------------------------------- account sanction

  private async createAccountSanctionAction(moderatorId: string, caseId: string, dto: CreateActionDto, status: 'suspended' | 'banned'): Promise<ActionResponse> {
    if (status === 'banned' && dto.details?.durationSeconds !== undefined) {
      throw new ValidationFailedException([{ field: 'details.durationSeconds', reason: 'ban_account is always indefinite; durationSeconds must not be supplied' }]);
    }
    if (dto.targetId === moderatorId) {
      throw new ForbiddenActionException();
    }
    const user = await this.prisma.user.findUnique({ where: { id: dto.targetId }, select: { id: true } });
    if (!user) {
      throw new ResourceNotFoundException();
    }

    const existing = await this.prisma.sanction.findFirst({
      where: { subjectType: 'user', subjectId: dto.targetId, scope: 'platform', state: 'active' },
    });

    // Ban → suspend is a policy conflict, rejected outright before
    // anything is created (approved §14) — distinct from the ordinary
    // duplicate-sanction case below, which the DB constraint backstops.
    if (existing && existing.sanctionType === 'account_banned' && status === 'suspended') {
      throw new ConflictException('CONFLICT', 'This account is already banned and cannot be suspended.');
    }

    // Suspend → ban is the one approved escalation (§13): the prior
    // active sanction is superseded in the same transaction as the new
    // one is created. Every other combination (no prior sanction, or a
    // same-type repeat) takes the plain creation path below and relies
    // on the partial-unique (subjectType,subjectId,scope) WHERE active
    // constraint as the backstop, caught as a clean 409.
    const supersedes = existing && existing.sanctionType === 'account_suspended' && status === 'banned' ? existing.id : null;
    const endsAt = dto.details?.durationSeconds ? new Date(Date.now() + dto.details.durationSeconds * 1000) : null;

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const created = await tx.action.create({
          data: {
            caseId,
            actorId: moderatorId,
            targetType: 'profile',
            targetId: dto.targetId,
            actionType: status === 'suspended' ? 'suspend_account' : 'ban_account',
            scope: 'platform',
            reasonCode: dto.reasonCode,
            durationSeconds: dto.details?.durationSeconds,
            endsAt,
          },
        });

        if (supersedes) {
          await tx.sanction.update({ where: { id: supersedes }, data: { state: 'superseded' } });
        }

        const sanction = await tx.sanction.create({
          data: {
            subjectType: 'user',
            subjectId: dto.targetId,
            scope: 'platform',
            sanctionType: status === 'suspended' ? 'account_suspended' : 'account_banned',
            reasonCode: dto.reasonCode,
            sourceActionId: created.id,
            endsAt,
          },
        });

        await this.accountSanction.applyAccountSanction(dto.targetId, status, sanction.id, tx);

        return { action: created, sanctionId: sanction.id };
      });
      return this.toResponse(result.action, result.sanctionId);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('CONFLICT', 'This account already has an active sanction in this scope.');
      }
      throw error;
    }
  }

  // ----------------------------------------------------------- community

  private async createCommunityAction(moderatorId: string, caseId: string, dto: CreateActionDto): Promise<ActionResponse> {
    const communityId = dto.details?.communityId;
    if (!communityId) {
      throw new ValidationFailedException([{ field: 'details.communityId', reason: 'details.communityId is required for restrict_community_participation' }]);
    }
    if (dto.targetId === moderatorId) {
      throw new ForbiddenActionException();
    }

    const membership = await this.communityModeration.resolveMembership(communityId, dto.targetId);
    if (!membership) {
      throw new ResourceNotFoundException();
    }

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const created = await tx.action.create({
          data: {
            caseId,
            actorId: moderatorId,
            targetType: 'profile',
            targetId: dto.targetId,
            actionType: 'restrict_community_participation',
            scope: 'community',
            reasonCode: dto.reasonCode,
            durationSeconds: dto.details?.durationSeconds,
          },
        });

        // subjectId = the CommunityMembership row's own id, never the
        // community's id and never the user's id — the only choice
        // consistent with the (subjectType,subjectId,scope) WHERE active
        // uniqueness constraint correctly scoping "one active restriction
        // per member per community," approved during design review.
        const sanction = await tx.sanction.create({
          data: {
            subjectType: 'community',
            subjectId: membership.id,
            scope: 'community',
            sanctionType: 'community_restricted',
            reasonCode: dto.reasonCode,
            sourceActionId: created.id,
          },
        });

        // Always 'banned', never 'removed' — K.1, unchanged.
        await this.communityModeration.applyMembershipSanction(membership.id, 'banned', tx);

        return { action: created, sanctionId: sanction.id };
      });
      return this.toResponse(result.action, result.sanctionId);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('CONFLICT', 'This membership already has an active restriction.');
      }
      throw error;
    }
  }

  private toResponse(action: Action, sanctionId?: string): ActionResponse {
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
      ...(sanctionId && { sanctionId }),
    };
  }
}
