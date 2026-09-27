import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { AccountSanctionService } from './account-sanction.service';

// Unit-level (no HTTP layer, direct PrismaService instantiation — same
// pattern as content-moderation.service.spec.ts/messaging-moderation.service.
// spec.ts/community-moderation.service.spec.ts): AccountSanctionService is
// the cross-module surface Moderation will call (docs/05-api/moderation.md
// §7) — applyAccountSanction/liftAccountSanction execute and reverse
// suspend_account/ban_account. Not yet consumed by any module (Moderation
// doesn't exist yet) — built and tested in isolation now so it is correct
// before anything depends on it.
describe('AccountSanctionService', () => {
  let prisma: PrismaService;
  let service: AccountSanctionService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new AccountSanctionService(prisma);
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  async function makeUser(overrides: Partial<{ status: string }> = {}) {
    return prisma.user.create({ data: { status: (overrides.status as never) ?? 'active', updatedAt: new Date() } });
  }

  async function makeCredential(userId: string, kind: 'email' | 'phone', overrides: Partial<{ verified: boolean }> = {}) {
    return prisma.credential.create({
      data: {
        userId,
        kind,
        identifierNormalized: kind === 'email' ? `${randomUUID()}@example.com` : `+1555${randomUUID().slice(0, 7)}`,
        secretHash: 'irrelevant-for-these-tests',
        verifiedAt: (overrides.verified ?? true) ? new Date() : null,
      },
    });
  }

  async function makeSession(userId: string, overrides: Partial<{ revokedAt: Date; revokeReason: string }> = {}) {
    return prisma.session.create({
      data: {
        userId,
        refreshTokenHash: randomUUID(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        revokedAt: overrides.revokedAt ?? null,
        revokeReason: overrides.revokeReason ?? null,
      },
    });
  }

  async function challengesFor(userId: string) {
    return prisma.verificationChallenge.findMany({ where: { userId, purpose: 'account_appeal' } });
  }

  describe('applyAccountSanction — status transitions', () => {
    it('active -> suspended', async () => {
      const user = await makeUser();
      await service.applyAccountSanction(user.id, 'suspended');
      const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(updated.status).toBe('suspended');
    });

    it('active -> banned', async () => {
      const user = await makeUser();
      await service.applyAccountSanction(user.id, 'banned');
      const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(updated.status).toBe('banned');
    });

    it('suspended -> banned (escalation)', async () => {
      const user = await makeUser({ status: 'suspended' });
      await service.applyAccountSanction(user.id, 'banned');
      const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(updated.status).toBe('banned');
    });

    // banned -> suspended is deliberately NOT a special-cased operation.
    // Per the owner decision, no read-before-write transition guard exists
    // anywhere in this service — AccountSanctionService is a trusted
    // internal callee that writes exactly what it's told, the same as
    // Content/Messaging/Community's own moderation services. This test
    // proves that: calling applyAccountSanction(bannedUser, 'suspended')
    // is NOT rejected and is NOT treated specially — it's the identical
    // unconditional write any other status value would get. The actual
    // policy ("compose liftAccountSanction then applyAccountSanction
    // instead of calling this directly") is a calling-convention constraint
    // on Moderation's future action-creation flow, not something enforced
    // here — this method must never be silently documented or implemented
    // as if it had bespoke downgrade semantics.
    it('banned -> suspended is not rejected and is not special-cased (no transition guard exists)', async () => {
      const user = await makeUser({ status: 'banned' });
      await service.applyAccountSanction(user.id, 'suspended');
      const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(updated.status).toBe('suspended');
    });

    it('repeated suspended is safe (no error, status unchanged, sessions stay revoked)', async () => {
      const user = await makeUser();
      await makeSession(user.id);
      await service.applyAccountSanction(user.id, 'suspended');
      await service.applyAccountSanction(user.id, 'suspended');
      const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(updated.status).toBe('suspended');
      const sessions = await prisma.session.findMany({ where: { userId: user.id } });
      expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);
    });

    it('repeated banned is safe (no error, status unchanged)', async () => {
      const user = await makeUser();
      await service.applyAccountSanction(user.id, 'banned');
      await service.applyAccountSanction(user.id, 'banned');
      const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(updated.status).toBe('banned');
    });
  });

  describe('applyAccountSanction — session revocation', () => {
    it('revokes every currently active session for the user', async () => {
      const user = await makeUser();
      const s1 = await makeSession(user.id);
      const s2 = await makeSession(user.id);
      const s3 = await makeSession(user.id);
      await service.applyAccountSanction(user.id, 'suspended');
      for (const s of [s1, s2, s3]) {
        const row = await prisma.session.findUniqueOrThrow({ where: { id: s.id } });
        expect(row.revokedAt).not.toBeNull();
        expect(row.revokeReason).toBe('account_sanctioned');
      }
    });

    it("does not touch another user's sessions", async () => {
      const user = await makeUser();
      const other = await makeUser();
      const otherSession = await makeSession(other.id);
      await service.applyAccountSanction(user.id, 'banned');
      const row = await prisma.session.findUniqueOrThrow({ where: { id: otherSession.id } });
      expect(row.revokedAt).toBeNull();
    });

    it('leaves an already-revoked session\'s original revokeReason untouched', async () => {
      const user = await makeUser();
      const already = await makeSession(user.id, { revokedAt: new Date('2026-01-01T00:00:00Z'), revokeReason: 'logout' });
      await service.applyAccountSanction(user.id, 'banned');
      const row = await prisma.session.findUniqueOrThrow({ where: { id: already.id } });
      expect(row.revokeReason).toBe('logout');
    });
  });

  describe('applyAccountSanction — appeal challenge issuance by channel', () => {
    it('issues exactly one challenge, to email, when only email is verified', async () => {
      const user = await makeUser();
      await makeCredential(user.id, 'email', { verified: true });
      await service.applyAccountSanction(user.id, 'suspended');
      const challenges = await challengesFor(user.id);
      expect(challenges).toHaveLength(1);
      expect(challenges[0].channel).toBe('email');
    });

    it('issues exactly one challenge, to phone, when only phone is verified', async () => {
      const user = await makeUser();
      await makeCredential(user.id, 'phone', { verified: true });
      await service.applyAccountSanction(user.id, 'suspended');
      const challenges = await challengesFor(user.id);
      expect(challenges).toHaveLength(1);
      expect(challenges[0].channel).toBe('phone');
    });

    it('issues two independently usable challenges when both email and phone are verified', async () => {
      const user = await makeUser();
      await makeCredential(user.id, 'email', { verified: true });
      await makeCredential(user.id, 'phone', { verified: true });
      await service.applyAccountSanction(user.id, 'banned');
      const challenges = await challengesFor(user.id);
      expect(challenges).toHaveLength(2);
      expect(challenges.map((c) => c.channel).sort()).toEqual(['email', 'phone']);
      // Independently usable: distinct hashes, each its own unconsumed row.
      expect(challenges[0].challengeHash).not.toBe(challenges[1].challengeHash);
      expect(challenges.every((c) => c.consumedAt === null)).toBe(true);
    });

    it('issues no challenge for an unverified credential', async () => {
      const user = await makeUser();
      await makeCredential(user.id, 'email', { verified: false });
      await service.applyAccountSanction(user.id, 'suspended');
      const challenges = await challengesFor(user.id);
      expect(challenges).toHaveLength(0);
    });

    // C — determined, not fabricated: with no verified channel at all,
    // enforcement (status + session revocation) still succeeds
    // unconditionally; only challenge issuance is best-effort. Refusing to
    // apply a sanction because the sanctioned user never verified a channel
    // would let an unverified account become effectively unsanctionable —
    // a real loophole. No existing Auth convention fabricates a delivery
    // channel, so none is invented here either: zero challenges is the
    // correct, non-invented outcome.
    it('applies the sanction even when no channel is verified at all — enforcement never depends on appeal-delivery availability', async () => {
      const user = await makeUser();
      await service.applyAccountSanction(user.id, 'banned');
      const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(updated.status).toBe('banned');
      const challenges = await challengesFor(user.id);
      expect(challenges).toHaveLength(0);
    });

    it('sets purpose = account_appeal on every issued challenge', async () => {
      const user = await makeUser();
      await makeCredential(user.id, 'email', { verified: true });
      await service.applyAccountSanction(user.id, 'suspended');
      const challenge = await prisma.verificationChallenge.findFirstOrThrow({ where: { userId: user.id } });
      expect(challenge.purpose).toBe('account_appeal');
    });

    it('binds the issued challenge to the sanctioned user specifically, not merely to some valid user', async () => {
      const user = await makeUser();
      // A second, unrelated real user — proves binding is semantic (the
      // exact right user), not just "any valid FK." A mutation that wrote
      // some OTHER real user's id would still pass a foreign-key check;
      // this test only passes if the challenge's userId is genuinely
      // user.id and not merely a row that exists.
      const decoy = await makeUser();
      await makeCredential(user.id, 'email', { verified: true });
      await service.applyAccountSanction(user.id, 'suspended');

      const relevantIssued = await prisma.verificationChallenge.findMany({
        where: { purpose: 'account_appeal', userId: { in: [user.id, decoy.id] } },
      });
      expect(relevantIssued).toHaveLength(1);
      expect(relevantIssued[0].userId).toBe(user.id);
      expect(relevantIssued[0].userId).not.toBe(decoy.id);

      const decoyChallenges = await challengesFor(decoy.id);
      expect(decoyChallenges).toHaveLength(0);
    });

    it('does not use a revoked credential as a delivery channel', async () => {
      const user = await makeUser();
      const credential = await makeCredential(user.id, 'email', { verified: true });
      await prisma.credential.update({ where: { id: credential.id }, data: { revokedAt: new Date() } });
      await service.applyAccountSanction(user.id, 'suspended');
      const challenges = await challengesFor(user.id);
      expect(challenges).toHaveLength(0);
    });
  });

  describe('liftAccountSanction', () => {
    it('restores a suspended account to active', async () => {
      const user = await makeUser({ status: 'suspended' });
      await service.liftAccountSanction(user.id);
      const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(updated.status).toBe('active');
    });

    it('restores a banned account to active', async () => {
      const user = await makeUser({ status: 'banned' });
      await service.liftAccountSanction(user.id);
      const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(updated.status).toBe('active');
    });

    it('is idempotent when lifted again', async () => {
      const user = await makeUser({ status: 'banned' });
      await service.liftAccountSanction(user.id);
      await service.liftAccountSanction(user.id);
      const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(updated.status).toBe('active');
    });

    it('creates no session', async () => {
      const user = await makeUser({ status: 'suspended' });
      const before = await prisma.session.count({ where: { userId: user.id } });
      await service.liftAccountSanction(user.id);
      const after = await prisma.session.count({ where: { userId: user.id } });
      expect(after).toBe(before);
    });

    it('creates no verification challenge', async () => {
      const user = await makeUser({ status: 'banned' });
      const before = await prisma.verificationChallenge.count({ where: { userId: user.id } });
      await service.liftAccountSanction(user.id);
      const after = await prisma.verificationChallenge.count({ where: { userId: user.id } });
      expect(after).toBe(before);
    });

    it('throws (propagating Prisma P2025) for a nonexistent user id', async () => {
      await expect(service.liftAccountSanction(randomUUID())).rejects.toMatchObject({ code: 'P2025' });
    });
  });

  describe('applyAccountSanction — nonexistent user', () => {
    it('throws (propagating Prisma P2025) and performs no partial writes', async () => {
      await expect(service.applyAccountSanction(randomUUID(), 'suspended')).rejects.toMatchObject({ code: 'P2025' });
    });
  });

  describe('applyAccountSanction — transaction support', () => {
    it('applies and commits inside a passed-in transaction', async () => {
      const user = await makeUser();
      await makeCredential(user.id, 'email', { verified: true });
      await prisma.$transaction(async (tx) => {
        await service.applyAccountSanction(user.id, 'suspended', undefined, tx);
      });
      const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(updated.status).toBe('suspended');
      const challenges = await challengesFor(user.id);
      expect(challenges).toHaveLength(1);
    });

    it('rolls back status, session revocation, and challenge issuance together when the transaction fails after the call', async () => {
      const user = await makeUser();
      await makeCredential(user.id, 'email', { verified: true });
      const session = await makeSession(user.id);
      await expect(
        prisma.$transaction(async (tx) => {
          await service.applyAccountSanction(user.id, 'banned', undefined, tx);
          throw new Error('simulated failure after the sanction');
        }),
      ).rejects.toThrow('simulated failure after the sanction');

      const unchangedUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(unchangedUser.status).toBe('active');
      const unchangedSession = await prisma.session.findUniqueOrThrow({ where: { id: session.id } });
      expect(unchangedSession.revokedAt).toBeNull();
      const challenges = await challengesFor(user.id);
      expect(challenges).toHaveLength(0);
    });

    it('rolls back cleanly without a passed-in transaction too (its own internal transaction)', async () => {
      const user = await makeUser();
      await makeCredential(user.id, 'email', { verified: true });
      // A nonexistent user forces P2025 on the very first statement inside
      // the service's own internal transaction — nothing else should have
      // run or persisted for a DIFFERENT, real user in the same test.
      await expect(service.applyAccountSanction(randomUUID(), 'banned')).rejects.toMatchObject({ code: 'P2025' });
      const untouched = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(untouched.status).toBe('active');
    });
  });
});

// Compile-time guarantee, not a runtime one: arbitrary UserStatus values
// (including 'active', 'restricted', 'pending_deletion', 'deleted') must be
// impossible to pass to applyAccountSanction — the type union is
// 'suspended' | 'banned' only. This block is never executed (vitest/swc
// strips types without checking them); it is enforced by `tsc --noEmit`,
// which fails if these directives become unused (i.e. if the type were
// ever loosened to accept them).
function typeLevelGuarantees(service: AccountSanctionService, userId: string, tx: Prisma.TransactionClient) {
  // @ts-expect-error 'active' must not be assignable — only liftAccountSanction may restore it.
  void service.applyAccountSanction(userId, 'active', undefined, tx);
  // @ts-expect-error 'restricted' is not a Moderation-assignable status.
  void service.applyAccountSanction(userId, 'restricted', undefined, tx);
  // @ts-expect-error 'pending_deletion' is not a Moderation-assignable status.
  void service.applyAccountSanction(userId, 'pending_deletion', undefined, tx);
  // @ts-expect-error 'deleted' is not a Moderation-assignable status.
  void service.applyAccountSanction(userId, 'deleted', undefined, tx);
}
void typeLevelGuarantees;
