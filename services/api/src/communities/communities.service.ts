import { Injectable } from '@nestjs/common';
import { Prisma, type Community } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { CommunityAccessService, NO_RELATION, type ViewerRelation } from './community-access.service';
import {
  AuthenticationRequiredException,
  ConflictException,
  ForbiddenActionException,
  InvalidCursorException,
  ResourceNotFoundException,
} from '../common/errors/api-exception';
import { clampLimit, decodeCursor, toPage } from '../common/pagination/cursor';
import type { CreateCommunityDto } from './dto/create-community.dto';
import type { UpdateCommunityDto } from './dto/update-community.dto';
import type { ListCommunitiesQueryDto } from './dto/list-communities-query.dto';

export interface CommunityResponse {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  rules: string | null;
  visibility: string;
  membershipPolicy: string;
  // true when a signed-in non-member is looking at a private community:
  // they get what they need to decide to ask to join, and nothing that
  // reveals its size, owner or activity (those fields are null).
  isPreview: boolean;
  memberCount: number | null;
  owner: { userId: string } | null;
  viewer: ViewerRelation;
  createdAt: Date | null;
  updatedAt: Date | null;
}

@Injectable()
export class CommunitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: CommunityAccessService,
  ) {}

  private toResponse(c: Community, viewer: ViewerRelation, memberCount: number): CommunityResponse {
    const isPreview = c.visibility === 'private' && !this.access.isMember(viewer);
    return {
      id: c.id,
      slug: c.slug,
      name: c.name,
      description: c.description,
      rules: c.rules,
      visibility: c.visibility,
      membershipPolicy: c.membershipPolicy,
      isPreview,
      memberCount: isPreview ? null : memberCount,
      owner: isPreview ? null : { userId: c.ownerUserId },
      viewer,
      createdAt: isPreview ? null : c.createdAt,
      updatedAt: isPreview ? null : c.updatedAt,
    };
  }

  async create(userId: string, dto: CreateCommunityDto): Promise<CommunityResponse> {
    try {
      const c = await this.prisma.community.create({
        data: {
          ownerUserId: userId,
          slug: dto.slug,
          name: dto.name,
          description: dto.description,
          rules: dto.rules,
          visibility: dto.visibility ?? 'public',
          membershipPolicy: dto.membershipPolicy ?? 'open',
        },
      });
      return this.toResponse(c, { role: 'owner', membershipStatus: 'active' }, 1);
    } catch (error) {
      // The unique index on the active slug is the arbiter, so two racing
      // creates cannot both win.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('DUPLICATE_ACTION', 'A community with this slug already exists.');
      }
      throw error;
    }
  }

  async get(viewerId: string | undefined, idOrSlug: string): Promise<CommunityResponse> {
    const c = await this.access.findActiveByIdOrSlug(idOrSlug);
    const viewer = await this.access.viewerRelation(c, viewerId);
    // Private and no relationship: anonymous callers get the same 404 as a
    // community that does not exist; a signed-in user gets the preview.
    if (c.visibility === 'private' && !this.access.isMember(viewer) && !viewerId) {
      throw new ResourceNotFoundException();
    }
    return this.toResponse(c, viewer, await this.access.countActiveMembers(c.id));
  }

  async list(viewerId: string | undefined, query: ListCommunitiesQueryDto) {
    const mine = query.mine === 'true';
    if (mine && !viewerId) {
      throw new AuthenticationRequiredException();
    }
    const take = clampLimit(query.limit);
    const decoded = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !decoded) {
      throw new InvalidCursorException();
    }

    // Discovery shows public communities only; `mine` also shows the private
    // ones the caller owns or is an active member of.
    //
    // `mine` is two steps on purpose. Written as one query
    // (`owner_user_id = me OR EXISTS (membership ...)`), Postgres cannot use
    // an index for the OR and reads nearly every active community: measured
    // at about 0.6-1.4 s with 300k communities. Fetching the caller's
    // community ids first (an index-only read of their own memberships) lets
    // both sides of the OR use an index (primary key, owner_user_id): about
    // 3-7 ms on the same data. The list is bounded by how many communities
    // one person belongs to, well inside a bind-parameter limit at MVP scale.
    const memberOf = mine ? await this.memberCommunityIds(viewerId!) : [];

    const where: Prisma.CommunityWhereInput = {
      deletedAt: null,
      status: 'active',
      ...(mine ? { OR: [{ ownerUserId: viewerId }, { id: { in: memberOf } }] } : { visibility: 'public' }),
      ...(decoded && {
        AND: [{ OR: [{ createdAt: { lt: decoded.createdAt } }, { createdAt: decoded.createdAt, id: { lt: decoded.id } }] }],
      }),
    };

    const rows = await this.prisma.community.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
    });
    const page = toPage(rows, take);

    // Two grouped/batched queries for the whole page, never one per row.
    const [relations, counts] = await Promise.all([
      this.access.viewerRelations(page.data, viewerId),
      this.prisma.communityMembership.groupBy({
        by: ['communityId'],
        where: { communityId: { in: page.data.map((c) => c.id) }, status: 'active' },
        _count: { _all: true },
      }),
    ]);
    const countById = new Map(counts.map((g) => [g.communityId, g._count._all]));

    return {
      data: page.data.map((c) => this.toResponse(c, relations.get(c.id) ?? NO_RELATION, (countById.get(c.id) ?? 0) + 1)),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    };
  }

  // Ids of the communities this user is an active member of (the owner is
  // covered separately, by owner_user_id).
  private async memberCommunityIds(userId: string): Promise<string[]> {
    const rows = await this.prisma.communityMembership.findMany({
      where: { userId, status: 'active' },
      select: { communityId: true },
    });
    return rows.map((r) => r.communityId);
  }

  async update(userId: string, communityId: string, dto: UpdateCommunityDto): Promise<CommunityResponse> {
    const c = await this.access.findActiveById(communityId);
    this.assertOwner(c, userId);
    const updated = await this.prisma.community.update({
      where: { id: communityId },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.rules !== undefined && { rules: dto.rules }),
        ...(dto.visibility !== undefined && { visibility: dto.visibility }),
        ...(dto.membershipPolicy !== undefined && { membershipPolicy: dto.membershipPolicy }),
      },
    });
    return this.toResponse(updated, { role: 'owner', membershipStatus: 'active' }, await this.access.countActiveMembers(communityId));
  }

  // Soft delete: the row and its memberships stay (audit, and posts keep
  // pointing at it); every read treats a deleted community as absent.
  async remove(userId: string, communityId: string): Promise<void> {
    const c = await this.access.findActiveById(communityId);
    this.assertOwner(c, userId);
    await this.prisma.community.update({ where: { id: communityId }, data: { deletedAt: new Date() } });
  }

  private assertOwner(c: Community, userId: string): void {
    if (c.ownerUserId !== userId) {
      throw new ForbiddenActionException();
    }
  }
}
