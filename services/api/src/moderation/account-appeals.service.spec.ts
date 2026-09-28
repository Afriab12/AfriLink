import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../common/prisma/prisma.service';
import { AccountSanctionService } from '../auth/account-sanction.service';
import { sha256 } from '../auth/token.util';
import { AccountAppealsService } from './account-appeals.service';
import {
  ConflictException,
  PolicyRejectedException,
  ResourceNotFoundException,
  TokenInvalidException,
} from '../common/errors/api-exception';

// Unit-level (no HTTP layer, direct PrismaService instantiation — same
// pattern as every moderation-callee spec this session): AccountAppealsService
// is the first real Moderation route (docs/05-api/moderation.md §5,
// "Account-sanction appeal initiation") — it consumes the account_appeal
// credentials AccountSanctionService already issues and creates the Appeal
// row, with no session/JwtAuthGuard involved at all.
describe('AccountAppealsService', () => {
  let prisma: PrismaService;
  let accountSanction: AccountSanctionService;
  let service: AccountAppealsService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    accountSanction = new AccountSanctionService(prisma);
    service = new AccountAppealsService(prisma, accountSanction);
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  async function makeUser(overrides: Partial<{ status: string }> = {}) {
    return prisma.user.create({ data: { status: (overrides.status as never) ?? 'banned', updatedAt: new Date() } });
  }

  async function makeAppealChallenge(
    userId: string,
    overrides: Partial<{ purpose: string; consumedAt: Date; expiresAt: Date; code: string }> = {},
  ) {
    const code = overrides.code ?? '482913';
    return prisma.verificationChallenge.create({
      data: {
        userId,
        channel: 'email',
        destinationHash: sha256(`${randomUUID()}@example.com`),
        purpose: overrides.purpose ?? 'account_appeal',
        challengeHash: sha256(code),
        expiresAt: overrides.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
        consumedAt: overrides.consumedAt ?? null,
      },
    });
  }

  function credentialFor(challenge: { id: string }, code = '482913') {
    return `${challenge.id}.${code}`;
  }

  async function makeCase() {
    return prisma.case.create({ data: { queue: 'platform', source: 'user_report' } });
  }

  async function makeAction(targetUserId: string, overrides: Partial<{ actionType: string; targetType: string }> = {}) {
    const c = await makeCase();
    return prisma.action.create({
      data: {
        caseId: c.id,
        targetType: (overrides.targetType as never) ?? 'profile',
        targetId: targetUserId,
        actionType: (overrides.actionType as never) ?? 'ban_account',
        scope: 'platform',
        reasonCode: 'spam',
      },
    });
  }

  async function makeSanction(actionId: string, subjectId: string, overrides: Partial<{ state: string }> = {}) {
    return prisma.sanction.create({
      data: {
        subjectType: 'user',
        subjectId,
        scope: 'platform',
        sanctionType: 'account_banned',
        reasonCode: 'spam',
        sourceActionId: actionId,
        state: (overrides.state as never) ?? 'active',
      },
    });
  }

  // Convenience: a fully-eligible fixture — banned user, a ban_account
  // action targeting them, an active sanction sourced from it, and a live
  // appeal credential. Individual tests override just the one piece they
  // want to break.
  async function makeEligibleAppealSetup() {
    const user = await makeUser();
    const action = await makeAction(user.id);
    await makeSanction(action.id, user.id);
    const challenge = await makeAppealChallenge(user.id);
    return { user, action, challenge };
  }

  describe('credential validation', () => {
    it('succeeds with a valid composite credential', async () => {
      const { action, challenge, user } = await makeEligibleAppealSetup();
      const result = await service.submitAccountAppeal({
        credential: credentialFor(challenge),
        actionId: action.id,
        statement: 'I was wrongly banned.',
      });
      expect(result.actionId).toBe(action.id);
      expect(result.appellantUserId).toBe(user.id);
    });

    it('rejects a wrong code with TokenInvalidException', async () => {
      const { action, challenge } = await makeEligibleAppealSetup();
      await expect(
        service.submitAccountAppeal({ credential: credentialFor(challenge, '000000'), actionId: action.id, statement: 'x' }),
      ).rejects.toThrow(TokenInvalidException);
    });

    it('rejects an expired credential with TokenInvalidException', async () => {
      const user = await makeUser();
      const action = await makeAction(user.id);
      await makeSanction(action.id, user.id);
      const challenge = await makeAppealChallenge(user.id, { expiresAt: new Date(Date.now() - 1000) });
      await expect(
        service.submitAccountAppeal({ credential: credentialFor(challenge), actionId: action.id, statement: 'x' }),
      ).rejects.toThrow(TokenInvalidException);
    });

    it('rejects an already-consumed credential with TokenInvalidException', async () => {
      const user = await makeUser();
      const action = await makeAction(user.id);
      await makeSanction(action.id, user.id);
      const challenge = await makeAppealChallenge(user.id, { consumedAt: new Date() });
      await expect(
        service.submitAccountAppeal({ credential: credentialFor(challenge), actionId: action.id, statement: 'x' }),
      ).rejects.toThrow(TokenInvalidException);
    });

    it('rejects a wrong-purpose credential (e.g. password_reset) with TokenInvalidException', async () => {
      const user = await makeUser();
      const action = await makeAction(user.id);
      await makeSanction(action.id, user.id);
      const challenge = await makeAppealChallenge(user.id, { purpose: 'password_reset' });
      await expect(
        service.submitAccountAppeal({ credential: credentialFor(challenge), actionId: action.id, statement: 'x' }),
      ).rejects.toThrow(TokenInvalidException);
    });

    it('rejects a malformed credential with TokenInvalidException', async () => {
      const { action } = await makeEligibleAppealSetup();
      await expect(
        service.submitAccountAppeal({ credential: 'not-a-composite-credential', actionId: action.id, statement: 'x' }),
      ).rejects.toThrow(TokenInvalidException);
    });
  });

  // Narrow mitigation: liftAccountSanction only ever touches User.status,
  // never Sanction.state (that synchronization belongs to the not-yet-built
  // Moderation action/decision/reversal lifecycle) — so a credential issued
  // while sanctioned remains technically valid after a lift. These tests
  // prove the additional current-status gate closes that specific window,
  // collapsed into the identical generic TokenInvalidException an ordinary
  // invalid credential already produces — no new distinguishable error.
  describe('current account status', () => {
    it('allows a banned account to submit a valid appeal', async () => {
      const user = await makeUser({ status: 'banned' });
      const action = await makeAction(user.id);
      await makeSanction(action.id, user.id);
      const challenge = await makeAppealChallenge(user.id);
      const result = await service.submitAccountAppeal({ credential: credentialFor(challenge), actionId: action.id, statement: 'x' });
      expect(result.appellantUserId).toBe(user.id);
    });

    it('allows a suspended account to submit a valid appeal', async () => {
      const user = await makeUser({ status: 'suspended' });
      const action = await makeAction(user.id);
      await makeSanction(action.id, user.id);
      const challenge = await makeAppealChallenge(user.id);
      const result = await service.submitAccountAppeal({ credential: credentialFor(challenge), actionId: action.id, statement: 'x' });
      expect(result.appellantUserId).toBe(user.id);
    });

    it('rejects an active account holding an otherwise-fully-valid credential, action, and active sanction', async () => {
      const user = await makeUser({ status: 'active' });
      const action = await makeAction(user.id);
      await makeSanction(action.id, user.id);
      const challenge = await makeAppealChallenge(user.id);
      await expect(
        service.submitAccountAppeal({ credential: credentialFor(challenge), actionId: action.id, statement: 'x' }),
      ).rejects.toThrow(TokenInvalidException);
    });

    it('produces the identical TokenInvalidException/error code an ordinary invalid credential already produces — no new distinguishable error for the active-user case', async () => {
      const activeUser = await makeUser({ status: 'active' });
      const activeAction = await makeAction(activeUser.id);
      await makeSanction(activeAction.id, activeUser.id);
      const activeChallenge = await makeAppealChallenge(activeUser.id);

      let activeUserError: unknown;
      let ordinaryInvalidError: unknown;
      try {
        await service.submitAccountAppeal({ credential: credentialFor(activeChallenge), actionId: activeAction.id, statement: 'x' });
      } catch (e) {
        activeUserError = e;
      }
      try {
        await service.submitAccountAppeal({ credential: 'not-a-composite-credential', actionId: activeAction.id, statement: 'x' });
      } catch (e) {
        ordinaryInvalidError = e;
      }
      expect(activeUserError).toBeInstanceOf(TokenInvalidException);
      expect(ordinaryInvalidError).toBeInstanceOf(TokenInvalidException);
      expect((activeUserError as TokenInvalidException).getStatus()).toBe((ordinaryInvalidError as TokenInvalidException).getStatus());
    });

    // The exact regression scenario: a real sanction, a real credential,
    // then the real (unmodified) liftAccountSanction — proving the stale
    // credential is rejected once User.status is genuinely active again,
    // not merely when a test fixture claims it is.
    it('rejects a technically-valid credential after the account sanction is lifted via the real, unmodified liftAccountSanction', async () => {
      const user = await makeUser({ status: 'banned' }); // sanction issued
      const action = await makeAction(user.id);
      await makeSanction(action.id, user.id);
      const challenge = await makeAppealChallenge(user.id); // appeal credential created

      await accountSanction.liftAccountSanction(user.id); // account sanction lifted — real method, untouched
      const lifted = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(lifted.status).toBe('active'); // User.status becomes active

      // old credential remains technically valid (still unconsumed, unexpired, correct hash)
      const stillResolvable = await accountSanction.resolveAppealCredential(credentialFor(challenge));
      expect(stillResolvable).not.toBeNull();

      // account appeal request is rejected
      await expect(
        service.submitAccountAppeal({ credential: credentialFor(challenge), actionId: action.id, statement: 'x' }),
      ).rejects.toThrow(TokenInvalidException);

      // and the credential remains unconsumed by the rejected attempt
      const untouched = await prisma.verificationChallenge.findUniqueOrThrow({ where: { id: challenge.id } });
      expect(untouched.consumedAt).toBeNull();
    });
  });

  describe('action validation', () => {
    it('rejects a nonexistent actionId with ResourceNotFoundException', async () => {
      const user = await makeUser();
      const challenge = await makeAppealChallenge(user.id);
      await expect(
        service.submitAccountAppeal({ credential: credentialFor(challenge), actionId: randomUUID(), statement: 'x' }),
      ).rejects.toThrow(ResourceNotFoundException);
    });

    it("rejects an action belonging to a different user with ResourceNotFoundException (never leaks ownership)", async () => {
      const owner = await makeUser();
      const action = await makeAction(owner.id);
      await makeSanction(action.id, owner.id);
      const stranger = await makeUser();
      const strangerChallenge = await makeAppealChallenge(stranger.id);
      await expect(
        service.submitAccountAppeal({ credential: credentialFor(strangerChallenge), actionId: action.id, statement: 'x' }),
      ).rejects.toThrow(ResourceNotFoundException);
    });

    it('rejects an action whose targetType is not profile', async () => {
      const user = await makeUser();
      const action = await makeAction(user.id, { targetType: 'post' });
      const challenge = await makeAppealChallenge(user.id);
      await expect(
        service.submitAccountAppeal({ credential: credentialFor(challenge), actionId: action.id, statement: 'x' }),
      ).rejects.toThrow(ResourceNotFoundException);
    });

    it('rejects an actionType outside {suspend_account, ban_account} with PolicyRejectedException, even with an otherwise-fully-eligible active sanction', async () => {
      const user = await makeUser();
      const action = await makeAction(user.id, { actionType: 'remove_content' });
      // Deliberately gives this ineligible-actionType action a real, active
      // sanction anyway — isolates the actionType check specifically. Without
      // this, a mutant that removes the actionType check entirely would
      // still fail this test for the coincidentally-correct wrong reason
      // (no sanction found), since remove_content actions never normally
      // have one.
      await makeSanction(action.id, user.id);
      const challenge = await makeAppealChallenge(user.id);
      await expect(
        service.submitAccountAppeal({ credential: credentialFor(challenge), actionId: action.id, statement: 'x' }),
      ).rejects.toThrow(PolicyRejectedException);
    });

    it('succeeds for suspend_account exactly as for ban_account', async () => {
      const user = await makeUser();
      const action = await makeAction(user.id, { actionType: 'suspend_account' });
      await makeSanction(action.id, user.id);
      const challenge = await makeAppealChallenge(user.id);
      const result = await service.submitAccountAppeal({ credential: credentialFor(challenge), actionId: action.id, statement: 'x' });
      expect(result.actionType).toBe('suspend_account');
    });

    it('rejects when the associated sanction is no longer active (e.g. already lifted)', async () => {
      const user = await makeUser();
      const action = await makeAction(user.id);
      await makeSanction(action.id, user.id, { state: 'revoked' });
      const challenge = await makeAppealChallenge(user.id);
      await expect(
        service.submitAccountAppeal({ credential: credentialFor(challenge), actionId: action.id, statement: 'x' }),
      ).rejects.toThrow(PolicyRejectedException);
    });

    it('rejects when no Sanction row exists at all for the action (defensive — should not happen in a consistent system)', async () => {
      const user = await makeUser();
      const action = await makeAction(user.id);
      // Deliberately no makeSanction() call.
      const challenge = await makeAppealChallenge(user.id);
      await expect(
        service.submitAccountAppeal({ credential: credentialFor(challenge), actionId: action.id, statement: 'x' }),
      ).rejects.toThrow(PolicyRejectedException);
    });
  });

  describe('appeal creation', () => {
    it('creates the appeal with the correct fields', async () => {
      const { action, challenge, user } = await makeEligibleAppealSetup();
      const before = Date.now();
      const result = await service.submitAccountAppeal({
        credential: credentialFor(challenge),
        actionId: action.id,
        statement: 'Please review my case.',
      });
      expect(result.id).toBeTruthy();
      expect(result.actionId).toBe(action.id);
      expect(result.actionType).toBe(action.actionType);
      expect(result.appellantUserId).toBe(user.id);
      expect(result.statement).toBe('Please review my case.');
      expect(result.state).toBe('submitted');
      const deadlineMs = new Date(result.appealDeadline).getTime();
      expect(deadlineMs).toBeGreaterThan(before + 71 * 60 * 60 * 1000);
      expect(deadlineMs).toBeLessThan(before + 73 * 60 * 60 * 1000);
    });

    it('derives actionType from the Action row, never the client (DTO carries no actionType field at all)', async () => {
      const user = await makeUser();
      const action = await makeAction(user.id, { actionType: 'suspend_account' });
      await makeSanction(action.id, user.id);
      const challenge = await makeAppealChallenge(user.id);
      const result = await service.submitAccountAppeal({ credential: credentialFor(challenge), actionId: action.id, statement: 'x' });
      expect(result.actionType).toBe('suspend_account');
    });

    it('rejects a duplicate submission while an appeal is still active (submitted/under_review) with ConflictException', async () => {
      const { action, challenge } = await makeEligibleAppealSetup();
      await service.submitAccountAppeal({ credential: credentialFor(challenge), actionId: action.id, statement: 'first' });

      const secondChallenge = await makeAppealChallenge((await prisma.action.findUniqueOrThrow({ where: { id: action.id } })).targetId);
      await expect(
        service.submitAccountAppeal({ credential: credentialFor(secondChallenge), actionId: action.id, statement: 'second' }),
      ).rejects.toThrow(ConflictException);
    });

    it('rejects resubmission against an already-decided (terminal) appeal with ConflictException — never a silent second row', async () => {
      const { action, challenge, user } = await makeEligibleAppealSetup();
      const first = await service.submitAccountAppeal({ credential: credentialFor(challenge), actionId: action.id, statement: 'first' });
      // Move the appeal to a terminal state directly, as a decide-endpoint
      // would (not built yet) — the DB's partial-unique constraint only
      // excludes submitted/under_review, so without an app-layer check a
      // second row would otherwise be perfectly insertable here.
      await prisma.appeal.update({
        where: { id: first.id },
        data: { state: 'upheld', reviewerId: user.id, decidedAt: new Date() },
      });

      const secondChallenge = await makeAppealChallenge(user.id);
      await expect(
        service.submitAccountAppeal({ credential: credentialFor(secondChallenge), actionId: action.id, statement: 'second' }),
      ).rejects.toThrow(ConflictException);

      const appealsForAction = await prisma.appeal.findMany({ where: { actionId: action.id } });
      expect(appealsForAction).toHaveLength(1);
    });

    it('consumes the credential exactly once on success — the same credential cannot be replayed', async () => {
      const { action, challenge } = await makeEligibleAppealSetup();
      await service.submitAccountAppeal({ credential: credentialFor(challenge), actionId: action.id, statement: 'first' });
      const consumed = await prisma.verificationChallenge.findUniqueOrThrow({ where: { id: challenge.id } });
      expect(consumed.consumedAt).not.toBeNull();

      // Replay: a fresh Action is needed since the first is now conflicted,
      // but the credential itself is what's under test here.
      const user2 = await makeUser();
      const action2 = await makeAction(user2.id);
      await makeSanction(action2.id, user2.id);
      await expect(
        service.submitAccountAppeal({ credential: credentialFor(challenge), actionId: action2.id, statement: 'replay' }),
      ).rejects.toThrow(TokenInvalidException);
    });

    it('leaves the credential unconsumed when appeal creation fails (duplicate-appeal conflict)', async () => {
      const { action, challenge } = await makeEligibleAppealSetup();
      await service.submitAccountAppeal({ credential: credentialFor(challenge), actionId: action.id, statement: 'first' });

      const secondUser = (await prisma.action.findUniqueOrThrow({ where: { id: action.id } })).targetId;
      const secondChallenge = await makeAppealChallenge(secondUser);
      await expect(
        service.submitAccountAppeal({ credential: credentialFor(secondChallenge), actionId: action.id, statement: 'second' }),
      ).rejects.toThrow(ConflictException);

      const stillUnconsumed = await prisma.verificationChallenge.findUniqueOrThrow({ where: { id: secondChallenge.id } });
      expect(stillUnconsumed.consumedAt).toBeNull();
    });
  });

  describe('security', () => {
    it('never distinguishes "action does not exist" from "action belongs to someone else" (identical exception, no message leak)', async () => {
      const user = await makeUser();
      const challenge = await makeAppealChallenge(user.id);

      const owner = await makeUser();
      const othersAction = await makeAction(owner.id);
      await makeSanction(othersAction.id, owner.id);

      let notFoundError: unknown;
      let mismatchError: unknown;
      try {
        await service.submitAccountAppeal({ credential: credentialFor(challenge), actionId: randomUUID(), statement: 'x' });
      } catch (e) {
        notFoundError = e;
      }
      try {
        await service.submitAccountAppeal({ credential: credentialFor(await makeAppealChallenge(user.id)), actionId: othersAction.id, statement: 'x' });
      } catch (e) {
        mismatchError = e;
      }
      expect(notFoundError).toBeInstanceOf(ResourceNotFoundException);
      expect(mismatchError).toBeInstanceOf(ResourceNotFoundException);
      expect((notFoundError as ResourceNotFoundException).getStatus()).toBe((mismatchError as ResourceNotFoundException).getStatus());
    });

    it('a credential resolves to the actual owning user, never a substituted one, when two users each hold valid credentials', async () => {
      const userA = await makeUser();
      const userB = await makeUser();
      const actionA = await makeAction(userA.id);
      await makeSanction(actionA.id, userA.id);
      const actionB = await makeAction(userB.id);
      await makeSanction(actionB.id, userB.id);
      const challengeA = await makeAppealChallenge(userA.id);
      const challengeB = await makeAppealChallenge(userB.id);

      // Cross-paired: B's credential against A's action, and vice versa —
      // both must fail.
      await expect(
        service.submitAccountAppeal({ credential: credentialFor(challengeB), actionId: actionA.id, statement: 'x' }),
      ).rejects.toThrow(ResourceNotFoundException);
      await expect(
        service.submitAccountAppeal({ credential: credentialFor(challengeA), actionId: actionB.id, statement: 'x' }),
      ).rejects.toThrow(ResourceNotFoundException);

      // Correctly paired: both succeed independently.
      const resultA = await service.submitAccountAppeal({ credential: credentialFor(challengeA), actionId: actionA.id, statement: 'x' });
      const resultB = await service.submitAccountAppeal({ credential: credentialFor(challengeB), actionId: actionB.id, statement: 'x' });
      expect(resultA.appellantUserId).toBe(userA.id);
      expect(resultB.appellantUserId).toBe(userB.id);
    });
  });

  describe('transactions', () => {
    // A structural, deterministic check — the black-box race test below can
    // be inconclusive under connection-pool serialization (if the pool
    // effectively runs both requests sequentially, the pre-check alone
    // would prevent the second from ever reaching a transaction at all,
    // making split-vs-joined transactions unobservable through timing).
    // Spying on $transaction's call count directly proves the structural
    // property regardless of scheduling: consumption and creation must
    // happen inside exactly one transaction, not two sequential ones.
    it('performs credential consumption and appeal creation inside exactly one $transaction call', async () => {
      const { action, challenge } = await makeEligibleAppealSetup();
      const spy = vi.spyOn(prisma, '$transaction');
      await service.submitAccountAppeal({ credential: credentialFor(challenge), actionId: action.id, statement: 'x' });
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });

    it('a race between two valid credentials for the same user/action resolves to exactly one success and one 409, with the loser leaving its credential unconsumed', async () => {
      const user = await makeUser();
      const action = await makeAction(user.id);
      await makeSanction(action.id, user.id);
      const challengeA = await makeAppealChallenge(user.id, { code: '111111' });
      const challengeB = await makeAppealChallenge(user.id, { code: '222222' });

      const results = await Promise.allSettled([
        service.submitAccountAppeal({ credential: credentialFor(challengeA, '111111'), actionId: action.id, statement: 'a' }),
        service.submitAccountAppeal({ credential: credentialFor(challengeB, '222222'), actionId: action.id, statement: 'b' }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);

      const appeals = await prisma.appeal.findMany({ where: { actionId: action.id } });
      expect(appeals).toHaveLength(1);

      const [rowA, rowB] = await Promise.all([
        prisma.verificationChallenge.findUniqueOrThrow({ where: { id: challengeA.id } }),
        prisma.verificationChallenge.findUniqueOrThrow({ where: { id: challengeB.id } }),
      ]);
      const consumedCount = [rowA, rowB].filter((r) => r.consumedAt !== null).length;
      expect(consumedCount).toBe(1);
    });
  });
});
