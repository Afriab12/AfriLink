import { Injectable } from '@nestjs/common';
import type { Friendship } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { ProfileVisibilityService } from '../profiles/profile-visibility.service';
import { ConflictException, PolicyRejectedException, ResourceNotFoundException } from '../common/errors/api-exception';

export interface FriendshipResponse {
  id: string;
  requesterId: string;
  addresseeId: string;
  status: string;
  requestedAt: Date;
  respondedAt: Date | null;
}

@Injectable()
export class SocialGraphService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly visibility: ProfileVisibilityService,
  ) {}

  private toFriendshipResponse(f: Friendship): FriendshipResponse {
    return {
      id: f.id,
      requesterId: f.requesterId,
      addresseeId: f.addresseeId,
      status: f.status,
      requestedAt: f.requestedAt,
      respondedAt: f.respondedAt,
    };
  }

  // ============================================================
  // Follows — one-way, no acceptance, idempotent (judgment call 3)
  // ============================================================

  async follow(viewerId: string, targetId: string): Promise<{ following: boolean }> {
    if (viewerId === targetId) {
      throw new PolicyRejectedException('You cannot follow yourself.');
    }
    await this.visibility.resolveActiveUser(targetId);
    // Blocked-party interactions are 404, not 403 (judgment call 1).
    await this.visibility.assertNotBlocked(viewerId, targetId);

    const existing = await this.prisma.follow.findFirst({
      where: { followerId: viewerId, followeeId: targetId, deletedAt: null },
    });
    if (!existing) {
      await this.prisma.follow.create({ data: { followerId: viewerId, followeeId: targetId } });
    }
    return { following: true };
  }

  async unfollow(viewerId: string, targetId: string): Promise<{ following: boolean }> {
    await this.prisma.follow.updateMany({
      where: { followerId: viewerId, followeeId: targetId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    return { following: false };
  }

  async listFollowers(viewerId: string | undefined, targetId: string) {
    const target = await this.prisma.user.findUnique({ where: { id: targetId }, include: { profile: true } });
    if (!target || target.status !== 'active' || target.deletedAt) {
      throw new ResourceNotFoundException();
    }
    await this.visibility.assertNotBlocked(viewerId, targetId);
    await this.visibility.assertCanViewProfile(viewerId, target);

    const rows = await this.prisma.follow.findMany({
      where: { followeeId: targetId, deletedAt: null },
      include: { follower: true },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({ userId: r.follower.id, handle: r.follower.handle }));
  }

  async listFollowing(viewerId: string | undefined, targetId: string) {
    const target = await this.prisma.user.findUnique({ where: { id: targetId }, include: { profile: true } });
    if (!target || target.status !== 'active' || target.deletedAt) {
      throw new ResourceNotFoundException();
    }
    await this.visibility.assertNotBlocked(viewerId, targetId);
    await this.visibility.assertCanViewProfile(viewerId, target);

    const rows = await this.prisma.follow.findMany({
      where: { followerId: targetId, deletedAt: null },
      include: { followee: true },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({ userId: r.followee.id, handle: r.followee.handle }));
  }

  // ============================================================
  // Friendships — mutual, request/accept, private by default
  // ============================================================

  async sendFriendRequest(requesterId: string, addresseeId: string): Promise<FriendshipResponse> {
    if (requesterId === addresseeId) {
      throw new PolicyRejectedException('You cannot send a friend request to yourself.');
    }
    await this.visibility.resolveActiveUser(addresseeId);
    await this.visibility.assertNotBlocked(requesterId, addresseeId);

    // Unordered-pair check, mirroring the DB's own active-pair partial
    // unique index (database.md §5) — pending/accepted only; a prior
    // declined/removed row does not block a fresh request (judgment call 4).
    const existing = await this.prisma.friendship.findFirst({
      where: {
        status: { in: ['pending', 'accepted'] },
        OR: [
          { requesterId, addresseeId },
          { requesterId: addresseeId, addresseeId: requesterId },
        ],
      },
    });
    if (existing) {
      throw new ConflictException('CONFLICT', 'A friend request or friendship already exists between these users.');
    }

    const friendship = await this.prisma.friendship.create({ data: { requesterId, addresseeId } });
    return this.toFriendshipResponse(friendship);
  }

  async acceptFriendRequest(userId: string, friendshipId: string): Promise<FriendshipResponse> {
    const friendship = await this.prisma.friendship.findUnique({ where: { id: friendshipId } });
    if (!friendship || friendship.addresseeId !== userId || friendship.status !== 'pending') {
      throw new ResourceNotFoundException();
    }
    const updated = await this.prisma.friendship.update({
      where: { id: friendshipId },
      data: { status: 'accepted', respondedAt: new Date() },
    });
    return this.toFriendshipResponse(updated);
  }

  async declineFriendRequest(userId: string, friendshipId: string): Promise<FriendshipResponse> {
    const friendship = await this.prisma.friendship.findUnique({ where: { id: friendshipId } });
    if (!friendship || friendship.addresseeId !== userId || friendship.status !== 'pending') {
      throw new ResourceNotFoundException();
    }
    const updated = await this.prisma.friendship.update({
      where: { id: friendshipId },
      data: { status: 'declined', respondedAt: new Date() },
    });
    return this.toFriendshipResponse(updated);
  }

  // Cancelling a pending request and removing an accepted friendship both
  // land on the same 'removed' status — no new enum value (judgment call 4).
  async cancelFriendRequest(userId: string, friendshipId: string): Promise<void> {
    const friendship = await this.prisma.friendship.findUnique({ where: { id: friendshipId } });
    if (!friendship || friendship.requesterId !== userId || friendship.status !== 'pending') {
      throw new ResourceNotFoundException();
    }
    await this.prisma.friendship.update({
      where: { id: friendshipId },
      data: { status: 'removed', respondedAt: new Date() },
    });
  }

  async removeFriendship(userId: string, friendshipId: string): Promise<void> {
    const friendship = await this.prisma.friendship.findUnique({ where: { id: friendshipId } });
    const isParticipant = friendship && (friendship.requesterId === userId || friendship.addresseeId === userId);
    if (!friendship || !isParticipant || friendship.status !== 'accepted') {
      throw new ResourceNotFoundException();
    }
    await this.prisma.friendship.update({
      where: { id: friendshipId },
      data: { status: 'removed', respondedAt: new Date() },
    });
  }

  async listFriendRequests(userId: string, direction: 'incoming' | 'outgoing'): Promise<FriendshipResponse[]> {
    const where =
      direction === 'incoming' ? { addresseeId: userId, status: 'pending' as const } : { requesterId: userId, status: 'pending' as const };
    const rows = await this.prisma.friendship.findMany({ where, orderBy: { createdAt: 'desc' } });
    return rows.map((r) => this.toFriendshipResponse(r));
  }

  // Friend-list visibility uses UserPreference.friendListVisible (private
  // by default), NOT Profile.visibility — a distinct, already-existing
  // field matching ADR-002's specific mention of this control. No
  // "visible to mutual friends" exception for MVP (judgment call 5).
  async listFriends(viewerId: string | undefined, targetId: string) {
    await this.visibility.resolveActiveUser(targetId);
    await this.visibility.assertNotBlocked(viewerId, targetId);

    const isSelf = viewerId === targetId;
    if (!isSelf) {
      const prefs = await this.prisma.userPreference.findUnique({ where: { userId: targetId } });
      const friendListVisible = prefs?.friendListVisible ?? false;
      if (!friendListVisible) {
        throw new ResourceNotFoundException();
      }
    }

    const rows = await this.prisma.friendship.findMany({
      where: { status: 'accepted', OR: [{ requesterId: targetId }, { addresseeId: targetId }] },
      include: { requester: true, addressee: true },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => {
      const other = r.requesterId === targetId ? r.addressee : r.requester;
      return { userId: other.id, handle: other.handle, friendshipId: r.id };
    });
  }

  // ============================================================
  // Blocks — cascades: severs existing follows/friendships
  // (judgment call 2). Unblocking does not restore them.
  // ============================================================

  async block(blockerId: string, blockedId: string): Promise<{ blocked: boolean }> {
    if (blockerId === blockedId) {
      throw new PolicyRejectedException('You cannot block yourself.');
    }
    await this.visibility.resolveActiveUser(blockedId);

    const existing = await this.prisma.block.findFirst({
      where: { blockerId, blockedId, deletedAt: null },
    });
    if (existing) {
      return { blocked: true };
    }

    await this.prisma.$transaction([
      this.prisma.block.create({ data: { blockerId, blockedId } }),
      this.prisma.follow.updateMany({
        where: {
          deletedAt: null,
          OR: [
            { followerId: blockerId, followeeId: blockedId },
            { followerId: blockedId, followeeId: blockerId },
          ],
        },
        data: { deletedAt: new Date() },
      }),
      this.prisma.friendship.updateMany({
        where: {
          status: { in: ['pending', 'accepted'] },
          OR: [
            { requesterId: blockerId, addresseeId: blockedId },
            { requesterId: blockedId, addresseeId: blockerId },
          ],
        },
        data: { status: 'removed', respondedAt: new Date() },
      }),
    ]);

    return { blocked: true };
  }

  async unblock(blockerId: string, blockedId: string): Promise<{ blocked: boolean }> {
    await this.prisma.block.updateMany({
      where: { blockerId, blockedId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    return { blocked: false };
  }

  async listBlocks(userId: string) {
    const rows = await this.prisma.block.findMany({
      where: { blockerId: userId, deletedAt: null },
      include: { blocked: true },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({ userId: r.blocked.id, handle: r.blocked.handle, reasonCode: r.reasonCode, blockedAt: r.createdAt }));
  }
}
