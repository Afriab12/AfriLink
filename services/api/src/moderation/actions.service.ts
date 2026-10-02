import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Action, ModerationScope } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { ContentModerationService } from '../content/content-moderation.service';
import { MessagingModerationService } from '../messaging/messaging-moderation.service';
import { CommunityModerationService } from '../communities/community-moderation.service';
import { AccountSanctionService } from '../auth/account-sanction.service';
import { AuditService } from '../audit/audit.service';
import { ConflictException, ForbiddenActionException, PolicyRejectedException, ResourceNotFoundException, ValidationFailedException } from '../common/errors/api-exception';
import type { CreateActionDto } from './dto/create-action.dto';
import type { ReverseActionDto } from './dto/reverse-action.dto';

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
  reversalOfActionId?: string;
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
    private readonly audit: AuditService,
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
      await this.audit.record(
        {
          eventType: 'moderation_action_recorded',
          actorId: moderatorId,
          subjectType: dto.targetType,
          subjectId: dto.targetId,
          reason: dto.reasonCode,
          metadata: { actionType: dto.actionType, targetType: dto.targetType, targetId: dto.targetId },
          occurredAt: created.createdAt,
        },
        tx,
      );
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

    // Wrapped in its own $transaction (previously a single statement) so
    // the mandatory moderation_action_recorded write is atomic with the
    // Action insert — approved judgment call #1, Audit B design review.
    const action = await this.prisma.$transaction(async (tx) => {
      const created = await tx.action.create({
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
      await this.audit.record(
        {
          eventType: 'moderation_action_recorded',
          actorId: moderatorId,
          subjectType: 'profile',
          subjectId: dto.targetId,
          reason: dto.reasonCode,
          metadata: { actionType: 'warn_user', targetType: 'profile', targetId: dto.targetId },
          occurredAt: created.createdAt,
        },
        tx,
      );
      return created;
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

        await this.audit.record(
          {
            eventType: 'moderation_action_recorded',
            actorId: moderatorId,
            subjectType: 'profile',
            subjectId: dto.targetId,
            reason: dto.reasonCode,
            metadata: {
              actionType: status === 'suspended' ? 'suspend_account' : 'ban_account',
              targetType: 'profile',
              targetId: dto.targetId,
              sanctionId: sanction.id,
              ...(dto.details?.durationSeconds !== undefined ? { durationSeconds: dto.details.durationSeconds } : {}),
            },
            occurredAt: created.createdAt,
          },
          tx,
        );

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

        await this.audit.record(
          {
            eventType: 'moderation_action_recorded',
            actorId: moderatorId,
            subjectType: 'profile',
            subjectId: dto.targetId,
            reason: dto.reasonCode,
            metadata: {
              actionType: 'restrict_community_participation',
              targetType: 'profile',
              targetId: dto.targetId,
              sanctionId: sanction.id,
              communityId,
              ...(dto.details?.durationSeconds !== undefined ? { durationSeconds: dto.details.durationSeconds } : {}),
            },
            occurredAt: created.createdAt,
          },
          tx,
        );

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

  // Reverses a prior action (moderation.md §4/§7, Decisions recorded item
  // 5). reviewer != actor is the exact appeal-review rule reused, not
  // reinvented. A reversal reuses the ORIGINAL action's own actionType —
  // the schema has no separate "reversal" ModerationActionType — and is
  // distinguished purely by reversalOfActionId being set (database.md §12:
  // "corrections are compensating actions, not destructive updates").
  //
  // Approved decisions (owner review, this increment):
  //  1. A sanction must be verified state='active' before any lift call;
  //     a non-active sanction (superseded by escalation, or already
  //     revoked) rejects the reversal outright with 409 — never a silent
  //     no-op, since silently no-op'ing could look like success while
  //     leaving a currently-enforced, unrelated sanction untouched.
  //  2. Reversing a reversal is forbidden (422 POLICY_REJECTED) — a
  //     correction of a correction must be a fresh new action instead.
  //     A second reversal of the SAME original is 409 CONFLICT, made
  //     race-safe with an advisory lock (no DB uniqueness exists on
  //     reversalOfActionId, so this is the equivalent backstop
  //     MembershipsService.serialised already established for the same
  //     kind of gap).
  //  3. warn_user reversal is an audit-only no-op — Action row only, no
  //     Sanction ever existed for it, nothing else to undo.
  //  4. reasonCode reuses the same ReportReasonCode vocabulary despite
  //     the semantic mismatch (tracked as a follow-up, not fixed here).
  //     No `notes` field — Action has no column to hold it; silently
  //     accepting and discarding would be worse than not accepting it.
  //  5. The self-action rule extends to reversal: a moderator may not
  //     reverse an action whose target is themselves (or, for content,
  //     whose target's owner is themselves) — independent of whether
  //     they were the original actor.
  //  6. Case status is never checked — closure is not a hard lock,
  //     already established for creation, extended here without a fresh
  //     decision.
  // `tx` is optional so a caller that already has its own transaction open
  // (Appeal Decision, B3) can fold this entirely into it, rather than
  // committing as a separate, non-atomic step — the same
  // `tx ?? own-transaction` branch every other multi-statement moderation
  // callee already uses (AccountSanctionService.applyAccountSanction is
  // the closest precedent). Behavior for the standalone `/reverse` route
  // (no `tx` passed) is byte-for-byte unchanged.
  async reverseAction(moderatorId: string, actionId: string, dto: ReverseActionDto, tx?: Prisma.TransactionClient): Promise<ActionResponse> {
    const original = await this.prisma.action.findUnique({ where: { id: actionId } });
    if (!original) {
      throw new ResourceNotFoundException();
    }
    if (original.actorId === moderatorId) {
      throw new ForbiddenActionException();
    }
    if (original.reversalOfActionId !== null) {
      throw new PolicyRejectedException('A reversal cannot itself be reversed.');
    }

    await this.assertNotSelfTargeting(moderatorId, original.targetType as TargetType, original.targetId);

    const execute = async (innerTx: Prisma.TransactionClient) => {
      // Serializes concurrent reversal attempts against the SAME original
      // action. No DB uniqueness exists on reversalOfActionId, so this
      // advisory lock is the race-safe backstop in its place.
      await innerTx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`action-reversal:${actionId}`}, 0))`;

      const existingReversal = await innerTx.action.findFirst({ where: { reversalOfActionId: actionId } });
      if (existingReversal) {
        throw new ConflictException('CONFLICT', 'This action has already been reversed.');
      }

      const sanction = await innerTx.sanction.findFirst({ where: { sourceActionId: actionId } });
      if (sanction && sanction.state !== 'active') {
        throw new ConflictException('CONFLICT', 'This sanction is no longer active and cannot be reversed.');
      }

      const created = await innerTx.action.create({
        data: {
          caseId: original.caseId,
          actorId: moderatorId,
          targetType: original.targetType,
          targetId: original.targetId,
          actionType: original.actionType,
          scope: original.scope,
          reasonCode: dto.reasonCode,
          reversalOfActionId: original.id,
        },
      });

      if (sanction) {
        await innerTx.sanction.update({ where: { id: sanction.id }, data: { state: 'revoked' } });
        if (sanction.subjectType === 'user') {
          await this.accountSanction.liftAccountSanction(sanction.subjectId, innerTx);
        } else {
          await this.communityModeration.liftMembershipSanction(sanction.subjectId, innerTx);
        }
      } else if (original.actionType === 'remove_content' || original.actionType === 'restrict_content') {
        if (original.targetType === 'message') {
          await this.messagingModeration.applyMessageModerationStatus(original.targetId, 'active', innerTx);
        } else {
          await this.contentModeration.applyContentModerationStatus(original.targetType as 'post' | 'comment', original.targetId, 'published', innerTx);
        }
      }
      // warn_user with no sanction: nothing else to undo.

      await this.audit.record(
        {
          eventType: 'moderation_action_reversed',
          actorId: moderatorId,
          subjectType: original.targetType,
          subjectId: original.targetId,
          reason: dto.reasonCode,
          metadata: { actionType: original.actionType, originalActionId: original.id },
          occurredAt: created.createdAt,
        },
        innerTx,
      );

      return created;
    };

    const reversal = tx ? await execute(tx) : await this.prisma.$transaction((innerTx) => execute(innerTx));

    return this.toResponse(reversal);
  }

  // Existence + self-targeting in one step for content/message targets
  // (mirrors createContentAction's own reasoning: resolving the owner
  // does double duty). Profile targets are compared directly — user
  // existence is not re-verified at reversal time, matching the same
  // "a caller that already validated moments earlier should never
  // legitimately hit this" reasoning the creation paths already use.
  private async assertNotSelfTargeting(moderatorId: string, targetType: TargetType, targetId: string): Promise<void> {
    if (targetType === 'profile') {
      if (targetId === moderatorId) {
        throw new ForbiddenActionException();
      }
      return;
    }
    const ownerId =
      targetType === 'message'
        ? await this.messagingModeration.resolveMessageOwnerId(targetId)
        : await this.contentModeration.resolveContentOwnerId(targetType as 'post' | 'comment', targetId);
    if (ownerId === null) {
      throw new ResourceNotFoundException();
    }
    if (ownerId === moderatorId) {
      throw new ForbiddenActionException();
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
      ...(action.reversalOfActionId && { reversalOfActionId: action.reversalOfActionId }),
    };
  }
}
