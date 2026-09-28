import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Appeal } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { AccountSanctionService } from '../auth/account-sanction.service';
import {
  ConflictException,
  PolicyRejectedException,
  ResourceNotFoundException,
  TokenInvalidException,
} from '../common/errors/api-exception';
import type { CreateAccountAppealDto } from './dto/create-account-appeal.dto';

export interface AccountAppealResponse {
  id: string;
  actionId: string;
  actionType: string;
  appellantUserId: string;
  statement: string;
  state: string;
  appealDeadline: Date;
  createdAt: Date;
}

// Only these two actionTypes are appealable through the credential-based
// route (docs/05-api/moderation.md §5) — every other actionType goes
// through the normal, session-based POST /moderation/actions/{id}/appeal
// route instead (not built yet), which this endpoint never substitutes for.
const APPEALABLE_ACTION_TYPES = new Set<string>(['suspend_account', 'ban_account']);

// Narrow mitigation: `liftAccountSanction` (Identity's own, unmodified
// method) only ever touches `User.status` — it never transitions
// `Sanction.state`, since that synchronization belongs to the not-yet-built
// Moderation action/decision/reversal lifecycle. Until that exists, a
// credential issued while suspended/banned remains technically valid
// (unconsumed, unexpired, correct hash) even after the sanction is lifted
// through that method. This checks the one field that IS kept correct
// today — the caller's current account status — as an additional gate.
const SANCTIONABLE_STATUSES = new Set<string>(['suspended', 'banned']);

// Same 72h window the normal appeal route already uses (ADR-001 §2/PRD
// §28) — not a new policy number, not a new configuration mechanism.
const APPEAL_REVIEW_WINDOW_MS = 72 * 60 * 60 * 1000;

// The first real Moderation route: consumes an account_appeal credential
// (AccountSanctionService.resolveAppealCredential/consumeAppealCredential)
// and creates the Appeal row. Public — no JwtAuthGuard, no session
// involved at all (docs/05-api/moderation.md §5, Decision #14).
@Injectable()
export class AccountAppealsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accountSanction: AccountSanctionService,
  ) {}

  async submitAccountAppeal(dto: CreateAccountAppealDto): Promise<AccountAppealResponse> {
    const resolved = await this.accountSanction.resolveAppealCredential(dto.credential);
    if (!resolved) {
      throw new TokenInvalidException('This appeal credential is invalid or has expired.');
    }

    // Collapsed into the identical generic credential-invalid response, not
    // a new distinguishable error — from the caller's perspective a stale
    // credential from an already-active account must look exactly like one
    // that never resolved at all (see the design audit's "active user with
    // a stale credential" finding).
    const currentUser = await this.prisma.user.findUnique({ where: { id: resolved.userId }, select: { status: true } });
    if (!currentUser || !SANCTIONABLE_STATUSES.has(currentUser.status)) {
      throw new TokenInvalidException('This appeal credential is invalid or has expired.');
    }

    // Non-enumerating: "doesn't exist" and "exists but isn't yours" collapse
    // into the identical 404, matching PostAccessService/MediaAccessService's
    // established "never disambiguate why a resource is unreachable" rule.
    const action = await this.prisma.action.findUnique({ where: { id: dto.actionId } });
    if (!action || action.targetType !== 'profile' || action.targetId !== resolved.userId) {
      throw new ResourceNotFoundException();
    }

    if (!APPEALABLE_ACTION_TYPES.has(action.actionType)) {
      throw new PolicyRejectedException('This action cannot be appealed through the account-appeal credential flow.');
    }

    // A stale-but-still-valid credential (issued while sanctioned, never
    // consumed) must not be usable once the underlying sanction has already
    // been resolved through some other path (e.g. a moderator reversal).
    // No Sanction row at all is treated the same as an inactive one —
    // defensive, since suspend_account/ban_account are expected to always
    // produce exactly one, and a missing one signals something inconsistent
    // rather than something safe to proceed past.
    const sanction = await this.prisma.sanction.findFirst({
      where: { sourceActionId: action.id },
      orderBy: { createdAt: 'desc' },
    });
    if (!sanction || sanction.state !== 'active') {
      throw new PolicyRejectedException('This sanction is no longer active and cannot be appealed.');
    }

    // Any existing Appeal for this action blocks a new one — active
    // (submitted/under_review, also the DB's own partial-unique backstop)
    // or already-decided (upheld/overturned, which the DB alone would not
    // block, since its partial-unique index excludes terminal states).
    const existingAppeal = await this.prisma.appeal.findFirst({ where: { actionId: action.id } });
    if (existingAppeal) {
      throw new ConflictException('CONFLICT', 'An appeal for this action already exists.');
    }

    try {
      const appeal = await this.prisma.$transaction(async (tx) => {
        // Consume first, inside the same transaction as the insert: if the
        // insert below fails (e.g. the race this pre-check can't fully
        // close), the whole transaction rolls back and the credential is
        // never actually spent.
        await this.accountSanction.consumeAppealCredential(resolved.challengeId, tx);
        return tx.appeal.create({
          data: {
            actionId: action.id,
            actionType: action.actionType,
            appellantUserId: resolved.userId,
            statement: dto.statement,
            appealDeadline: new Date(Date.now() + APPEAL_REVIEW_WINDOW_MS),
          },
        });
      });
      return this.toResponse(appeal);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // Lost the race against the partial-unique-active-appeal
        // constraint — the transaction has already rolled back in full,
        // so the credential was never actually consumed.
        throw new ConflictException('CONFLICT', 'An appeal for this action already exists.');
      }
      throw error;
    }
  }

  private toResponse(appeal: Appeal): AccountAppealResponse {
    return {
      id: appeal.id,
      actionId: appeal.actionId,
      actionType: appeal.actionType,
      appellantUserId: appeal.appellantUserId,
      statement: appeal.statement,
      state: appeal.state,
      appealDeadline: appeal.appealDeadline,
      createdAt: appeal.createdAt,
    };
  }
}
