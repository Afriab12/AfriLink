import { Injectable } from '@nestjs/common';
import type { Post } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { ProfileVisibilityService } from '../profiles/profile-visibility.service';
import { PostAccessService } from './post-access.service';
import { CommunityAccessService } from '../communities/community-access.service';
import {
  ForbiddenActionException,
  InvalidCursorException,
  PolicyRejectedException,
  ResourceNotFoundException,
  ValidationFailedException,
} from '../common/errors/api-exception';
import { clampLimit, decodeCursor, toPage } from '../common/pagination/cursor';
import type { CreatePostDto } from './dto/create-post.dto';
import type { UpdatePostDto } from './dto/update-post.dto';

export interface PostResponse {
  id: string;
  authorId: string;
  body: string;
  status: string;
  visibility: string;
  communityId: string | null;
  languageCode: string;
  publishedAt: Date | null;
  editedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  reactionCounts?: Record<string, number>;
  viewerReaction?: string | null;
}

@Injectable()
export class PostsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly profileVisibility: ProfileVisibilityService,
    private readonly postAccess: PostAccessService,
    private readonly communities: CommunityAccessService,
  ) {}

  // mediaIds are never accepted or serialized — posts are text-only for now
  // (api.md §16 finding 3).
  private toResponse(post: Post): PostResponse {
    return {
      id: post.id,
      authorId: post.authorId,
      body: post.body,
      status: post.status,
      visibility: post.visibility,
      communityId: post.communityId,
      languageCode: post.languageCode,
      publishedAt: post.publishedAt,
      editedAt: post.editedAt,
      createdAt: post.createdAt,
      updatedAt: post.updatedAt,
    };
  }

  // Inside a community a post is community_members (default) or, in a
  // public community, public. Outside one, community_members has no
  // meaning. (followers/private only make sense on a personal post.)
  private assertVisibilityFits(visibility: string, community: { visibility: string } | null): void {
    if (!community) {
      if (visibility === 'community_members') {
        throw new ValidationFailedException([{ field: 'visibility', reason: 'community_members requires a communityId' }]);
      }
      return;
    }
    if (visibility !== 'public' && visibility !== 'community_members') {
      throw new ValidationFailedException([{ field: 'visibility', reason: 'a community post must be public or community_members' }]);
    }
    if (visibility === 'public' && community.visibility === 'private') {
      throw new PolicyRejectedException('A private community only allows posts for its members.');
    }
  }

  async createPost(authorId: string, dto: CreatePostDto): Promise<PostResponse> {
    let visibility = dto.visibility ?? 'public';
    if (dto.communityId) {
      const community = await this.communities.findActiveById(dto.communityId);
      if (!this.communities.isMember(await this.communities.viewerRelation(community, authorId))) {
        throw new ForbiddenActionException();
      }
      visibility = dto.visibility ?? 'community_members';
      this.assertVisibilityFits(visibility, community);
    } else {
      this.assertVisibilityFits(visibility, null);
    }

    const post = await this.prisma.post.create({
      data: {
        authorId,
        communityId: dto.communityId,
        body: dto.body,
        visibility,
        languageCode: dto.language ?? 'en',
        status: 'published',
        publishedAt: new Date(),
      },
    });
    return this.toResponse(post);
  }

  // Only the single-post GET is enriched with reaction counts/the
  // viewer's own reaction — list endpoints deliberately stay lean to
  // avoid an N+1 groupBy per row (api.md §16's own N+1 caution).
  async getPost(viewerId: string | undefined, postId: string): Promise<PostResponse> {
    const post = await this.postAccess.resolveViewablePost(viewerId, postId);
    const response = this.toResponse(post);

    const groups = await this.prisma.postReaction.groupBy({
      by: ['reactionType'],
      where: { postId, deletedAt: null },
      _count: true,
    });
    response.reactionCounts = Object.fromEntries(groups.map((g) => [g.reactionType, g._count]));

    if (viewerId) {
      const own = await this.prisma.postReaction.findUnique({
        where: { userId_postId: { userId: viewerId, postId } },
      });
      response.viewerReaction = own && !own.deletedAt ? own.reactionType : null;
    }

    return response;
  }

  async updatePost(userId: string, postId: string, dto: UpdatePostDto): Promise<PostResponse> {
    const existing = await this.postAccess.assertOwnsPost(userId, postId);
    if (dto.visibility !== undefined) {
      const community = existing.communityId ? await this.communities.findActiveById(existing.communityId) : null;
      this.assertVisibilityFits(dto.visibility, community);
    }
    const post = await this.prisma.post.update({
      where: { id: postId },
      data: {
        ...(dto.body !== undefined && { body: dto.body, editedAt: new Date() }),
        ...(dto.visibility !== undefined && { visibility: dto.visibility }),
      },
    });
    return this.toResponse(post);
  }

  async deletePost(userId: string, postId: string): Promise<void> {
    await this.postAccess.assertOwnsPost(userId, postId);
    await this.prisma.post.update({ where: { id: postId }, data: { deletedAt: new Date() } });
  }

  async listPostsByUser(viewerId: string | undefined, targetUserId: string, cursor: string | undefined, limit: number | undefined) {
    const target = await this.prisma.user.findUnique({ where: { id: targetUserId } });
    if (!target || target.status !== 'active' || target.deletedAt) {
      throw new ResourceNotFoundException();
    }
    await this.profileVisibility.assertNotBlocked(viewerId, targetUserId);

    // Each post has its own visibility, independent of the author's
    // profile visibility — a public-profile user can still post something
    // 'private' or 'followers'-only. Compute which levels this viewer is
    // entitled to see for THIS author, once, then push it into the query.
    const isSelf = viewerId === targetUserId;
    let allowedVisibilities: string[];
    if (isSelf) {
      allowedVisibilities = ['public', 'followers', 'private'];
    } else {
      const isFollower = viewerId
        ? await this.prisma.follow.findFirst({ where: { followerId: viewerId, followeeId: targetUserId, deletedAt: null } })
        : null;
      allowedVisibilities = isFollower ? ['public', 'followers'] : ['public'];
    }

    const take = clampLimit(limit);
    const decoded = cursor ? decodeCursor(cursor) : null;
    if (cursor && !decoded) {
      throw new InvalidCursorException();
    }

    const rows = await this.prisma.post.findMany({
      where: {
        authorId: targetUserId,
        // Community posts belong to their community's audience, never to the
        // author's profile.
        communityId: null,
        deletedAt: null,
        status: 'published',
        visibility: { in: allowedVisibilities },
        ...(decoded && {
          OR: [{ createdAt: { lt: decoded.createdAt } }, { createdAt: decoded.createdAt, id: { lt: decoded.id } }],
        }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
    });

    const page = toPage(rows, take);
    return { data: page.data.map((p) => this.toResponse(p)), nextCursor: page.nextCursor, hasMore: page.hasMore };
  }

  // A community's own feed of posts. Private community: anonymous callers get
  // the same 404 as a community that does not exist, a signed-in non-member
  // a 403 (they can see the community's preview). Members and the owner see
  // public and members-only posts; everyone else only the public ones of a
  // public community.
  async listCommunityPosts(viewerId: string | undefined, communityId: string, cursor: string | undefined, limit: number | undefined) {
    const community = await this.communities.findActiveById(communityId);
    const relation = await this.communities.viewerRelation(community, viewerId);
    const member = this.communities.isMember(relation);
    if (community.visibility === 'private' && !member) {
      if (!viewerId) {
        throw new ResourceNotFoundException();
      }
      throw new ForbiddenActionException();
    }

    const take = clampLimit(limit);
    const decoded = cursor ? decodeCursor(cursor) : null;
    if (cursor && !decoded) {
      throw new InvalidCursorException();
    }

    const blocked = viewerId ? await this.profileVisibility.blockedUserIds(viewerId) : [];
    const rows = await this.prisma.post.findMany({
      where: {
        communityId,
        deletedAt: null,
        status: 'published',
        visibility: { in: member ? ['public', 'community_members'] : ['public'] },
        author: { status: 'active', deletedAt: null },
        ...(blocked.length > 0 && { authorId: { notIn: blocked } }),
        ...(decoded && {
          OR: [{ createdAt: { lt: decoded.createdAt } }, { createdAt: decoded.createdAt, id: { lt: decoded.id } }],
        }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
    });

    const page = toPage(rows, take);
    return { data: page.data.map((p) => this.toResponse(p)), nextCursor: page.nextCursor, hasMore: page.hasMore };
  }
}
