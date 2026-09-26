import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../common/prisma/prisma.service';
import { CommunityModerationService } from './community-moderation.service';

// Unit-level (no HTTP layer, direct PrismaService instantiation — same
// pattern as content-moderation.service.spec.ts/messaging-moderation.service.
// spec.ts): CommunityModerationService is the cross-module surface
// Moderation will call (docs/05-api/moderation.md §7) — applyMembershipSanction/
// liftMembershipSanction to execute/reverse restrict_community_participation,
// resolveMembership/resolveCommunityOwnerId as the privileged lookups the
// action-creation flow and the appeal affected-party check need. Not yet
// consumed by any module (Moderation doesn't exist yet) — built and tested
// in isolation now so it is correct before anything depends on it.
describe('CommunityModerationService', () => {
  let prisma: PrismaService;
  let service: CommunityModerationService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new CommunityModerationService(prisma);
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  async function makeUser() {
    return prisma.user.create({ data: { status: 'active', updatedAt: new Date() } });
  }

  async function makeCommunity(ownerUserId: string, overrides: Partial<{ status: string; deletedAt: Date; membershipPolicy: string }> = {}) {
    return prisma.community.create({
      data: {
        ownerUserId,
        slug: `test-${randomUUID()}`,
        name: 'Test Community',
        status: overrides.status ?? 'active',
        deletedAt: overrides.deletedAt ?? null,
        membershipPolicy: overrides.membershipPolicy ?? 'open',
      },
    });
  }

  async function makeMembership(
    communityId: string,
    userId: string,
    overrides: Partial<{ status: string; removedAt: Date; leftAt: Date; approvedAt: Date }> = {},
  ) {
    return prisma.communityMembership.create({
      data: {
        communityId,
        userId,
        status: (overrides.status as never) ?? 'active',
        removedAt: overrides.removedAt ?? null,
        leftAt: overrides.leftAt ?? null,
        approvedAt: overrides.approvedAt ?? null,
      },
    });
  }

  describe('applyMembershipSanction', () => {
    it('moves a membership from active to removed', async () => {
      const owner = await makeUser();
      const community = await makeCommunity(owner.id);
      const member = await makeUser();
      const membership = await makeMembership(community.id, member.id, { status: 'active' });
      await service.applyMembershipSanction(membership.id, 'removed');
      const updated = await prisma.communityMembership.findUniqueOrThrow({ where: { id: membership.id } });
      expect(updated.status).toBe('removed');
    });

    it('moves a membership from active to banned', async () => {
      const owner = await makeUser();
      const community = await makeCommunity(owner.id);
      const member = await makeUser();
      const membership = await makeMembership(community.id, member.id, { status: 'active' });
      await service.applyMembershipSanction(membership.id, 'banned');
      const updated = await prisma.communityMembership.findUniqueOrThrow({ where: { id: membership.id } });
      expect(updated.status).toBe('banned');
    });

    it('escalates a membership from removed to banned', async () => {
      const owner = await makeUser();
      const community = await makeCommunity(owner.id);
      const member = await makeUser();
      const membership = await makeMembership(community.id, member.id, { status: 'removed' });
      await service.applyMembershipSanction(membership.id, 'banned');
      const updated = await prisma.communityMembership.findUniqueOrThrow({ where: { id: membership.id } });
      expect(updated.status).toBe('banned');
    });

    it('is idempotent when the same status is applied again', async () => {
      const owner = await makeUser();
      const community = await makeCommunity(owner.id);
      const member = await makeUser();
      const membership = await makeMembership(community.id, member.id, { status: 'banned' });
      await service.applyMembershipSanction(membership.id, 'banned');
      const updated = await prisma.communityMembership.findUniqueOrThrow({ where: { id: membership.id } });
      expect(updated.status).toBe('banned');
    });

    it('does not change removedAt', async () => {
      const owner = await makeUser();
      const community = await makeCommunity(owner.id);
      const member = await makeUser();
      const removedAt = new Date('2026-01-01T00:00:00Z');
      const membership = await makeMembership(community.id, member.id, { status: 'active', removedAt });
      await service.applyMembershipSanction(membership.id, 'removed');
      const updated = await prisma.communityMembership.findUniqueOrThrow({ where: { id: membership.id } });
      expect(updated.removedAt).toEqual(removedAt);
    });

    it('does not change leftAt', async () => {
      const owner = await makeUser();
      const community = await makeCommunity(owner.id);
      const member = await makeUser();
      const leftAt = new Date('2026-01-02T00:00:00Z');
      const membership = await makeMembership(community.id, member.id, { status: 'active', leftAt });
      await service.applyMembershipSanction(membership.id, 'banned');
      const updated = await prisma.communityMembership.findUniqueOrThrow({ where: { id: membership.id } });
      expect(updated.leftAt).toEqual(leftAt);
    });

    it('does not change approvedAt', async () => {
      const owner = await makeUser();
      const community = await makeCommunity(owner.id);
      const member = await makeUser();
      const approvedAt = new Date('2026-01-03T00:00:00Z');
      const membership = await makeMembership(community.id, member.id, { status: 'active', approvedAt });
      await service.applyMembershipSanction(membership.id, 'removed');
      const updated = await prisma.communityMembership.findUniqueOrThrow({ where: { id: membership.id } });
      expect(updated.approvedAt).toEqual(approvedAt);
    });

    it('throws (propagating Prisma P2025) for a nonexistent membership id', async () => {
      await expect(service.applyMembershipSanction(randomUUID(), 'banned')).rejects.toMatchObject({ code: 'P2025' });
    });

    it('applies and commits inside a passed-in transaction', async () => {
      const owner = await makeUser();
      const community = await makeCommunity(owner.id);
      const member = await makeUser();
      const membership = await makeMembership(community.id, member.id, { status: 'active' });
      await prisma.$transaction(async (tx) => {
        await service.applyMembershipSanction(membership.id, 'banned', tx);
      });
      const updated = await prisma.communityMembership.findUniqueOrThrow({ where: { id: membership.id } });
      expect(updated.status).toBe('banned');
    });

    it('rolls back with the rest of the transaction when the transaction fails after the call', async () => {
      const owner = await makeUser();
      const community = await makeCommunity(owner.id);
      const member = await makeUser();
      const membership = await makeMembership(community.id, member.id, { status: 'active' });
      await expect(
        prisma.$transaction(async (tx) => {
          await service.applyMembershipSanction(membership.id, 'banned', tx);
          throw new Error('simulated failure after the status update');
        }),
      ).rejects.toThrow('simulated failure after the status update');
      const unchanged = await prisma.communityMembership.findUniqueOrThrow({ where: { id: membership.id } });
      expect(unchanged.status).toBe('active');
    });
  });

  describe('liftMembershipSanction', () => {
    it('restores a banned membership to active', async () => {
      const owner = await makeUser();
      const community = await makeCommunity(owner.id);
      const member = await makeUser();
      const membership = await makeMembership(community.id, member.id, { status: 'banned' });
      await service.liftMembershipSanction(membership.id);
      const updated = await prisma.communityMembership.findUniqueOrThrow({ where: { id: membership.id } });
      expect(updated.status).toBe('active');
    });

    it('restores a removed membership to active', async () => {
      const owner = await makeUser();
      const community = await makeCommunity(owner.id);
      const member = await makeUser();
      const membership = await makeMembership(community.id, member.id, { status: 'removed' });
      await service.liftMembershipSanction(membership.id);
      const updated = await prisma.communityMembership.findUniqueOrThrow({ where: { id: membership.id } });
      expect(updated.status).toBe('active');
    });

    it('is idempotent when lifted again', async () => {
      const owner = await makeUser();
      const community = await makeCommunity(owner.id);
      const member = await makeUser();
      const membership = await makeMembership(community.id, member.id, { status: 'banned' });
      await service.liftMembershipSanction(membership.id);
      await service.liftMembershipSanction(membership.id);
      const updated = await prisma.communityMembership.findUniqueOrThrow({ where: { id: membership.id } });
      expect(updated.status).toBe('active');
    });

    it('does not change removedAt', async () => {
      const owner = await makeUser();
      const community = await makeCommunity(owner.id);
      const member = await makeUser();
      const removedAt = new Date('2026-01-01T00:00:00Z');
      const membership = await makeMembership(community.id, member.id, { status: 'removed', removedAt });
      await service.liftMembershipSanction(membership.id);
      const updated = await prisma.communityMembership.findUniqueOrThrow({ where: { id: membership.id } });
      expect(updated.removedAt).toEqual(removedAt);
    });

    it('does not change leftAt', async () => {
      const owner = await makeUser();
      const community = await makeCommunity(owner.id);
      const member = await makeUser();
      const leftAt = new Date('2026-01-02T00:00:00Z');
      const membership = await makeMembership(community.id, member.id, { status: 'banned', leftAt });
      await service.liftMembershipSanction(membership.id);
      const updated = await prisma.communityMembership.findUniqueOrThrow({ where: { id: membership.id } });
      expect(updated.leftAt).toEqual(leftAt);
    });

    it('does not change approvedAt', async () => {
      const owner = await makeUser();
      const community = await makeCommunity(owner.id);
      const member = await makeUser();
      const approvedAt = new Date('2026-01-03T00:00:00Z');
      const membership = await makeMembership(community.id, member.id, { status: 'banned', approvedAt });
      await service.liftMembershipSanction(membership.id);
      const updated = await prisma.communityMembership.findUniqueOrThrow({ where: { id: membership.id } });
      expect(updated.approvedAt).toEqual(approvedAt);
    });

    it("restores to active even when the community's membershipPolicy is 'approval_required' — lift never routes through membershipPolicy (owner decision K.2)", async () => {
      const owner = await makeUser();
      const community = await makeCommunity(owner.id, { membershipPolicy: 'approval_required' });
      const member = await makeUser();
      const membership = await makeMembership(community.id, member.id, { status: 'banned' });
      await service.liftMembershipSanction(membership.id);
      const updated = await prisma.communityMembership.findUniqueOrThrow({ where: { id: membership.id } });
      expect(updated.status).toBe('active');
    });

    it('throws (propagating Prisma P2025) for a nonexistent membership id', async () => {
      await expect(service.liftMembershipSanction(randomUUID())).rejects.toMatchObject({ code: 'P2025' });
    });

    it('applies and commits inside a passed-in transaction', async () => {
      const owner = await makeUser();
      const community = await makeCommunity(owner.id);
      const member = await makeUser();
      const membership = await makeMembership(community.id, member.id, { status: 'banned' });
      await prisma.$transaction(async (tx) => {
        await service.liftMembershipSanction(membership.id, tx);
      });
      const updated = await prisma.communityMembership.findUniqueOrThrow({ where: { id: membership.id } });
      expect(updated.status).toBe('active');
    });

    it('rolls back with the rest of the transaction when the transaction fails after the call', async () => {
      const owner = await makeUser();
      const community = await makeCommunity(owner.id);
      const member = await makeUser();
      const membership = await makeMembership(community.id, member.id, { status: 'banned' });
      await expect(
        prisma.$transaction(async (tx) => {
          await service.liftMembershipSanction(membership.id, tx);
          throw new Error('simulated failure after the restore');
        }),
      ).rejects.toThrow('simulated failure after the restore');
      const unchanged = await prisma.communityMembership.findUniqueOrThrow({ where: { id: membership.id } });
      expect(unchanged.status).toBe('banned');
    });
  });

  describe('resolveMembership', () => {
    it('selects the active row when present, even alongside older historical rows', async () => {
      const owner = await makeUser();
      const community = await makeCommunity(owner.id);
      const member = await makeUser();
      await makeMembership(community.id, member.id, { status: 'left' });
      const active = await makeMembership(community.id, member.id, { status: 'active' });
      await expect(service.resolveMembership(community.id, member.id)).resolves.toEqual({ id: active.id, status: 'active' });
    });

    it('selects the pending row when no active row exists', async () => {
      const owner = await makeUser();
      const community = await makeCommunity(owner.id);
      const member = await makeUser();
      const pending = await makeMembership(community.id, member.id, { status: 'pending' });
      await expect(service.resolveMembership(community.id, member.id)).resolves.toEqual({ id: pending.id, status: 'pending' });
    });

    it('selects the most recent historical row when neither active nor pending exists', async () => {
      const owner = await makeUser();
      const community = await makeCommunity(owner.id);
      const member = await makeUser();
      await makeMembership(community.id, member.id, { status: 'rejected' });
      const latest = await makeMembership(community.id, member.id, { status: 'left' });
      await expect(service.resolveMembership(community.id, member.id)).resolves.toEqual({ id: latest.id, status: 'left' });
    });

    it('resolves a removed-only row', async () => {
      const owner = await makeUser();
      const community = await makeCommunity(owner.id);
      const member = await makeUser();
      const removed = await makeMembership(community.id, member.id, { status: 'removed' });
      await expect(service.resolveMembership(community.id, member.id)).resolves.toEqual({ id: removed.id, status: 'removed' });
    });

    it('resolves a banned-only row', async () => {
      const owner = await makeUser();
      const community = await makeCommunity(owner.id);
      const member = await makeUser();
      const banned = await makeMembership(community.id, member.id, { status: 'banned' });
      await expect(service.resolveMembership(community.id, member.id)).resolves.toEqual({ id: banned.id, status: 'banned' });
    });

    it('resolves a left/rejected-only row', async () => {
      const owner = await makeUser();
      const community = await makeCommunity(owner.id);
      const member = await makeUser();
      const rejected = await makeMembership(community.id, member.id, { status: 'rejected' });
      await expect(service.resolveMembership(community.id, member.id)).resolves.toEqual({ id: rejected.id, status: 'rejected' });
    });

    it('returns null for a pair with no membership rows at all', async () => {
      const owner = await makeUser();
      const community = await makeCommunity(owner.id);
      const stranger = await makeUser();
      await expect(service.resolveMembership(community.id, stranger.id)).resolves.toBeNull();
    });

    it('still resolves a membership when the community itself is deleted/inactive', async () => {
      const owner = await makeUser();
      const community = await makeCommunity(owner.id, { status: 'removed', deletedAt: new Date() });
      const member = await makeUser();
      const membership = await makeMembership(community.id, member.id, { status: 'banned' });
      await expect(service.resolveMembership(community.id, member.id)).resolves.toEqual({ id: membership.id, status: 'banned' });
    });
  });

  describe('resolveCommunityOwnerId', () => {
    it('resolves the owner regardless of community status', async () => {
      const owner = await makeUser();
      const community = await makeCommunity(owner.id, { status: 'removed' });
      await expect(service.resolveCommunityOwnerId(community.id)).resolves.toBe(owner.id);
    });

    it('resolves the owner regardless of deletedAt', async () => {
      const owner = await makeUser();
      const community = await makeCommunity(owner.id, { deletedAt: new Date() });
      await expect(service.resolveCommunityOwnerId(community.id)).resolves.toBe(owner.id);
    });

    it('returns null (never throws) for a nonexistent community id', async () => {
      await expect(service.resolveCommunityOwnerId(randomUUID())).resolves.toBeNull();
    });
  });
});
