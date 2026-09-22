import { Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { Community, CommunityMembership, CommunityMembershipStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { ResourceNotFoundException } from '../common/errors/api-exception';
import { SLUG_PATTERN } from './communities.constants';

export type CommunityRole = 'owner' | 'moderator' | 'member';

// What the caller is to a community: `role` is set only for the owner and
// active members; `membershipStatus` is the caller's current membership
// state (null when they never had one).
export interface ViewerRelation {
  role: CommunityRole | null;
  membershipStatus: CommunityMembershipStatus | 'active' | null;
}

export const NO_RELATION: ViewerRelation = { role: null, membershipStatus: null };

const asRole = (role: string): CommunityRole => (role === 'moderator' ? 'moderator' : 'member');

// Shared by the Communities module and the Content module (posting in a
// community, and the read/participation rules for community posts) so
// "who may do what in a community" is defined once.
@Injectable()
export class CommunityAccessService {
  constructor(private readonly prisma: PrismaService) {}

  // Same 404 for "does not exist", "deleted" and "not active": never say
  // why a community is unreachable (api.md §6).
  async findActiveById(id: string): Promise<Community> {
    const community = await this.prisma.community.findFirst({ where: { id, deletedAt: null, status: 'active' } });
    if (!community) {
      throw new ResourceNotFoundException();
    }
    return community;
  }

  // A UUID is an id; anything else is a slug (case-insensitive). Input that
  // cannot be a slug is a 404 without touching the database.
  async findActiveByIdOrSlug(idOrSlug: string): Promise<Community> {
    if (isUUID(idOrSlug)) {
      return this.findActiveById(idOrSlug);
    }
    const slug = idOrSlug.toLowerCase();
    if (!SLUG_PATTERN.test(slug) || slug.length > 40) {
      throw new ResourceNotFoundException();
    }
    const community = await this.prisma.community.findFirst({ where: { slug, deletedAt: null, status: 'active' } });
    if (!community) {
      throw new ResourceNotFoundException();
    }
    return community;
  }

  // The owner is implicit. Otherwise an active membership gives its role;
  // any other state gives no role and reports the status: pending, then the
  // most recent row.
  async viewerRelation(community: Pick<Community, 'id' | 'ownerUserId'>, userId: string | undefined): Promise<ViewerRelation> {
    if (!userId) {
      return NO_RELATION;
    }
    if (community.ownerUserId === userId) {
      return { role: 'owner', membershipStatus: 'active' };
    }
    const rows = await this.prisma.communityMembership.findMany({ where: { communityId: community.id, userId } });
    return this.relationFromRows(rows);
  }

  // One query for a whole page of communities (discovery), not one per row.
  async viewerRelations(communities: Array<Pick<Community, 'id' | 'ownerUserId'>>, userId: string | undefined): Promise<Map<string, ViewerRelation>> {
    const result = new Map<string, ViewerRelation>();
    if (!userId || communities.length === 0) {
      return result;
    }
    const rows = await this.prisma.communityMembership.findMany({
      where: { userId, communityId: { in: communities.map((c) => c.id) } },
    });
    const byCommunity = new Map<string, CommunityMembership[]>();
    for (const row of rows) {
      byCommunity.set(row.communityId, [...(byCommunity.get(row.communityId) ?? []), row]);
    }
    for (const c of communities) {
      result.set(c.id, c.ownerUserId === userId ? { role: 'owner', membershipStatus: 'active' } : this.relationFromRows(byCommunity.get(c.id) ?? []));
    }
    return result;
  }

  private relationFromRows(rows: CommunityMembership[]): ViewerRelation {
    const active = rows.find((r) => r.status === 'active');
    if (active) {
      return { role: asRole(active.role), membershipStatus: 'active' };
    }
    const pending = rows.find((r) => r.status === 'pending');
    if (pending) {
      return { role: null, membershipStatus: 'pending' };
    }
    const latest = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    return { role: null, membershipStatus: latest?.status ?? null };
  }

  isMember(relation: ViewerRelation): boolean {
    return relation.role !== null;
  }

  // Owner and moderators run the approval flow and may remove members.
  isStaff(relation: ViewerRelation): boolean {
    return relation.role === 'owner' || relation.role === 'moderator';
  }

  async countActiveMembers(communityId: string): Promise<number> {
    // +1: the owner has no membership row but is a member.
    return (await this.prisma.communityMembership.count({ where: { communityId, status: 'active' } })) + 1;
  }
}
