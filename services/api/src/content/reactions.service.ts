import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { PostAccessService } from './post-access.service';
import { ResourceNotFoundException } from '../common/errors/api-exception';

type ReactionType = 'like' | 'love' | 'laugh' | 'support' | 'insightful';

@Injectable()
export class ReactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly postAccess: PostAccessService,
  ) {}

  // ADR-003 §6: exactly one row ever exists per (user, post) — the
  // composite primary key itself enforces this, so "add" and "change" are
  // the same upsert operation, never a second row.
  async setPostReaction(userId: string, postId: string, type: ReactionType): Promise<{ type: ReactionType }> {
    await this.postAccess.resolveViewablePost(userId, postId);
    const reaction = await this.prisma.postReaction.upsert({
      where: { userId_postId: { userId, postId } },
      update: { reactionType: type, deletedAt: null },
      create: { userId, postId, reactionType: type },
    });
    return { type: reaction.reactionType as ReactionType };
  }

  async removePostReaction(userId: string, postId: string): Promise<void> {
    await this.prisma.postReaction.updateMany({
      where: { userId, postId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
  }

  async setCommentReaction(userId: string, commentId: string, type: ReactionType): Promise<{ type: ReactionType }> {
    const comment = await this.prisma.comment.findUnique({ where: { id: commentId } });
    if (!comment || comment.deletedAt) {
      throw new ResourceNotFoundException();
    }
    await this.postAccess.resolveViewablePost(userId, comment.postId);

    const reaction = await this.prisma.commentReaction.upsert({
      where: { userId_commentId: { userId, commentId } },
      update: { reactionType: type, deletedAt: null },
      create: { userId, commentId, reactionType: type },
    });
    return { type: reaction.reactionType as ReactionType };
  }

  async removeCommentReaction(userId: string, commentId: string): Promise<void> {
    await this.prisma.commentReaction.updateMany({
      where: { userId, commentId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
  }
}
