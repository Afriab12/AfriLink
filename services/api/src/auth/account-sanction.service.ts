import { Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { generateVerificationCode, sha256 } from './token.util';

export type AccountSanctionStatus = 'suspended' | 'banned';

export interface ResolvedAppealCredential {
  challengeId: string;
  userId: string;
}

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

  // Mirrors AuthService's own MAX_VERIFICATION_ATTEMPTS (5) — that constant
  // is private to auth.service.ts and AuthService is explicitly out of
  // scope for this increment, so the value is duplicated here rather than
  // exported. Keep in sync if the shared policy number ever changes.
  private static readonly MAX_APPEAL_CREDENTIAL_ATTEMPTS = 5;

  // Backs the Account Appeal Credential Flow (docs/05-api/moderation.md §5
  // "Account-sanction appeal initiation"). The delivered credential is a
  // single composite string, `${challengeId}.${rawCode}` — not a bare hash
  // lookup — so an indexed PK read (findUnique by challengeId) does the
  // work a table-wide challengeHash scan would otherwise need, and the
  // existing per-row attemptCount/MAX_APPEAL_CREDENTIAL_ATTEMPTS protection
  // (identical in shape to verify()'s own) still applies unchanged.
  //
  // Read-only with respect to the challenge's *consumption* — it never
  // sets consumedAt, that is consumeAppealCredential's job alone, so a
  // caller can validate before committing to spend the one-time credential.
  // It is NOT read-only in an absolute sense: exactly like verify(), a
  // wrong-code guess still increments attemptCount before returning null —
  // that write cannot be deferred to a later step, since a wrong guess
  // never reaches one. Preserving this existing attempt-count protection
  // takes priority over a literal zero-writes reading of "read-only."
  //
  // Every distinct failure reason (malformed credential, not found, wrong
  // purpose, expired, consumed, attempts exhausted, wrong code) collapses
  // to the same `null` — the caller maps that uniformly to one generic
  // invalid-credential response, never distinguishing which reason applied
  // (matches login()'s existing non-enumerating convention).
  async resolveAppealCredential(credential: string): Promise<ResolvedAppealCredential | null> {
    const separatorIndex = credential.indexOf('.');
    if (separatorIndex <= 0 || separatorIndex === credential.length - 1) {
      return null;
    }
    const challengeId = credential.slice(0, separatorIndex);
    const rawCode = credential.slice(separatorIndex + 1);
    if (!isUUID(challengeId)) {
      return null;
    }

    const challenge = await this.prisma.verificationChallenge.findUnique({ where: { id: challengeId } });
    if (!challenge || challenge.purpose !== 'account_appeal') {
      return null;
    }
    if (challenge.consumedAt !== null) {
      return null;
    }
    if (challenge.expiresAt < new Date()) {
      return null;
    }
    if (challenge.attemptCount >= AccountSanctionService.MAX_APPEAL_CREDENTIAL_ATTEMPTS) {
      return null;
    }

    if (sha256(rawCode.trim()) !== challenge.challengeHash) {
      await this.prisma.verificationChallenge.update({
        where: { id: challengeId },
        data: { attemptCount: { increment: 1 } },
      });
      return null;
    }

    return { challengeId: challenge.id, userId: challenge.userId };
  }

  // The sole consumption write, isolated from resolveAppealCredential so the
  // caller (Moderation's future appeal-creation flow) can validate the
  // Action/Sanction eligibility first and only then commit to spending the
  // credential — inside the exact same transaction as the Appeal insert.
  // `tx` is required, not optional like every sibling method's: this write
  // only ever makes sense paired with an Appeal insert in one transaction,
  // never standalone.
  async consumeAppealCredential(challengeId: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.verificationChallenge.update({
      where: { id: challengeId },
      data: { consumedAt: new Date() },
    });
  }
}
