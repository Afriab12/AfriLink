import { Injectable } from '@nestjs/common';
import type { Community, CommunityMembership, Prisma, UserStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { ProfileVisibilityService } from '../profiles/profile-visibility.service';
import { CommunityAccessService, type CommunityRole, type ViewerRelation } from './community-access.service';
import {
  ForbiddenActionException,
  InvalidCursorException,
  PolicyRejectedException,
  ResourceNotFoundException,
} from '../common/errors/api-exception';
import { clampLimit, decodeCursor, toPage } from '../common/pagination/cursor';
import type { ListMembersQueryDto } from './dto/list-members-query.dto';

export interface MembershipStateResponse {
  communityId: string;
  status: string;
  role: CommunityRole;
}

export interface MemberResponse {
  userId: string;
  handle: string | null;
  displayName: string | null;
  role: string;
  status: string;
  joinedAt: Date | null;
  requestedAt: Date;
}

interface MemberRow extends CommunityMembership {
  user: {
    handle: string | null;
    status: UserStatus;
    deletedAt: Date | null;
    profile: { displayName: string | null; visibility: 'public' | 'followers' | 'private' } | null;
  };
}

@Injectable()
export class MembershipsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: CommunityAccessService,
    private readonly visibility: ProfileVisibilityService,
  ) {}

  // Nothing in the schema stops two pending rows for one (community, user)
  // (the unique index covers active rows only), and a check-then-insert
  // would race. Every membership change therefore runs in a transaction that
  // first takes a transaction-scoped advisory lock keyed on (community,
  // user): concurrent requests for the same pair queue up, and the second
  // one sees the first one's committed row.
  private async serialised<T>(communityId: string, userId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      const key = `community-membership:${communityId}:${userId}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
      return fn(tx);
    });
  }

  private async rowsFor(tx: Prisma.TransactionClient, communityId: string, userId: string): Promise<CommunityMembership[]> {
    return tx.communityMembership.findMany({ where: { communityId, userId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  }

  // ------------------------------------------------------------ join / leave

  async join(userId: string, communityId: string): Promise<MembershipStateResponse> {
    const community = await this.access.findActiveById(communityId);
    if (community.ownerUserId === userId) {
      return { communityId, status: 'active', role: 'owner' };
    }
    // A block in either direction with the owner: the community is simply
    // not there for this user.
    await this.visibility.assertNotBlocked(userId, community.ownerUserId);

    return this.serialised(communityId, userId, async (tx) => {
      const rows = await this.rowsFor(tx, communityId, userId);
      const active = rows.find((r) => r.status === 'active');
      if (active) {
        return { communityId, status: 'active', role: active.role as CommunityRole };
      }
      const pending = rows.find((r) => r.status === 'pending');
      if (pending) {
        return { communityId, status: 'pending', role: 'member' as CommunityRole };
      }
      if (rows.some((r) => r.status === 'banned')) {
        throw new ForbiddenActionException();
      }

      const now = new Date();
      switch (community.membershipPolicy) {
        case 'open':
          await tx.communityMembership.create({ data: { communityId, userId, status: 'active', role: 'member', approvedAt: now } });
          return { communityId, status: 'active', role: 'member' as CommunityRole };
        case 'approval_required':
          await tx.communityMembership.create({ data: { communityId, userId, status: 'pending', role: 'member' } });
          return { communityId, status: 'pending', role: 'member' as CommunityRole };
        default:
          // invite_only (invitations are a later task) or any unknown value:
          // fail closed.
          throw new PolicyRejectedException('This community is invite-only.');
      }
    });
  }

  async leave(userId: string, communityId: string): Promise<{ communityId: string; status: 'left' }> {
    const community = await this.access.findActiveById(communityId);
    if (community.ownerUserId === userId) {
      throw new PolicyRejectedException('The owner cannot leave a community; delete it instead.');
    }
    return this.serialised(communityId, userId, async (tx) => {
      const rows = await this.rowsFor(tx, communityId, userId);
      const current = rows.filter((r) => r.status === 'active' || r.status === 'pending');
      if (current.length > 0) {
        await tx.communityMembership.updateMany({
          where: { id: { in: current.map((r) => r.id) } },
          data: { status: 'left', leftAt: new Date() },
        });
        return { communityId, status: 'left' as const };
      }
      // Already left: repeating is a no-op. Anything else (rejected, removed,
      // banned, never joined) is not something the caller can leave.
      if (rows[0]?.status === 'left') {
        return { communityId, status: 'left' as const };
      }
      throw new ResourceNotFoundException();
    });
  }

  // ------------------------------------------------- approval flow (staff)

  private async requireStaff(community: Community, userId: string): Promise<ViewerRelation> {
    const relation = await this.access.viewerRelation(community, userId);
    if (!this.access.isStaff(relation)) {
      throw new ForbiddenActionException();
    }
    return relation;
  }

  async approve(actorId: string, communityId: string, targetUserId: string) {
    const community = await this.access.findActiveById(communityId);
    await this.requireStaff(community, actorId);
    return this.serialised(communityId, targetUserId, async (tx) => {
      const rows = await this.rowsFor(tx, communityId, targetUserId);
      const pending = rows.find((r) => r.status === 'pending');
      if (pending) {
        const row = await tx.communityMembership.update({
          where: { id: pending.id },
          data: { status: 'active', approvedAt: new Date(), approvedBy: actorId },
        });
        return { communityId, userId: targetUserId, status: 'active', role: row.role };
      }
      const active = rows.find((r) => r.status === 'active');
      if (active) {
        return { communityId, userId: targetUserId, status: 'active', role: active.role };
      }
      throw new ResourceNotFoundException();
    });
  }

  async reject(actorId: string, communityId: string, targetUserId: string) {
    const community = await this.access.findActiveById(communityId);
    await this.requireStaff(community, actorId);
    return this.serialised(communityId, targetUserId, async (tx) => {
      const rows = await this.rowsFor(tx, communityId, targetUserId);
      const pending = rows.find((r) => r.status === 'pending');
      if (pending) {
        const row = await tx.communityMembership.update({ where: { id: pending.id }, data: { status: 'rejected' } });
        return { communityId, userId: targetUserId, status: 'rejected', role: row.role };
      }
      if (rows[0]?.status === 'rejected') {
        return { communityId, userId: targetUserId, status: 'rejected', role: rows[0].role };
      }
      throw new ResourceNotFoundException();
    });
  }

  // ------------------------------------------------------ remove / set role

  async remove(actorId: string, communityId: string, targetUserId: string) {
    const community = await this.access.findActiveById(communityId);
    const actor = await this.requireStaff(community, actorId);
    // The owner cannot be removed, and nobody removes themselves here
    // (leaving is DELETE .../membership).
    if (targetUserId === community.ownerUserId || targetUserId === actorId) {
      throw new PolicyRejectedException('This member cannot be removed.');
    }
    return this.serialised(communityId, targetUserId, async (tx) => {
      const rows = await this.rowsFor(tx, communityId, targetUserId);
      const active = rows.find((r) => r.status === 'active');
      if (active) {
        // A moderator removes plain members only; moderators are the owner's to remove.
        if (active.role === 'moderator' && actor.role !== 'owner') {
          throw new ForbiddenActionException();
        }
        await tx.communityMembership.update({ where: { id: active.id }, data: { status: 'removed', removedAt: new Date() } });
        return { communityId, userId: targetUserId, status: 'removed' };
      }
      if (rows[0]?.status === 'removed') {
        return { communityId, userId: targetUserId, status: 'removed' };
      }
      throw new ResourceNotFoundException();
    });
  }

  async setRole(actorId: string, communityId: string, targetUserId: string, role: 'member' | 'moderator') {
    const community = await this.access.findActiveById(communityId);
    if (community.ownerUserId !== actorId) {
      throw new ForbiddenActionException();
    }
    if (targetUserId === community.ownerUserId) {
      throw new PolicyRejectedException("The owner's role cannot be changed.");
    }
    return this.serialised(communityId, targetUserId, async (tx) => {
      const rows = await this.rowsFor(tx, communityId, targetUserId);
      const active = rows.find((r) => r.status === 'active');
      if (!active) {
        throw new ResourceNotFoundException();
      }
      if (active.role !== role) {
        await tx.communityMembership.update({ where: { id: active.id }, data: { role } });
      }
      return { communityId, userId: targetUserId, role };
    });
  }

  // ------------------------------------------------------------ members list

  async listMembers(viewerId: string, communityId: string, query: ListMembersQueryDto) {
    const community = await this.access.findActiveById(communityId);
    const relation = await this.access.viewerRelation(community, viewerId);
    const status = query.status ?? 'active';

    if (status === 'pending') {
      if (!this.access.isStaff(relation)) {
        throw new ForbiddenActionException();
      }
    } else if (community.visibility === 'private' && !this.access.isMember(relation)) {
      throw new ForbiddenActionException();
    }

    const take = clampLimit(query.limit);
    const decoded = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !decoded) {
      throw new InvalidCursorException();
    }

    const blocked = await this.visibility.blockedUserIds(viewerId);
    const rows = (await this.prisma.communityMembership.findMany({
      where: {
        communityId,
        status,
        user: { status: 'active', deletedAt: null },
        ...(blocked.length > 0 && { userId: { notIn: blocked } }),
        // Oldest first, so "after the cursor" means later rows.
        ...(decoded && {
          OR: [{ createdAt: { gt: decoded.createdAt } }, { createdAt: decoded.createdAt, id: { gt: decoded.id } }],
        }),
      },
      include: {
        user: { select: { handle: true, status: true, deletedAt: true, profile: { select: { displayName: true, visibility: true } } } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: take + 1,
    })) as MemberRow[];

    const page = toPage(rows, take);
    return { data: page.data.map((m) => this.toMember(m)), nextCursor: page.nextCursor, hasMore: page.hasMore };
  }

  // Name and handle are shown only for a public profile (a user with no
  // profile row yet counts as public, but then has no display name): the
  // same rule as notification actors.
  private toMember(m: MemberRow): MemberResponse {
    const isPublic = (m.user.profile?.visibility ?? 'public') === 'public';
    return {
      userId: m.userId,
      handle: isPublic ? m.user.handle : null,
      displayName: isPublic ? (m.user.profile?.displayName ?? null) : null,
      role: m.role,
      status: m.status,
      joinedAt: m.approvedAt,
      requestedAt: m.requestedAt,
    };
  }
}
