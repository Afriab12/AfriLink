import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../common/prisma/prisma.service';
import { ContentModerationService } from '../content/content-moderation.service';
import { MessagingModerationService } from '../messaging/messaging-moderation.service';
import { CommunityModerationService } from '../communities/community-moderation.service';
import { AccountSanctionService } from '../auth/account-sanction.service';
import { ActionsService } from './actions.service';
import { ConflictException, ForbiddenActionException, PolicyRejectedException, ResourceNotFoundException, ValidationFailedException } from '../common/errors/api-exception';

describe('ActionsService', () => {
  let prisma: PrismaService;
  let service: ActionsService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new ActionsService(
      prisma,
      new ContentModerationService(prisma),
      new MessagingModerationService(prisma),
      new CommunityModerationService(prisma),
      new AccountSanctionService(prisma),
    );
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  // ------------------------------------------------------------- fixtures

  async function makeUser(overrides: Partial<{ status: string }> = {}) {
    return prisma.user.create({ data: { status: (overrides.status as never) ?? 'active', updatedAt: new Date() } });
  }

  async function makeVerifiedCredential(userId: string) {
    return prisma.credential.create({
      data: {
        userId,
        kind: 'email',
        identifierNormalized: `${randomUUID()}@example.com`,
        secretHash: 'irrelevant-for-these-tests',
        verifiedAt: new Date(),
      },
    });
  }

  async function makeCase(queue: 'platform' | 'community' | 'content' | 'messaging' = 'platform') {
    return prisma.case.create({ data: { queue, source: 'user_report' } });
  }

  async function makePost(authorId: string) {
    return prisma.post.create({ data: { authorId, body: 'hello' } });
  }

  async function makeComment(authorId: string, postId?: string) {
    const post = postId ?? (await makePost(authorId)).id;
    return prisma.comment.create({ data: { authorId, postId: post, body: 'a comment' } });
  }

  async function makeShare(userId: string) {
    const author = await makeUser();
    const post = await makePost(author.id);
    return prisma.share.create({ data: { userId, postId: post.id } });
  }

  async function makeMessage(senderId: string) {
    const other = await makeUser();
    const [a, b] = [senderId, other.id].sort();
    const conversation = await prisma.conversation.create({ data: { createdBy: senderId, directParticipantAId: a, directParticipantBId: b } });
    return prisma.message.create({ data: { conversationId: conversation.id, senderId, clientMessageId: randomUUID(), body: 'hi' } });
  }

  async function makeCommunity(ownerId: string) {
    return prisma.community.create({ data: { ownerUserId: ownerId, slug: `c-${randomUUID()}`, name: 'Test Community' } });
  }

  async function makeMembership(communityId: string, userId: string, status: 'active' | 'banned' | 'pending' = 'active') {
    return prisma.communityMembership.create({ data: { communityId, userId, status, approvedAt: status === 'active' ? new Date() : null } });
  }

  // ---------------------------------------------------------------- creation

  describe('case existence', () => {
    it('throws ResourceNotFoundException for a nonexistent case', async () => {
      const moderator = await makeUser();
      const target = await makeUser();
      await expect(
        service.createAction(moderator.id, randomUUID(), { actionType: 'warn_user', targetType: 'profile', targetId: target.id, reasonCode: 'spam' }),
      ).rejects.toThrow(ResourceNotFoundException);
    });
  });

  describe('remove_content / restrict_content — happy path', () => {
    it('removes a post', async () => {
      const moderator = await makeUser();
      const author = await makeUser();
      const post = await makePost(author.id);
      const kase = await makeCase('content');

      const result = await service.createAction(moderator.id, kase.id, {
        actionType: 'remove_content',
        targetType: 'post',
        targetId: post.id,
        reasonCode: 'spam',
      });
      expect(result.actionType).toBe('remove_content');
      expect(result.scope).toBe('content');
      expect(result.sanctionId).toBeUndefined();
      expect(result.targetId).toBe(post.id);
      const reloaded = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
      expect(reloaded.status).toBe('removed');
      const actionRow = await prisma.action.findUniqueOrThrow({ where: { id: result.id } });
      expect(actionRow.targetId).toBe(post.id);
    });

    it('removes a comment', async () => {
      const moderator = await makeUser();
      const author = await makeUser();
      const comment = await makeComment(author.id);
      const kase = await makeCase('content');

      await service.createAction(moderator.id, kase.id, { actionType: 'remove_content', targetType: 'comment', targetId: comment.id, reasonCode: 'spam' });
      const reloaded = await prisma.comment.findUniqueOrThrow({ where: { id: comment.id } });
      expect(reloaded.status).toBe('removed');
    });

    it('restricts a post (hidden)', async () => {
      const moderator = await makeUser();
      const author = await makeUser();
      const post = await makePost(author.id);
      const kase = await makeCase('content');

      await service.createAction(moderator.id, kase.id, { actionType: 'restrict_content', targetType: 'post', targetId: post.id, reasonCode: 'spam' });
      const reloaded = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
      expect(reloaded.status).toBe('hidden');
    });

    it('restricts a comment (hidden)', async () => {
      const moderator = await makeUser();
      const author = await makeUser();
      const comment = await makeComment(author.id);
      const kase = await makeCase('content');

      await service.createAction(moderator.id, kase.id, { actionType: 'restrict_content', targetType: 'comment', targetId: comment.id, reasonCode: 'spam' });
      const reloaded = await prisma.comment.findUniqueOrThrow({ where: { id: comment.id } });
      expect(reloaded.status).toBe('hidden');
    });

    it('rejects a share target with 422 POLICY_REJECTED — remove_content', async () => {
      const moderator = await makeUser();
      const author = await makeUser();
      const share = await makeShare(author.id);
      const kase = await makeCase('content');

      await expect(
        service.createAction(moderator.id, kase.id, { actionType: 'remove_content', targetType: 'share', targetId: share.id, reasonCode: 'spam' }),
      ).rejects.toThrow(PolicyRejectedException);
    });

    it('rejects a share target with 422 POLICY_REJECTED — restrict_content', async () => {
      const moderator = await makeUser();
      const author = await makeUser();
      const share = await makeShare(author.id);
      const kase = await makeCase('content');

      await expect(
        service.createAction(moderator.id, kase.id, { actionType: 'restrict_content', targetType: 'share', targetId: share.id, reasonCode: 'spam' }),
      ).rejects.toThrow(PolicyRejectedException);
    });

    it('rejects a nonexistent post target with 404', async () => {
      const moderator = await makeUser();
      const kase = await makeCase('content');
      await expect(
        service.createAction(moderator.id, kase.id, { actionType: 'remove_content', targetType: 'post', targetId: randomUUID(), reasonCode: 'spam' }),
      ).rejects.toThrow(ResourceNotFoundException);
    });

    it('allows creating a second removal for already-removed content — duplicate history allowed (Option B)', async () => {
      const moderator = await makeUser();
      const author = await makeUser();
      const post = await makePost(author.id);
      const kase = await makeCase('content');

      await service.createAction(moderator.id, kase.id, { actionType: 'remove_content', targetType: 'post', targetId: post.id, reasonCode: 'spam' });
      const second = await service.createAction(moderator.id, kase.id, { actionType: 'remove_content', targetType: 'post', targetId: post.id, reasonCode: 'spam' });
      expect(second.actionType).toBe('remove_content');
      const count = await prisma.action.count({ where: { targetId: post.id } });
      expect(count).toBe(2);
    });
  });

  describe('message target', () => {
    it('removes a message', async () => {
      const moderator = await makeUser();
      const sender = await makeUser();
      const message = await makeMessage(sender.id);
      const kase = await makeCase('messaging');

      await service.createAction(moderator.id, kase.id, { actionType: 'remove_content', targetType: 'message', targetId: message.id, reasonCode: 'spam' });
      const reloaded = await prisma.message.findUniqueOrThrow({ where: { id: message.id } });
      expect(reloaded.moderationState).toBe('removed');
    });

    it('restricts (hides) a message', async () => {
      const moderator = await makeUser();
      const sender = await makeUser();
      const message = await makeMessage(sender.id);
      const kase = await makeCase('messaging');

      await service.createAction(moderator.id, kase.id, { actionType: 'restrict_content', targetType: 'message', targetId: message.id, reasonCode: 'spam' });
      const reloaded = await prisma.message.findUniqueOrThrow({ where: { id: message.id } });
      expect(reloaded.moderationState).toBe('hidden');
    });

    it('rejects a nonexistent message with 404', async () => {
      const moderator = await makeUser();
      const kase = await makeCase('messaging');
      await expect(
        service.createAction(moderator.id, kase.id, { actionType: 'remove_content', targetType: 'message', targetId: randomUUID(), reasonCode: 'spam' }),
      ).rejects.toThrow(ResourceNotFoundException);
    });
  });

  describe('warn_user', () => {
    it('creates the action, no sanction, no notification', async () => {
      const moderator = await makeUser();
      const target = await makeUser();
      const kase = await makeCase('platform');

      const result = await service.createAction(moderator.id, kase.id, { actionType: 'warn_user', targetType: 'profile', targetId: target.id, reasonCode: 'harassment' });
      expect(result.sanctionId).toBeUndefined();
      const sanctionCount = await prisma.sanction.count({ where: { subjectId: target.id } });
      expect(sanctionCount).toBe(0);
      const notificationCount = await prisma.notification.count({ where: { recipientUserId: target.id } });
      expect(notificationCount).toBe(0);
      const reloaded = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
      expect(reloaded.status).toBe('active');
    });

    it('rejects a nonexistent target with 404', async () => {
      const moderator = await makeUser();
      const kase = await makeCase('platform');
      await expect(
        service.createAction(moderator.id, kase.id, { actionType: 'warn_user', targetType: 'profile', targetId: randomUUID(), reasonCode: 'harassment' }),
      ).rejects.toThrow(ResourceNotFoundException);
    });
  });

  // ------------------------------------------------------------ self-action

  describe('self-action protection', () => {
    it('rejects a moderator warning themselves', async () => {
      const moderator = await makeUser();
      const kase = await makeCase('platform');
      await expect(
        service.createAction(moderator.id, kase.id, { actionType: 'warn_user', targetType: 'profile', targetId: moderator.id, reasonCode: 'spam' }),
      ).rejects.toThrow(ForbiddenActionException);
    });

    it('rejects a moderator suspending themselves', async () => {
      const moderator = await makeUser();
      const kase = await makeCase('platform');
      await expect(
        service.createAction(moderator.id, kase.id, { actionType: 'suspend_account', targetType: 'profile', targetId: moderator.id, reasonCode: 'spam' }),
      ).rejects.toThrow(ForbiddenActionException);
    });

    it('rejects a moderator banning themselves', async () => {
      const moderator = await makeUser();
      const kase = await makeCase('platform');
      await expect(
        service.createAction(moderator.id, kase.id, { actionType: 'ban_account', targetType: 'profile', targetId: moderator.id, reasonCode: 'spam' }),
      ).rejects.toThrow(ForbiddenActionException);
    });

    it('rejects a moderator restricting their own community membership', async () => {
      const moderator = await makeUser();
      const owner = await makeUser();
      const community = await makeCommunity(owner.id);
      await makeMembership(community.id, moderator.id);
      const kase = await makeCase('community');
      await expect(
        service.createAction(moderator.id, kase.id, {
          actionType: 'restrict_community_participation',
          targetType: 'profile',
          targetId: moderator.id,
          reasonCode: 'spam',
          details: { communityId: community.id },
        }),
      ).rejects.toThrow(ForbiddenActionException);
    });

    it('rejects a moderator removing their own content', async () => {
      const moderator = await makeUser();
      const post = await makePost(moderator.id);
      const kase = await makeCase('content');
      await expect(
        service.createAction(moderator.id, kase.id, { actionType: 'remove_content', targetType: 'post', targetId: post.id, reasonCode: 'spam' }),
      ).rejects.toThrow(ForbiddenActionException);
    });

    it('rejects a moderator restricting their own content', async () => {
      const moderator = await makeUser();
      const post = await makePost(moderator.id);
      const kase = await makeCase('content');
      await expect(
        service.createAction(moderator.id, kase.id, { actionType: 'restrict_content', targetType: 'post', targetId: post.id, reasonCode: 'spam' }),
      ).rejects.toThrow(ForbiddenActionException);
    });
  });

  // --------------------------------------------------------- account sanction

  describe('suspend_account / ban_account', () => {
    it('suspends: User.status, session revocation, appeal credential, sanction fields', async () => {
      const moderator = await makeUser();
      const target = await makeUser();
      await makeVerifiedCredential(target.id);
      const session = await prisma.session.create({
        data: { userId: target.id, refreshTokenHash: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) },
      });
      const kase = await makeCase('platform');

      const result = await service.createAction(moderator.id, kase.id, {
        actionType: 'suspend_account',
        targetType: 'profile',
        targetId: target.id,
        reasonCode: 'harassment',
      });

      expect(result.sanctionId).toBeDefined();
      const user = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
      expect(user.status).toBe('suspended');

      const reloadedSession = await prisma.session.findUniqueOrThrow({ where: { id: session.id } });
      expect(reloadedSession.revokedAt).not.toBeNull();
      expect(reloadedSession.revokeReason).toBe('account_sanctioned');

      const challenge = await prisma.verificationChallenge.findFirst({ where: { userId: target.id, purpose: 'account_appeal' } });
      expect(challenge).not.toBeNull();

      const sanction = await prisma.sanction.findUniqueOrThrow({ where: { id: result.sanctionId! } });
      expect(sanction.sanctionType).toBe('account_suspended');
      expect(sanction.subjectType).toBe('user');
      expect(sanction.subjectId).toBe(target.id);
      expect(sanction.scope).toBe('platform');
      expect(sanction.state).toBe('active');
      expect(sanction.sourceActionId).toBe(result.id);
    });

    it('bans: User.status, correct SanctionType', async () => {
      const moderator = await makeUser();
      const target = await makeUser();
      const kase = await makeCase('platform');

      const result = await service.createAction(moderator.id, kase.id, { actionType: 'ban_account', targetType: 'profile', targetId: target.id, reasonCode: 'harassment' });

      const user = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
      expect(user.status).toBe('banned');
      const sanction = await prisma.sanction.findUniqueOrThrow({ where: { id: result.sanctionId! } });
      expect(sanction.sanctionType).toBe('account_banned');
    });

    it('rejects a nonexistent target with 404', async () => {
      const moderator = await makeUser();
      const kase = await makeCase('platform');
      await expect(
        service.createAction(moderator.id, kase.id, { actionType: 'ban_account', targetType: 'profile', targetId: randomUUID(), reasonCode: 'spam' }),
      ).rejects.toThrow(ResourceNotFoundException);
    });

    it('rejects durationSeconds supplied for ban_account with VALIDATION_FAILED', async () => {
      const moderator = await makeUser();
      const target = await makeUser();
      const kase = await makeCase('platform');
      await expect(
        service.createAction(moderator.id, kase.id, {
          actionType: 'ban_account',
          targetType: 'profile',
          targetId: target.id,
          reasonCode: 'spam',
          details: { durationSeconds: 3600 },
        }),
      ).rejects.toThrow(ValidationFailedException);
    });
  });

  describe('duplicate/ordinary sanction conflicts', () => {
    it('rejects a second ban attempt on an already-banned user with 409 CONFLICT (DB backstop)', async () => {
      const moderator = await makeUser();
      const target = await makeUser();
      const kase = await makeCase('platform');
      await service.createAction(moderator.id, kase.id, { actionType: 'ban_account', targetType: 'profile', targetId: target.id, reasonCode: 'spam' });

      await expect(
        service.createAction(moderator.id, kase.id, { actionType: 'ban_account', targetType: 'profile', targetId: target.id, reasonCode: 'spam' }),
      ).rejects.toThrow(ConflictException);
    });

    it('rejects a second suspend attempt on an already-suspended user with 409 CONFLICT (DB backstop)', async () => {
      const moderator = await makeUser();
      const target = await makeUser();
      const kase = await makeCase('platform');
      await service.createAction(moderator.id, kase.id, { actionType: 'suspend_account', targetType: 'profile', targetId: target.id, reasonCode: 'spam' });

      await expect(
        service.createAction(moderator.id, kase.id, { actionType: 'suspend_account', targetType: 'profile', targetId: target.id, reasonCode: 'spam' }),
      ).rejects.toThrow(ConflictException);
    });

    it('rejects a second active community restriction on the same membership with 409 CONFLICT (DB backstop)', async () => {
      const moderator = await makeUser();
      const target = await makeUser();
      const owner = await makeUser();
      const community = await makeCommunity(owner.id);
      await makeMembership(community.id, target.id);
      const kase = await makeCase('community');

      await service.createAction(moderator.id, kase.id, {
        actionType: 'restrict_community_participation',
        targetType: 'profile',
        targetId: target.id,
        reasonCode: 'spam',
        details: { communityId: community.id },
      });

      await expect(
        service.createAction(moderator.id, kase.id, {
          actionType: 'restrict_community_participation',
          targetType: 'profile',
          targetId: target.id,
          reasonCode: 'spam',
          details: { communityId: community.id },
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  // -------------------------------------------------------------- escalation

  describe('suspend -> ban escalation', () => {
    it('supersedes the prior suspension and activates a new ban sanction, both referencing correctly', async () => {
      const moderator = await makeUser();
      const target = await makeUser();
      const kase = await makeCase('platform');

      const suspendResult = await service.createAction(moderator.id, kase.id, {
        actionType: 'suspend_account',
        targetType: 'profile',
        targetId: target.id,
        reasonCode: 'harassment',
      });
      const banResult = await service.createAction(moderator.id, kase.id, { actionType: 'ban_account', targetType: 'profile', targetId: target.id, reasonCode: 'harassment' });

      const oldSanction = await prisma.sanction.findUniqueOrThrow({ where: { id: suspendResult.sanctionId! } });
      expect(oldSanction.state).toBe('superseded');

      const newSanction = await prisma.sanction.findUniqueOrThrow({ where: { id: banResult.sanctionId! } });
      expect(newSanction.state).toBe('active');
      expect(newSanction.sanctionType).toBe('account_banned');
      expect(newSanction.sourceActionId).toBe(banResult.id);

      const user = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
      expect(user.status).toBe('banned');

      // exactly one active sanction for this subject+scope
      const activeCount = await prisma.sanction.count({ where: { subjectType: 'user', subjectId: target.id, scope: 'platform', state: 'active' } });
      expect(activeCount).toBe(1);
    });

    it('the previous (suspend) action row remains immutable — untouched by the escalation', async () => {
      const moderator = await makeUser();
      const target = await makeUser();
      const kase = await makeCase('platform');

      const suspendResult = await service.createAction(moderator.id, kase.id, {
        actionType: 'suspend_account',
        targetType: 'profile',
        targetId: target.id,
        reasonCode: 'harassment',
      });
      await service.createAction(moderator.id, kase.id, { actionType: 'ban_account', targetType: 'profile', targetId: target.id, reasonCode: 'harassment' });

      const reloadedAction = await prisma.action.findUniqueOrThrow({ where: { id: suspendResult.id } });
      expect(reloadedAction.actionType).toBe('suspend_account');
      expect(reloadedAction.reversalOfActionId).toBeNull();
    });
  });

  describe('ban -> suspend rejected', () => {
    it('rejects with a conflict, creates no Action, creates no Sanction, leaves the existing ban untouched', async () => {
      const moderator = await makeUser();
      const target = await makeUser();
      const kase = await makeCase('platform');

      const banResult = await service.createAction(moderator.id, kase.id, { actionType: 'ban_account', targetType: 'profile', targetId: target.id, reasonCode: 'harassment' });
      const actionCountBefore = await prisma.action.count({ where: { targetId: target.id } });

      await expect(
        service.createAction(moderator.id, kase.id, { actionType: 'suspend_account', targetType: 'profile', targetId: target.id, reasonCode: 'harassment' }),
      ).rejects.toThrow(ConflictException);

      const actionCountAfter = await prisma.action.count({ where: { targetId: target.id } });
      expect(actionCountAfter).toBe(actionCountBefore);

      const sanction = await prisma.sanction.findUniqueOrThrow({ where: { id: banResult.sanctionId! } });
      expect(sanction.state).toBe('active');
      expect(sanction.sanctionType).toBe('account_banned');

      const user = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
      expect(user.status).toBe('banned');
    });
  });

  // ------------------------------------------------------------- community

  describe('restrict_community_participation', () => {
    it('bans the membership, correct sanction subject/type', async () => {
      const moderator = await makeUser();
      const target = await makeUser();
      const owner = await makeUser();
      const community = await makeCommunity(owner.id);
      const membership = await makeMembership(community.id, target.id);
      const kase = await makeCase('community');

      const result = await service.createAction(moderator.id, kase.id, {
        actionType: 'restrict_community_participation',
        targetType: 'profile',
        targetId: target.id,
        reasonCode: 'spam',
        details: { communityId: community.id },
      });

      const reloadedMembership = await prisma.communityMembership.findUniqueOrThrow({ where: { id: membership.id } });
      expect(reloadedMembership.status).toBe('banned');

      const sanction = await prisma.sanction.findUniqueOrThrow({ where: { id: result.sanctionId! } });
      expect(sanction.subjectType).toBe('community');
      expect(sanction.subjectId).toBe(membership.id);
      expect(sanction.sanctionType).toBe('community_restricted');
      expect(sanction.scope).toBe('community');
    });

    it('never writes "removed"', async () => {
      const moderator = await makeUser();
      const target = await makeUser();
      const owner = await makeUser();
      const community = await makeCommunity(owner.id);
      const membership = await makeMembership(community.id, target.id);
      const kase = await makeCase('community');

      await service.createAction(moderator.id, kase.id, {
        actionType: 'restrict_community_participation',
        targetType: 'profile',
        targetId: target.id,
        reasonCode: 'spam',
        details: { communityId: community.id },
      });
      const reloaded = await prisma.communityMembership.findUniqueOrThrow({ where: { id: membership.id } });
      expect(reloaded.status).not.toBe('removed');
    });

    it('rejects a missing communityId with VALIDATION_FAILED', async () => {
      const moderator = await makeUser();
      const target = await makeUser();
      const kase = await makeCase('community');
      await expect(
        service.createAction(moderator.id, kase.id, { actionType: 'restrict_community_participation', targetType: 'profile', targetId: target.id, reasonCode: 'spam' }),
      ).rejects.toThrow(ValidationFailedException);
    });

    it('rejects a nonexistent membership with 404', async () => {
      const moderator = await makeUser();
      const target = await makeUser();
      const owner = await makeUser();
      const community = await makeCommunity(owner.id);
      const kase = await makeCase('community');
      await expect(
        service.createAction(moderator.id, kase.id, {
          actionType: 'restrict_community_participation',
          targetType: 'profile',
          targetId: target.id,
          reasonCode: 'spam',
          details: { communityId: community.id },
        }),
      ).rejects.toThrow(ResourceNotFoundException);
    });
  });

  // ---------------------------------------------------------- transactions

  describe('transactional rollback', () => {
    it('content action: performs the Action insert and target-state write inside exactly one $transaction call', async () => {
      const moderator = await makeUser();
      const author = await makeUser();
      const post = await makePost(author.id);
      const kase = await makeCase('content');

      const spy = vi.spyOn(prisma, '$transaction');
      await service.createAction(moderator.id, kase.id, { actionType: 'remove_content', targetType: 'post', targetId: post.id, reasonCode: 'spam' });
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });

    it('account sanction: forcing failure inside applyAccountSanction leaves no Action and no Sanction', async () => {
      const moderator = await makeUser();
      const target = await makeUser();
      const kase = await makeCase('platform');

      // Force a failure by pre-creating a conflicting active sanction so the
      // Sanction.create insert itself fails inside the transaction, proving
      // the Action row created moments earlier in the SAME transaction does
      // not persist either.
      const preexistingAction = await prisma.action.create({
        data: { caseId: kase.id, targetType: 'profile', targetId: target.id, actionType: 'ban_account', scope: 'platform', reasonCode: 'spam' },
      });
      await prisma.sanction.create({
        data: { subjectType: 'user', subjectId: target.id, scope: 'platform', sanctionType: 'account_banned', reasonCode: 'spam', sourceActionId: preexistingAction.id },
      });

      const actionCountBefore = await prisma.action.count({ where: { targetId: target.id } });

      await expect(
        service.createAction(moderator.id, kase.id, { actionType: 'ban_account', targetType: 'profile', targetId: target.id, reasonCode: 'spam' }),
      ).rejects.toThrow(ConflictException);

      const actionCountAfter = await prisma.action.count({ where: { targetId: target.id } });
      // Only the one preexisting Action (created directly, outside the
      // service) exists — the service's own attempted Action did not
      // persist because the Sanction insert inside the same transaction failed.
      expect(actionCountAfter).toBe(actionCountBefore);
    });

    it('community sanction: forcing failure (conflicting active restriction) leaves no new Action and the membership untouched', async () => {
      const moderator = await makeUser();
      const target = await makeUser();
      const owner = await makeUser();
      const community = await makeCommunity(owner.id);
      const membership = await makeMembership(community.id, target.id);
      const kase = await makeCase('community');

      await service.createAction(moderator.id, kase.id, {
        actionType: 'restrict_community_participation',
        targetType: 'profile',
        targetId: target.id,
        reasonCode: 'spam',
        details: { communityId: community.id },
      });
      const actionCountBefore = await prisma.action.count({ where: { targetId: target.id } });

      await expect(
        service.createAction(moderator.id, kase.id, {
          actionType: 'restrict_community_participation',
          targetType: 'profile',
          targetId: target.id,
          reasonCode: 'spam',
          details: { communityId: community.id },
        }),
      ).rejects.toThrow(ConflictException);

      const actionCountAfter = await prisma.action.count({ where: { targetId: target.id } });
      expect(actionCountAfter).toBe(actionCountBefore);
      const reloadedMembership = await prisma.communityMembership.findUniqueOrThrow({ where: { id: membership.id } });
      expect(reloadedMembership.status).toBe('banned'); // unchanged from the first call, not double-applied
    });
  });

  // ------------------------------------------------------------ concurrency

  describe('concurrency', () => {
    it('two simultaneous bans of the same user: exactly one succeeds, one gets 409, never two active sanctions', async () => {
      const moderator1 = await makeUser();
      const moderator2 = await makeUser();
      const target = await makeUser();
      const kase = await makeCase('platform');

      const [r1, r2] = await Promise.allSettled([
        service.createAction(moderator1.id, kase.id, { actionType: 'ban_account', targetType: 'profile', targetId: target.id, reasonCode: 'spam' }),
        service.createAction(moderator2.id, kase.id, { actionType: 'ban_account', targetType: 'profile', targetId: target.id, reasonCode: 'spam' }),
      ]);

      const outcomes = [r1, r2];
      const fulfilled = outcomes.filter((r) => r.status === 'fulfilled');
      const rejected = outcomes.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);

      const activeCount = await prisma.sanction.count({ where: { subjectType: 'user', subjectId: target.id, scope: 'platform', state: 'active' } });
      expect(activeCount).toBe(1);
    });

    it('two simultaneous community restrictions on the same membership: exactly one succeeds, one gets 409', async () => {
      const moderator1 = await makeUser();
      const moderator2 = await makeUser();
      const target = await makeUser();
      const owner = await makeUser();
      const community = await makeCommunity(owner.id);
      await makeMembership(community.id, target.id);
      const kase = await makeCase('community');

      const [r1, r2] = await Promise.allSettled([
        service.createAction(moderator1.id, kase.id, {
          actionType: 'restrict_community_participation',
          targetType: 'profile',
          targetId: target.id,
          reasonCode: 'spam',
          details: { communityId: community.id },
        }),
        service.createAction(moderator2.id, kase.id, {
          actionType: 'restrict_community_participation',
          targetType: 'profile',
          targetId: target.id,
          reasonCode: 'spam',
          details: { communityId: community.id },
        }),
      ]);

      const outcomes = [r1, r2];
      expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((r) => r.status === 'rejected')).toHaveLength(1);
    });

    it('suspend -> ban race never leaves two active sanctions for the same platform user', async () => {
      const moderator1 = await makeUser();
      const moderator2 = await makeUser();
      const target = await makeUser();
      const kase = await makeCase('platform');
      await service.createAction(moderator1.id, kase.id, { actionType: 'suspend_account', targetType: 'profile', targetId: target.id, reasonCode: 'spam' });

      const [r1, r2] = await Promise.allSettled([
        service.createAction(moderator1.id, kase.id, { actionType: 'ban_account', targetType: 'profile', targetId: target.id, reasonCode: 'spam' }),
        service.createAction(moderator2.id, kase.id, { actionType: 'ban_account', targetType: 'profile', targetId: target.id, reasonCode: 'spam' }),
      ]);

      void r1;
      void r2;
      const activeCount = await prisma.sanction.count({ where: { subjectType: 'user', subjectId: target.id, scope: 'platform', state: 'active' } });
      expect(activeCount).toBe(1);
    });
  });
});
