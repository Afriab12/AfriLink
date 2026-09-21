import { Injectable } from '@nestjs/common';
import type { Profile } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { ResourceNotFoundException } from '../common/errors/api-exception';

// Shared by ProfilesService (profile reads) and SocialGraphService
// (followers/following list reads) so the visibility/block rule can only
// be defined once. Extracted from ProfilesService.getProfileFor with no
// behavior change — see profiles.service.spec / profiles.e2e-spec for the
// regression check.
@Injectable()
export class ProfileVisibilityService {
  constructor(private readonly prisma: PrismaService) {}

  // Same 404 regardless of "doesn't exist" vs "not active" vs "deleted" —
  // api.md §6: never disambiguate why a resource is unreachable.
  async resolveActiveUser(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.status !== 'active' || user.deletedAt) {
      throw new ResourceNotFoundException();
    }
    return user;
  }

  async isBlocked(userAId: string, userBId: string): Promise<boolean> {
    const blocked = await this.prisma.block.findFirst({
      where: {
        deletedAt: null,
        OR: [
          { blockerId: userAId, blockedId: userBId },
          { blockerId: userBId, blockedId: userAId },
        ],
      },
    });
    return blocked !== null;
  }

  // Every user the given user has blocked or is blocked by (active blocks
  // only, either direction): the same relation isBlocked() checks pairwise,
  // for filtering a whole list at once instead of one lookup per row.
  // De-duplicated, since a mutual block would otherwise list the other user
  // twice.
  async blockedUserIds(userId: string): Promise<string[]> {
    const [blockedByMe, blockedMe] = await Promise.all([
      this.prisma.block.findMany({ where: { blockerId: userId, deletedAt: null }, select: { blockedId: true } }),
      this.prisma.block.findMany({ where: { blockedId: userId, deletedAt: null }, select: { blockerId: true } }),
    ]);
    return [...new Set([...blockedByMe.map((b) => b.blockedId), ...blockedMe.map((b) => b.blockerId)])];
  }

  // No-op when viewerId is undefined (anonymous) or equals targetId (self)
  // — there's no block relationship to check in either case.
  async assertNotBlocked(viewerId: string | undefined, targetId: string): Promise<void> {
    if (!viewerId || viewerId === targetId) {
      return;
    }
    if (await this.isBlocked(viewerId, targetId)) {
      throw new ResourceNotFoundException();
    }
  }

  // Profile.visibility (public/followers/private) — the same rule governs
  // whether the profile itself, and the follower/following lists, are
  // visible to a given viewer (judgment call 5: reusing this field rather
  // than inventing a separate "restrict followability" one that doesn't
  // exist in the schema).
  async canViewProfile(
    viewerId: string | undefined,
    target: { id: string; profile: Pick<Profile, 'visibility'> | null },
  ): Promise<boolean> {
    if (viewerId === target.id) {
      return true;
    }

    const visibility = target.profile?.visibility ?? 'public';
    if (visibility === 'public') {
      return true;
    }
    if (visibility === 'private') {
      return false;
    }
    // 'followers'
    if (!viewerId) {
      return false;
    }
    const follows = await this.prisma.follow.findFirst({
      where: { followerId: viewerId, followeeId: target.id, deletedAt: null },
    });
    return follows !== null;
  }

  async assertCanViewProfile(
    viewerId: string | undefined,
    target: { id: string; profile: Pick<Profile, 'visibility'> | null },
  ): Promise<void> {
    if (!(await this.canViewProfile(viewerId, target))) {
      throw new ResourceNotFoundException();
    }
  }
}
