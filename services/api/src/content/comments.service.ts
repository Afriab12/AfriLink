import { Injectable } from '@nestjs/common';
import type { Comment } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { PostAccessService } from './post-access.service';
import { InvalidCursorException, ResourceNotFoundException } from '../common/errors/api-exception';
import { clampLimit, decodeCursor, toPage } from '../common/pagination/cursor';
import type { CreateCommentDto } from './dto/create-comment.dto';
import type { UpdateCommentDto } from './dto/update-comment.dto';

export interface CommentResponse {
  id: string;
  postId: string;
  authorId: string;
  parentCommentId: string | null;
  body: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class CommentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly postAccess: PostAccessService,
  ) {}

  private toResponse(comment: Comment): CommentResponse {
    return {
      id: comment.id,
      postId: comment.postId,
      authorId: comment.authorId,
      parentCommentId: comment.parentCommentId,
      body: comment.body,
      status: comment.status,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
    };
  }

  async createComment(authorId: string, postId: string, dto: CreateCommentDto): Promise<CommentResponse> {
    // Must be able to view the post to comment on it — interaction never
    // exceeds visibility (same rule applied consistently across the
    // social-graph module).
    await this.postAccess.resolveInteractablePost(authorId, postId);

    if (dto.parentCommentId) {
      const parent = await this.prisma.comment.findUnique({ where: { id: dto.parentCommentId } });
      if (!parent || parent.deletedAt || parent.postId !== postId) {
        throw new ResourceNotFoundException();
      }
    }

    const comment = await this.prisma.comment.create({
      data: { postId, authorId, body: dto.body, parentCommentId: dto.parentCommentId, status: 'published' },
    });
    return this.toResponse(comment);
  }

  async listTopLevelComments(
    viewerId: string | undefined,
    postId: string,
    cursor: string | undefined,
    limit: number | undefined,
  ) {
    await this.postAccess.resolveViewablePost(viewerId, postId);
    return this.listComments({ postId, parentCommentId: null }, cursor, limit);
  }

  async listReplies(viewerId: string | undefined, commentId: string, cursor: string | undefined, limit: number | undefined) {
    const parent = await this.prisma.comment.findUnique({ where: { id: commentId } });
    if (!parent || parent.deletedAt) {
      throw new ResourceNotFoundException();
    }
    await this.postAccess.resolveViewablePost(viewerId, parent.postId);
    return this.listComments({ parentCommentId: commentId }, cursor, limit);
  }

  private async listComments(
    where: { postId?: string; parentCommentId: string | null },
    cursor: string | undefined,
    limit: number | undefined,
  ) {
    const take = clampLimit(limit);
    const decoded = cursor ? decodeCursor(cursor) : null;
    if (cursor && !decoded) {
      throw new InvalidCursorException();
    }

    const rows = await this.prisma.comment.findMany({
      where: {
        ...where,
        deletedAt: null,
        status: 'published',
        ...(decoded && {
          // Ascending order (oldest first, database.md's comment index
          // design) — "next page" means rows AFTER the cursor, unlike
          // posts/shares which page backward through descending time.
          OR: [{ createdAt: { gt: decoded.createdAt } }, { createdAt: decoded.createdAt, id: { gt: decoded.id } }],
        }),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: take + 1,
    });

    const page = toPage(rows, take);
    return { data: page.data.map((c) => this.toResponse(c)), nextCursor: page.nextCursor, hasMore: page.hasMore };
  }

  async updateComment(userId: string, commentId: string, dto: UpdateCommentDto): Promise<CommentResponse> {
    const comment = await this.prisma.comment.findUnique({ where: { id: commentId } });
    if (!comment || comment.deletedAt || comment.authorId !== userId) {
      throw new ResourceNotFoundException();
    }
    const updated = await this.prisma.comment.update({ where: { id: commentId }, data: { body: dto.body } });
    return this.toResponse(updated);
  }

  async deleteComment(userId: string, commentId: string): Promise<void> {
    const comment = await this.prisma.comment.findUnique({ where: { id: commentId } });
    if (!comment || comment.deletedAt || comment.authorId !== userId) {
      throw new ResourceNotFoundException();
    }
    await this.prisma.comment.update({ where: { id: commentId }, data: { deletedAt: new Date() } });
  }
}
