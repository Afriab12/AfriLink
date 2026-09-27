import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { generateVerificationCode, sha256 } from './token.util';

export type AccountSanctionStatus = 'suspended' | 'banned';

// The cross-module surface docs/05-api/moderation.md §7 names as
// "Moderation → Identity": applyAccountSanction executes suspend_account/
// ban_account, liftAccountSanction reverses either on appeal-overturn or
// moderator self-correction. Never routed — reachable only via AuthModule's
// export + Nest DI (same boundary ContentModerationService/
// MessagingModerationService/CommunityModerationService already rely on),
// so there is no request path for an ordinary user to hit these directly.
// No second moderator-authorization system here: this service trusts its
// caller completely, exactly like its three siblings.
//
// `status` is deliberately typed `'suspended' | 'banned'` — never the full
// 6-value `UserStatus` union. `active` is reachable only through
// liftAccountSanction (which never takes a status parameter at all, it can
// only ever write the literal 'active'); `restricted`/`pending_deletion`/
// `deleted` are not reachable through this contract at all, by the type
// system, not by convention.
//
// banned -> suspended has no special-cased path and no read-before-write
// transition guard, by owner decision — Moderation's own action-creation
// flow must compose liftAccountSanction then applyAccountSanction instead
// of calling this directly for a "downgrade." Adding a guard here would
// make this the one moderation callee that isn't a pure trusted-caller
// write, breaking the pattern all four siblings share.
@Injectable()
export class AccountSanctionService {
  constructor(private readonly prisma: PrismaService) {}

  // Matches the approved appeal window (ADR-001 §2/PRD §28's 72h
  // appealDeadline), not the unrelated 15-minute code TTL AuthService uses
  // for email/phone verification and password reset — this credential is
  // the sanctioned user's sole route back in for as long as the appeal
  // window itself is open, so its own expiry must not be shorter than that.
  private static readonly APPEAL_CHALLENGE_TTL_MS = 72 * 60 * 60 * 1000;

  // Three writes that must commit or fail together: the status change, the
  // session revocation, and the appeal-credential issuance (per
  // docs/05-api/moderation.md §7 — issuance is "a side effect of
  // applyAccountSanction, not a separate call site"). Unlike its three
  // siblings (each a single statement), this method is genuinely
  // multi-statement, so — unlike them — it must open its own transaction
  // when the caller doesn't supply one; a bare `tx ?? this.prisma` would
  // leave these three writes non-atomic in the common no-tx case. A
  // Prisma.TransactionClient cannot itself start a nested transaction
  // (nested $transaction is not part of that type), which is why the
  // control flow below branches instead of unconditionally wrapping.
  //
  // `sanctionId` is accepted to match the already-approved cross-module
  // signature (docs/05-api/moderation.md §7) but is not persisted anywhere
  // in Identity's own tables — no FK from identity.* to moderation.* is
  // introduced here, matching the same "no FK is added from any other
  // schema's tables to moderation.*" principle docs/04-database/
  // moderation.md already established for the reverse direction.
  async applyAccountSanction(
    userId: string,
    status: AccountSanctionStatus,
    sanctionId?: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const execute = async (client: Prisma.TransactionClient) => {
      await client.user.update({ where: { id: userId }, data: { status } });

      await client.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date(), revokeReason: 'account_sanctioned' },
      });

      // Only verified, non-revoked channels — never fabricate a delivery
      // channel. If neither exists, enforcement above still stands; only
      // appeal-credential issuance is best-effort (see the spec's own
      // determination on this, mirrored here).
      const verifiedCredentials = await client.credential.findMany({
        where: { userId, revokedAt: null, verifiedAt: { not: null } },
      });

      for (const credential of verifiedCredentials) {
        const code = generateVerificationCode();
        await client.verificationChallenge.create({
          data: {
            userId,
            channel: credential.kind,
            destinationHash: sha256(credential.identifierNormalized),
            purpose: 'account_appeal',
            challengeHash: sha256(code),
            expiresAt: new Date(Date.now() + AccountSanctionService.APPEAL_CHALLENGE_TTL_MS),
          },
        });
      }
    };

    if (tx) {
      await execute(tx);
    } else {
      await this.prisma.$transaction((innerTx) => execute(innerTx));
    }
  }

  // Restores User.status to 'active' — nothing else. No session, no JWT, no
  // re-login, no appeal-credential issuance, no role change: an overturned
  // or self-corrected sanction restores exactly the one field it changed,
  // matching liftMembershipSanction's own single-field-only precedent.
  async liftAccountSanction(userId: string, tx?: Prisma.TransactionClient): Promise<void> {
    const client = tx ?? this.prisma;
    await client.user.update({ where: { id: userId }, data: { status: 'active' } });
  }
}
