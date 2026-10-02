import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../common/prisma/prisma.service';
import { ContentModerationService } from '../content/content-moderation.service';
import { MessagingModerationService } from '../messaging/messaging-moderation.service';
import { CommunityModerationService } from '../communities/community-moderation.service';
import { AccountSanctionService } from '../auth/account-sanction.service';
import { AuditService } from '../audit/audit.service';
import { ActionsService } from './actions.service';
import { AppealsService } from './appeals.service';
import { ConflictException, ForbiddenActionException, ResourceNotFoundException, ValidationFailedException } from '../common/errors/api-exception';

// Unit-level, real PrismaService — same pattern as every moderation spec
// this session. Decide (Increment B3) is built against Appeal rows
// fabricated directly, matching Option B (session-based submission
// deferred) — the shipped account-appeal path already proves Appeal
// creation works; this file exercises decision-making, not creation.
describe('AppealsService', () => {
  let prisma: PrismaService;
  let audit: AuditService;
  let actions: ActionsService;
  let accountSanction: AccountSanctionService;
  let service: AppealsService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    audit = new AuditService(prisma);
    const contentModeration = new ContentModerationService(prisma);
    const messagingModeration = new MessagingModerationService(prisma);
    const communityModeration = new CommunityModerationService(prisma);
    accountSanction = new AccountSanctionService(prisma);
    actions = new ActionsService(prisma, contentModeration, messagingModeration, communityModeration, accountSanction, audit);
    service = new AppealsService(prisma, actions, contentModeration, messagingModeration, audit);
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  // ------------------------------------------------------------- fixtures

  async function makeUser(overrides: Partial<{ status: string }> = {}) {
    return prisma.user.create({ data: { status: (overrides.status as never) ?? 'active', updatedAt: new Date() } });
  }

  async function makeCase(queue: 'platform' | 'community' | 'content' | 'messaging' = 'platform') {
    return prisma.case.create({ data: { queue, source: 'user_report' } });
  }

  async function makeAction(
    actorId: string,
    targetType: string,
    targetId: string,
    actionType: string,
    scope: 'platform' | 'community' | 'content' | 'messaging',
  ) {
    const kase = await makeCase(scope);
    return prisma.action.create({
      data: { caseId: kase.id, actorId, targetType: targetType as never, targetId, actionType: actionType as never, scope, reasonCode: 'spam' },
    });
  }

  async function makeSanction(
    actionId: string,
    subjectType: 'user' | 'community',
    subjectId: string,
    scope: 'platform' | 'community',
    sanctionType: 'account_suspended' | 'account_banned' | 'community_restricted',
    overrides: Partial<{ state: string }> = {},
  ) {
    return prisma.sanction.create({
      data: { subjectType, subjectId, scope, sanctionType, reasonCode: 'spam', sourceActionId: actionId, state: (overrides.state as never) ?? 'active' },
    });
  }

  // Applies the REAL account-sanction effect (User.status + session
  // revocation) via the actual, unmodified AccountSanctionService — the
  // fixture rows above only establish Action/Sanction bookkeeping, not
  // the real-world precondition decide's own tests need to verify a
  // transition away from. Without this, "restored to active"-style
  // assertions would hold vacuously (the user was never actually
  // sanctioned in the first place) and would not catch a mutation that
  // silently omitted the restoration.
  async function applySanctionedState(userId: string, status: 'suspended' | 'banned') {
    await accountSanction.applyAccountSanction(userId, status);
  }

  async function makeAppeal(actionId: string, actionType: string, appellantUserId: string) {
    return prisma.appeal.create({
      data: {
        actionId,
        actionType: actionType as never,
        appellantUserId,
        statement: 'I was wrongly actioned.',
        appealDeadline: new Date(Date.now() + 72 * 60 * 60 * 1000),
      },
    });
  }

  async function makePost(authorId: string) {
    return prisma.post.create({ data: { authorId, body: 'hello' } });
  }

  async function makeComment(authorId: string) {
    const post = await makePost(authorId);
    return prisma.comment.create({ data: { authorId, postId: post.id, body: 'a comment' } });
  }

  async function makeCommunity(ownerId: string) {
    return prisma.community.create({ data: { ownerUserId: ownerId, slug: `c-${randomUUID()}`, name: 'Test Community' } });
  }

  async function makeMembership(communityId: string, userId: string) {
    return prisma.communityMembership.create({ data: { communityId, userId, status: 'active', approvedAt: new Date() } });
  }

  // -------------------------------------------------------------- baseline

  describe('appeal existence and reviewer conflict-of-interest', () => {
    it('throws ResourceNotFoundException for a nonexistent appeal', async () => {
      const reviewer = await makeUser();
      await expect(service.decideAppeal(reviewer.id, randomUUID(), { decision: 'upheld' })).rejects.toThrow(ResourceNotFoundException);
    });

    it('rejects the original actor deciding the appeal (reviewer == actor)', async () => {
      const actor = await makeUser();
      const target = await makeUser();
      const action = await makeAction(actor.id, 'profile', target.id, 'ban_account', 'platform');
      await makeSanction(action.id, 'user', target.id, 'platform', 'account_banned');
      const appeal = await makeAppeal(action.id, 'ban_account', target.id);

      await expect(service.decideAppeal(actor.id, appeal.id, { decision: 'upheld' })).rejects.toThrow(ForbiddenActionException);
    });

    it('rejects the appellant (also a moderator, distinct from actor) upholding their own appeal — self-action extended to decide', async () => {
      const actor = await makeUser();
      const target = await makeUser(); // stands in as "also a moderator"
      const action = await makeAction(actor.id, 'profile', target.id, 'ban_account', 'platform');
      await makeSanction(action.id, 'user', target.id, 'platform', 'account_banned');
      const appeal = await makeAppeal(action.id, 'ban_account', target.id);

      await expect(service.decideAppeal(target.id, appeal.id, { decision: 'upheld' })).rejects.toThrow(ForbiddenActionException);
    });
  });

  // -------------------------------------------------------------- uphold

  describe('uphold', () => {
    it('records state=upheld, reviewerId, decidedAt, maps notes -> Appeal.decision column, no reversal created', async () => {
      const actor = await makeUser();
      const reviewer = await makeUser();
      const target = await makeUser();
      const action = await makeAction(actor.id, 'profile', target.id, 'ban_account', 'platform');
      await makeSanction(action.id, 'user', target.id, 'platform', 'account_banned');
      await applySanctionedState(target.id, 'banned');
      const appeal = await makeAppeal(action.id, 'ban_account', target.id);

      const result = await service.decideAppeal(reviewer.id, appeal.id, { decision: 'upheld', notes: 'Evidence supports the ban.' });
      expect(result.state).toBe('upheld');
      expect(result.reviewerId).toBe(reviewer.id);
      expect(result.decision).toBe('Evidence supports the ban.');

      const reloaded = await prisma.appeal.findUniqueOrThrow({ where: { id: appeal.id } });
      expect(reloaded.decidedAt).not.toBeNull();

      const reversalCount = await prisma.action.count({ where: { reversalOfActionId: action.id } });
      expect(reversalCount).toBe(0);
      const user = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
      expect(user.status).toBe('banned'); // unchanged
    });

    it('rejects re-deciding an already-upheld appeal with 409', async () => {
      const actor = await makeUser();
      const reviewer1 = await makeUser();
      const reviewer2 = await makeUser();
      const target = await makeUser();
      const action = await makeAction(actor.id, 'profile', target.id, 'ban_account', 'platform');
      await makeSanction(action.id, 'user', target.id, 'platform', 'account_banned');
      const appeal = await makeAppeal(action.id, 'ban_account', target.id);
      await service.decideAppeal(reviewer1.id, appeal.id, { decision: 'upheld' });

      await expect(service.decideAppeal(reviewer2.id, appeal.id, { decision: 'upheld' })).rejects.toThrow(ConflictException);
      await expect(service.decideAppeal(reviewer2.id, appeal.id, { decision: 'overturned', reasonCode: 'other' })).rejects.toThrow(ConflictException);
    });

    it('rejects re-deciding an already-overturned appeal with 409', async () => {
      const actor = await makeUser();
      const reviewer1 = await makeUser();
      const reviewer2 = await makeUser();
      const target = await makeUser();
      const action = await makeAction(actor.id, 'profile', target.id, 'ban_account', 'platform');
      await makeSanction(action.id, 'user', target.id, 'platform', 'account_banned');
      const appeal = await makeAppeal(action.id, 'ban_account', target.id);
      await service.decideAppeal(reviewer1.id, appeal.id, { decision: 'overturned', reasonCode: 'other' });

      await expect(service.decideAppeal(reviewer2.id, appeal.id, { decision: 'upheld' })).rejects.toThrow(ConflictException);
      await expect(service.decideAppeal(reviewer2.id, appeal.id, { decision: 'overturned', reasonCode: 'other' })).rejects.toThrow(ConflictException);
    });
  });

  // ------------------------------------------------------------ overturn

  describe('overturn — account sanction', () => {
    it('rejects overturn with no reasonCode: 422 VALIDATION_FAILED', async () => {
      const actor = await makeUser();
      const reviewer = await makeUser();
      const target = await makeUser();
      const action = await makeAction(actor.id, 'profile', target.id, 'ban_account', 'platform');
      await makeSanction(action.id, 'user', target.id, 'platform', 'account_banned');
      const appeal = await makeAppeal(action.id, 'ban_account', target.id);

      await expect(service.decideAppeal(reviewer.id, appeal.id, { decision: 'overturned' })).rejects.toThrow(ValidationFailedException);
    });

    it('overturns a suspend: reversal action created, User.status active, Sanction revoked', async () => {
      const actor = await makeUser();
      const reviewer = await makeUser();
      const target = await makeUser();
      const action = await makeAction(actor.id, 'profile', target.id, 'suspend_account', 'platform');
      const sanction = await makeSanction(action.id, 'user', target.id, 'platform', 'account_suspended');
      await applySanctionedState(target.id, 'suspended');
      const appeal = await makeAppeal(action.id, 'suspend_account', target.id);

      const result = await service.decideAppeal(reviewer.id, appeal.id, { decision: 'overturned', reasonCode: 'other' });
      expect(result.state).toBe('overturned');

      const reloadedSanction = await prisma.sanction.findUniqueOrThrow({ where: { id: sanction.id } });
      expect(reloadedSanction.state).toBe('revoked');
      const user = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
      expect(user.status).toBe('active');
      const reversal = await prisma.action.findFirst({ where: { reversalOfActionId: action.id } });
      expect(reversal).not.toBeNull();
      expect(reversal!.actorId).toBe(reviewer.id);
    });

    it('overturns a ban: same effect', async () => {
      const actor = await makeUser();
      const reviewer = await makeUser();
      const target = await makeUser();
      const action = await makeAction(actor.id, 'profile', target.id, 'ban_account', 'platform');
      await makeSanction(action.id, 'user', target.id, 'platform', 'account_banned');
      await applySanctionedState(target.id, 'banned');
      const appeal = await makeAppeal(action.id, 'ban_account', target.id);

      await service.decideAppeal(reviewer.id, appeal.id, { decision: 'overturned', reasonCode: 'other' });
      const user = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
      expect(user.status).toBe('active');
    });

    it('does not create a session and does not un-revoke prior sessions (reuses liftAccountSanction unmodified)', async () => {
      const actor = await makeUser();
      const reviewer = await makeUser();
      const target = await makeUser();
      const session = await prisma.session.create({
        data: { userId: target.id, refreshTokenHash: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) },
      });
      const action = await makeAction(actor.id, 'profile', target.id, 'ban_account', 'platform');
      await makeSanction(action.id, 'user', target.id, 'platform', 'account_banned');
      await applySanctionedState(target.id, 'banned'); // revokes the pre-existing session, as a real ban would
      const appeal = await makeAppeal(action.id, 'ban_account', target.id);

      const beforeCount = await prisma.session.count({ where: { userId: target.id, revokedAt: null } });
      expect(beforeCount).toBe(0); // ban already revoked it

      await service.decideAppeal(reviewer.id, appeal.id, { decision: 'overturned', reasonCode: 'other' });
      const reloadedSession = await prisma.session.findUniqueOrThrow({ where: { id: session.id } });
      expect(reloadedSession.revokedAt).not.toBeNull();
    });

    it('no Notification row is created — delivery is out of scope for this increment', async () => {
      const actor = await makeUser();
      const reviewer = await makeUser();
      const target = await makeUser();
      const action = await makeAction(actor.id, 'profile', target.id, 'ban_account', 'platform');
      await makeSanction(action.id, 'user', target.id, 'platform', 'account_banned');
      await applySanctionedState(target.id, 'banned');
      const appeal = await makeAppeal(action.id, 'ban_account', target.id);

      await service.decideAppeal(reviewer.id, appeal.id, { decision: 'overturned', reasonCode: 'other' });
      const notificationCount = await prisma.notification.count({ where: { recipientUserId: target.id } });
      expect(notificationCount).toBe(0);
    });
  });

  describe('overturn — community restriction', () => {
    it('restores membership to active, revokes the sanction, same row', async () => {
      const actor = await makeUser();
      const reviewer = await makeUser();
      const target = await makeUser();
      const owner = await makeUser();
      const community = await makeCommunity(owner.id);
      const membership = await makeMembership(community.id, target.id);
      await prisma.communityMembership.update({ where: { id: membership.id }, data: { status: 'banned' } });
      const action = await makeAction(actor.id, 'profile', target.id, 'restrict_community_participation', 'community');
      const sanction = await makeSanction(action.id, 'community', membership.id, 'community', 'community_restricted');
      const appeal = await makeAppeal(action.id, 'restrict_community_participation', target.id);

      await service.decideAppeal(reviewer.id, appeal.id, { decision: 'overturned', reasonCode: 'other' });

      const reloadedMembership = await prisma.communityMembership.findUniqueOrThrow({ where: { id: membership.id } });
      expect(reloadedMembership.status).toBe('active');
      const reloadedSanction = await prisma.sanction.findUniqueOrThrow({ where: { id: sanction.id } });
      expect(reloadedSanction.state).toBe('revoked');
    });
  });

  describe('overturn — content/message', () => {
    it('restores a removed post to published', async () => {
      const actor = await makeUser();
      const reviewer = await makeUser();
      const author = await makeUser();
      const post = await makePost(author.id);
      await prisma.post.update({ where: { id: post.id }, data: { status: 'removed' } });
      const action = await makeAction(actor.id, 'post', post.id, 'remove_content', 'content');
      const appeal = await makeAppeal(action.id, 'remove_content', author.id);

      await service.decideAppeal(reviewer.id, appeal.id, { decision: 'overturned', reasonCode: 'other' });
      const reloaded = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
      expect(reloaded.status).toBe('published');
    });

    it('restores a restricted comment to published', async () => {
      const actor = await makeUser();
      const reviewer = await makeUser();
      const author = await makeUser();
      const comment = await makeComment(author.id);
      await prisma.comment.update({ where: { id: comment.id }, data: { status: 'hidden' } });
      const action = await makeAction(actor.id, 'comment', comment.id, 'restrict_content', 'content');
      const appeal = await makeAppeal(action.id, 'restrict_content', author.id);

      await service.decideAppeal(reviewer.id, appeal.id, { decision: 'overturned', reasonCode: 'other' });
      const reloaded = await prisma.comment.findUniqueOrThrow({ where: { id: comment.id } });
      expect(reloaded.status).toBe('published');
    });
  });

  describe('overturn when there is nothing live to reverse (decision 2)', () => {
    it('sanction already superseded by a later escalation: appeal still becomes overturned, no reversal Action created, currently-active sanction untouched', async () => {
      const actor = await makeUser();
      const reviewer = await makeUser();
      const target = await makeUser();
      const suspendAction = await makeAction(actor.id, 'profile', target.id, 'suspend_account', 'platform');
      const suspendSanction = await makeSanction(suspendAction.id, 'user', target.id, 'platform', 'account_suspended');
      // escalate directly via ActionsService, exactly as B1 already proves
      await actions.createAction(actor.id, suspendAction.caseId, { actionType: 'ban_account', targetType: 'profile', targetId: target.id, reasonCode: 'spam' });
      const appeal = await makeAppeal(suspendAction.id, 'suspend_account', target.id);

      const result = await service.decideAppeal(reviewer.id, appeal.id, { decision: 'overturned', reasonCode: 'other' });
      expect(result.state).toBe('overturned');

      const reloadedSuspendSanction = await prisma.sanction.findUniqueOrThrow({ where: { id: suspendSanction.id } });
      expect(reloadedSuspendSanction.state).toBe('superseded'); // untouched by the no-op reversal attempt

      const reversalCount = await prisma.action.count({ where: { reversalOfActionId: suspendAction.id } });
      expect(reversalCount).toBe(0); // reverseAction bailed out before creating anything

      const user = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
      expect(user.status).toBe('banned'); // the currently-active ban is untouched
    });

    it('action already directly reversed: appeal still becomes overturned, no second reversal Action created', async () => {
      const actor = await makeUser();
      const reverser = await makeUser();
      const reviewer = await makeUser();
      const target = await makeUser();
      const action = await makeAction(actor.id, 'profile', target.id, 'ban_account', 'platform');
      await makeSanction(action.id, 'user', target.id, 'platform', 'account_banned');
      await actions.reverseAction(reverser.id, action.id, { reasonCode: 'other' });
      const appeal = await makeAppeal(action.id, 'ban_account', target.id);

      const result = await service.decideAppeal(reviewer.id, appeal.id, { decision: 'overturned', reasonCode: 'other' });
      expect(result.state).toBe('overturned');

      const reversalCount = await prisma.action.count({ where: { reversalOfActionId: action.id } });
      expect(reversalCount).toBe(1); // only the one from the direct /reverse call, none added by decide
    });
  });

  describe('atomicity — the Appeal state update and the reversal must commit or fail together', () => {
    it('a genuine (non-conflict) failure deep inside the reused reversal rolls back the Appeal state update too', async () => {
      const actor = await makeUser();
      const reviewer = await makeUser();
      const target = await makeUser();
      const action = await makeAction(actor.id, 'profile', target.id, 'ban_account', 'platform');
      await makeSanction(action.id, 'user', target.id, 'platform', 'account_banned');
      const appeal = await makeAppeal(action.id, 'ban_account', target.id);

      // Force a genuine, non-Conflict failure partway through the reused
      // reverseAction call (liftAccountSanction is the last write it
      // makes) — decide's own catch only swallows ConflictException, so
      // this must propagate and, if the whole thing is genuinely one
      // transaction, roll back the Appeal.state write that already
      // happened moments earlier in the SAME callback.
      const spy = vi.spyOn(accountSanction, 'liftAccountSanction').mockRejectedValueOnce(new Error('simulated failure'));
      await expect(service.decideAppeal(reviewer.id, appeal.id, { decision: 'overturned', reasonCode: 'other' })).rejects.toThrow('simulated failure');
      spy.mockRestore();

      const reloadedAppeal = await prisma.appeal.findUniqueOrThrow({ where: { id: appeal.id } });
      expect(reloadedAppeal.state).toBe('submitted'); // NOT stuck at 'overturned' — rolled back with everything else
      expect(reloadedAppeal.decidedAt).toBeNull();
    });
  });

  // ------------------------------------------------------------ concurrency

  describe('concurrency', () => {
    it('two simultaneous decisions on the same appeal: exactly one succeeds, one gets 409', async () => {
      const actor = await makeUser();
      const reviewer1 = await makeUser();
      const reviewer2 = await makeUser();
      const target = await makeUser();
      const action = await makeAction(actor.id, 'profile', target.id, 'ban_account', 'platform');
      await makeSanction(action.id, 'user', target.id, 'platform', 'account_banned');
      const appeal = await makeAppeal(action.id, 'ban_account', target.id);

      const [r1, r2] = await Promise.allSettled([
        service.decideAppeal(reviewer1.id, appeal.id, { decision: 'upheld' }),
        service.decideAppeal(reviewer2.id, appeal.id, { decision: 'upheld' }),
      ]);
      const outcomes = [r1, r2];
      expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((r) => r.status === 'rejected')).toHaveLength(1);
    });

    it('performs the overturn appeal-state update and reversal inside exactly one $transaction call', async () => {
      const actor = await makeUser();
      const reviewer = await makeUser();
      const target = await makeUser();
      const action = await makeAction(actor.id, 'profile', target.id, 'ban_account', 'platform');
      await makeSanction(action.id, 'user', target.id, 'platform', 'account_banned');
      const appeal = await makeAppeal(action.id, 'ban_account', target.id);

      const spy = vi.spyOn(prisma, '$transaction');
      await service.decideAppeal(reviewer.id, appeal.id, { decision: 'overturned', reasonCode: 'other' });
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });
  });

  // ------------------------------------------------------------- schema fact

  describe('warn_user cannot be appealed (schema-enforced, not application logic)', () => {
    it('the database itself rejects an Appeal row for a warn_user action', async () => {
      const actor = await makeUser();
      const target = await makeUser();
      const action = await makeAction(actor.id, 'profile', target.id, 'warn_user', 'platform');

      await expect(makeAppeal(action.id, 'warn_user', target.id)).rejects.toThrow();
    });
  });

  // -------------------------------------------------------- audit (Audit B)

  describe('audit integration', () => {
    async function latestAuditEvent(eventType: string, subjectId: string) {
      return prisma.auditEvent.findFirst({ where: { eventType: eventType as never, subjectId }, orderBy: { createdAt: 'desc' } });
    }

    describe('uphold', () => {
      it('records a moderation_appeal_decided event, no reversalActionId, inside its own new transaction', async () => {
        const actor = await makeUser();
        const reviewer = await makeUser();
        const target = await makeUser();
        const action = await makeAction(actor.id, 'profile', target.id, 'ban_account', 'platform');
        await makeSanction(action.id, 'user', target.id, 'platform', 'account_banned');
        const appeal = await makeAppeal(action.id, 'ban_account', target.id);

        const spy = vi.spyOn(prisma, '$transaction');
        await service.decideAppeal(reviewer.id, appeal.id, { decision: 'upheld', notes: 'looked legitimate' });
        expect(spy).toHaveBeenCalledTimes(1);
        spy.mockRestore();

        const event = await latestAuditEvent('moderation_appeal_decided', target.id);
        expect(event?.actorId).toBe(reviewer.id);
        expect(event?.subjectType).toBe('profile');
        expect(event?.reason).toBe('looked legitimate');
        expect(event?.metadata).toEqual({ appealId: appeal.id, actionId: action.id, decision: 'upheld' });
      });

      it('atomicity (audit→domain direction): a forced AuditService.record failure leaves the Appeal state unchanged', async () => {
        const actor = await makeUser();
        const reviewer = await makeUser();
        const target = await makeUser();
        const action = await makeAction(actor.id, 'profile', target.id, 'ban_account', 'platform');
        await makeSanction(action.id, 'user', target.id, 'platform', 'account_banned');
        const appeal = await makeAppeal(action.id, 'ban_account', target.id);

        const spy = vi.spyOn(audit, 'record').mockRejectedValueOnce(new Error('simulated audit failure'));
        await expect(service.decideAppeal(reviewer.id, appeal.id, { decision: 'upheld' })).rejects.toThrow('simulated audit failure');
        spy.mockRestore();

        const reloaded = await prisma.appeal.findUniqueOrThrow({ where: { id: appeal.id } });
        expect(reloaded.state).toBe('submitted');
        expect(reloaded.decidedAt).toBeNull();
      });
    });

    describe('overturn', () => {
      it('reversal succeeds: metadata.reversalActionId matches the created reversal Action id, occurredAt matches decidedAt', async () => {
        const actor = await makeUser();
        const reviewer = await makeUser();
        const target = await makeUser();
        const action = await makeAction(actor.id, 'profile', target.id, 'ban_account', 'platform');
        await makeSanction(action.id, 'user', target.id, 'platform', 'account_banned');
        await applySanctionedState(target.id, 'banned');
        const appeal = await makeAppeal(action.id, 'ban_account', target.id);

        await service.decideAppeal(reviewer.id, appeal.id, { decision: 'overturned', reasonCode: 'other', notes: 'reviewed' });

        const reversal = await prisma.action.findFirstOrThrow({ where: { reversalOfActionId: action.id } });
        const reversedEvent = await latestAuditEvent('moderation_action_reversed', target.id);
        expect(reversedEvent?.metadata).toEqual({ actionType: 'ban_account', originalActionId: action.id });

        const decidedEvent = await latestAuditEvent('moderation_appeal_decided', target.id);
        expect(decidedEvent?.actorId).toBe(reviewer.id);
        expect(decidedEvent?.reason).toBe('reviewed');
        expect(decidedEvent?.metadata).toEqual({ appealId: appeal.id, actionId: action.id, decision: 'overturned', reversalActionId: reversal.id });

        const reloadedAppeal = await prisma.appeal.findUniqueOrThrow({ where: { id: appeal.id } });
        expect(decidedEvent?.occurredAt.getTime()).toBe(reloadedAppeal.decidedAt!.getTime());
      });

      it('nothing live to reverse: exactly one moderation_appeal_decided event, zero moderation_action_reversed events, no reversalActionId', async () => {
        const actor = await makeUser();
        const reviewer = await makeUser();
        const target = await makeUser();
        const suspendAction = await makeAction(actor.id, 'profile', target.id, 'suspend_account', 'platform');
        await makeSanction(suspendAction.id, 'user', target.id, 'platform', 'account_suspended');
        await actions.createAction(actor.id, suspendAction.caseId, { actionType: 'ban_account', targetType: 'profile', targetId: target.id, reasonCode: 'spam' });
        const appeal = await makeAppeal(suspendAction.id, 'suspend_account', target.id);

        await service.decideAppeal(reviewer.id, appeal.id, { decision: 'overturned', reasonCode: 'other' });

        expect(await prisma.auditEvent.count({ where: { eventType: 'moderation_action_reversed', subjectId: target.id } })).toBe(0);
        const decidedEvents = await prisma.auditEvent.findMany({ where: { eventType: 'moderation_appeal_decided', subjectId: target.id } });
        expect(decidedEvents).toHaveLength(1);
        expect(decidedEvents[0].metadata).toEqual({ appealId: appeal.id, actionId: suspendAction.id, decision: 'overturned' });
      });

      it('atomicity (domain→audit direction): a forced genuine failure inside the reused reversal leaves no audit rows at all', async () => {
        const actor = await makeUser();
        const reviewer = await makeUser();
        const target = await makeUser();
        const action = await makeAction(actor.id, 'profile', target.id, 'ban_account', 'platform');
        await makeSanction(action.id, 'user', target.id, 'platform', 'account_banned');
        await applySanctionedState(target.id, 'banned');
        const appeal = await makeAppeal(action.id, 'ban_account', target.id);

        const spy = vi.spyOn(accountSanction, 'liftAccountSanction').mockRejectedValueOnce(new Error('simulated domain failure'));
        await expect(service.decideAppeal(reviewer.id, appeal.id, { decision: 'overturned', reasonCode: 'other' })).rejects.toThrow('simulated domain failure');
        spy.mockRestore();

        expect(await prisma.auditEvent.count({ where: { subjectId: target.id } })).toBe(0);
      });
    });
  });
});
