import { Injectable } from '@nestjs/common';
import type { Appeal } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { ActionsService } from './actions.service';
import { ContentModerationService } from '../content/content-moderation.service';
import { MessagingModerationService } from '../messaging/messaging-moderation.service';
import { ConflictException, ForbiddenActionException, ResourceNotFoundException, ValidationFailedException } from '../common/errors/api-exception';
import type { DecideAppealDto } from './dto/decide-appeal.dto';

export interface AppealResponse {
  id: string;
  actionId: string;
  actionType: string;
  appellantUserId: string;
  statement: string;
  state: string;
  reviewerId: string | null;
  decision: string | null;
  appealDeadline: Date;
  createdAt: Date;
  decidedAt: Date | null;
}

// POST /moderation/appeals/{appealId}/decide (Increment B3). Session-based
// appeal submission and the GET read surfaces are deliberately deferred
// (approved Option B) — the shipped account-appeal credential flow already
// produces real, decidable Appeal rows, which is all this needs.
//
// Field mapping, deliberately NOT a mechanical copy (moderation.md §5's
// documented body is { decision, notes? } — the request's `decision`
// names the OUTCOME and must drive Appeal.state; the DB column also
// named `decision` is "reviewer's written decision/rationale"
// (docs/04-database/moderation.md §7) and is fed from `notes` instead.
// Writing dto.decision into the `decision` column would silently corrupt
// the audit trail with "upheld"/"overturned" instead of the rationale.
//
// `reasonCode` is this increment's own addition (approved) to the
// documented contract — required only for `overturned`, since the
// reversal it triggers needs one (Action.reasonCode is NOT NULL) and
// none exists elsewhere to supply it from.
@Injectable()
export class AppealsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actionsService: ActionsService,
    private readonly contentModeration: ContentModerationService,
    private readonly messagingModeration: MessagingModerationService,
  ) {}

  async decideAppeal(reviewerId: string, appealId: string, dto: DecideAppealDto): Promise<AppealResponse> {
    const appeal = await this.prisma.appeal.findUnique({ where: { id: appealId }, include: { action: true } });
    if (!appeal) {
      throw new ResourceNotFoundException();
    }
    if (appeal.action.actorId === reviewerId) {
      throw new ForbiddenActionException();
    }

    if (dto.decision === 'upheld') {
      // reverseAction is never invoked on this path, so its own
      // self-targeting protection never runs for it either — checked
      // independently here so the same conflict-of-interest guard
      // (Action Reversal §5) applies uniformly to both outcomes, not
      // only the one that happens to reuse reverseAction.
      await this.assertNotSelfTargeting(reviewerId, appeal.action.targetType, appeal.action.targetId);

      const updated = await this.prisma.appeal.updateMany({
        where: { id: appealId, state: { in: ['submitted', 'under_review'] } },
        data: { state: 'upheld', reviewerId, decision: dto.notes ?? null, decidedAt: new Date() },
      });
      if (updated.count === 0) {
        throw new ConflictException('CONFLICT', 'This appeal has already been decided.');
      }
      return this.getAppeal(appealId);
    }

    // overturned
    if (!dto.reasonCode) {
      throw new ValidationFailedException([{ field: 'reasonCode', reason: 'reasonCode is required when decision is overturned' }]);
    }

    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.appeal.updateMany({
        where: { id: appealId, state: { in: ['submitted', 'under_review'] } },
        data: { state: 'overturned', reviewerId, decision: dto.notes ?? null, decidedAt: new Date() },
      });
      if (updated.count === 0) {
        throw new ConflictException('CONFLICT', 'This appeal has already been decided.');
      }

      try {
        await this.actionsService.reverseAction(reviewerId, appeal.actionId, { reasonCode: dto.reasonCode! }, tx);
      } catch (error) {
        // Approved decision: a sanction that's no longer active (already
        // superseded by a later escalation, or already reversed directly)
        // means there is nothing live left to reverse — the appeal's own
        // outcome is still recorded as overturned; only the reversal
        // side-effect is treated as a no-op. Any OTHER failure (e.g. the
        // reviewer==actor/self-targeting checks reverseAction also runs)
        // is a genuine error and must still roll back the whole decision.
        if (!(error instanceof ConflictException)) {
          throw error;
        }
      }
    });

    return this.getAppeal(appealId);
  }

  // Duplicates ActionsService's own private self-targeting check rather
  // than reaching into it — small, same "duplicate a short check over
  // cross-coupling" precedent already used elsewhere this session
  // (isModerator, ReportsService/CasesService). Only reached on the
  // `upheld` path; `overturned` gets this for free via reverseAction.
  private async assertNotSelfTargeting(reviewerId: string, targetType: string, targetId: string): Promise<void> {
    if (targetType === 'profile') {
      if (targetId === reviewerId) {
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
    if (ownerId === reviewerId) {
      throw new ForbiddenActionException();
    }
  }

  private async getAppeal(appealId: string): Promise<AppealResponse> {
    const appeal = await this.prisma.appeal.findUniqueOrThrow({ where: { id: appealId } });
    return this.toResponse(appeal);
  }

  private toResponse(appeal: Appeal): AppealResponse {
    return {
      id: appeal.id,
      actionId: appeal.actionId,
      actionType: appeal.actionType,
      appellantUserId: appeal.appellantUserId,
      statement: appeal.statement,
      state: appeal.state,
      reviewerId: appeal.reviewerId,
      decision: appeal.decision,
      appealDeadline: appeal.appealDeadline,
      createdAt: appeal.createdAt,
      decidedAt: appeal.decidedAt,
    };
  }
}
