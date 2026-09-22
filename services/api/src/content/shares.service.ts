import { Injectable } from '@nestjs/common';
import type { Share, Post, User } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { ProfileVisibilityService } from '../profiles/profile-visibility.service';
import { PostAccessService } from './post-access.service';
import { InvalidCursorException, ResourceNotFoundException } from '../common/errors/api-exception';
import { clampLimit, decodeCursor, toPage } from '../common/pagination/cursor';
import type { CreateShareDto } from './dto/create-share.dto';

export interface ShareResponse {
  id: string;
  userId: string;
  postId: string;
  comment: string | null;
  createdAt: Date;
}

@Injectable()
export class SharesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly profileVisibility: ProfileVisibilityService,
    private readonly postAccess: PostAccessService,
  ) {}

  private toResponse(share: Share): ShareResponse {
    return { id: share.id, userId: share.userId, postId: share.postId, comment: share.comment, createdAt: share.createdAt };
  }

  // No uniqueness constraint on (userId, postId) in the approved schema
  // (database.md §6/schema.prisma) — sharing the same post more than
  // once is deliberately allowed, each creating a new row. Not inventing
  // an application-level restriction the database doesn't have.
  async createShare(userId: string, postId: string, dto: CreateShareDto): Promise<ShareResponse> {
    await this.postAccess.resolveInteractablePost(userId, postId);
    const share = await this.prisma.share.create({ data: { userId, postId, comment: dto.comment } });
    return this.toResponse(share);
  }

  async deleteShare(userId: string, shareId: string): Promise<void> {
    const share = await this.prisma.share.findUnique({ where: { id: shareId } });
    if (!share || share.deletedAt || share.userId !== userId) {
      throw new ResourceNotFoundException();
    }
    await this.prisma.share.update({ where: { id: shareId }, data: { deletedAt: new Date() } });
  }

  // Each share can reference a different post/author, so — unlike
  // listPostsByUser — the visibility rule can't be fully pushed into one
  // SQL WHERE; filtered in memory over a bounded (<=50 row) page via
  // PostAccessService.canViewPost. Per database.md §6: a share's
  // visibility is re-evaluated against the *current* source post at read
  // time, never frozen at share time — a page can come back shorter than
  // `limit` if some shared posts are no longer visible to this viewer.
  async listSharesByUser(
    viewerId: string | undefined,
    targetUserId: string,
    cursor: string | undefined,
    limit: number | undefined,
  ) {
    const target = await this.prisma.user.findUnique({ where: { id: targetUserId } });
    if (!target || target.status !== 'active' || target.deletedAt) {
      throw new ResourceNotFoundException();
    }
    await this.profileVisibility.assertNotBlocked(viewerId, targetUserId);

    const take = clampLimit(limit);
    const decoded = cursor ? decodeCursor(cursor) : null;
    if (cursor && !decoded) {
      throw new InvalidCursorException();
    }

    const rows = await this.prisma.share.findMany({
      where: {
        userId: targetUserId,
        deletedAt: null,
        ...(decoded && {
          OR: [{ createdAt: { lt: decoded.createdAt } }, { createdAt: decoded.createdAt, id: { lt: decoded.id } }],
        }),
      },
      include: { post: { include: { author: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
    });

    const page = toPage(rows, take);
    const visible: Share[] = [];
    for (const row of page.data) {
      const post = row.post as Post & { author: User };
      if (await this.postAccess.canViewPost(viewerId, post)) {
        visible.push(row);
      }
    }

    return { data: visible.map((s) => this.toResponse(s)), nextCursor: page.nextCursor, hasMore: page.hasMore };
  }
}
