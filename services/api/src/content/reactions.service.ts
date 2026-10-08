import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { PostAccessService } from './post-access.service';
import { ResourceNotFoundException } from '../common/errors/api-exception';
import { NotificationsService, type RecordNotificationInput } from '../notifications/notifications.service';
import { ProfileVisibilityService } from '../profiles/profile-visibility.service';

export type ReactionType = 'like' | 'love' | 'laugh' | 'support' | 'insightful';

@Injectable()
export class ReactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly postAccess: PostAccessService,
    private readonly notifications: NotificationsService,
    private readonly visibility: ProfileVisibilityService,
  ) {}

  private async recordBestEffortNotification(input: RecordNotificationInput): Promise<void> {
    try {
      if (
        input.actorUserId !== null &&
        input.actorUserId !== input.recipientUserId &&
        (await this.visibility.isBlocked(input.actorUserId, input.recipientUserId))
      ) {
        return;
      }
      await this.notifications.record(input);
    } catch {
      console.warn(`[notifications] best-effort notification "${input.type}" failed to record`);
    }
  }

  // ADR-003 §6: exactly one row ever exists per (user, post) — the
  // composite primary key itself enforces this, so "add" and "change" are
  // the same upsert operation, never a second row.
  async setPostReaction(userId: string, postId: string, type: ReactionType): Promise<{ type: ReactionType }> {
    const post = await this.postAccess.resolveInteractablePost(userId, postId);
    const reaction = await this.prisma.postReaction.upsert({
      where: { userId_postId: { userId, postId } },
      update: { reactionType: type, deletedAt: null },
      create: { userId, postId, reactionType: type },
    });
    await this.recordBestEffortNotification({
      type: 'post_reaction',
      recipientUserId: post.authorId,
      actorUserId: userId,
      targetType: 'post',
      targetId: postId,
      dedupKey: `post_reaction:${postId}:${userId}`,
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
    await this.postAccess.resolveInteractablePost(userId, comment.postId);

    const reaction = await this.prisma.commentReaction.upsert({
      where: { userId_commentId: { userId, commentId } },
      update: { reactionType: type, deletedAt: null },
      create: { userId, commentId, reactionType: type },
    });
    await this.recordBestEffortNotification({
      type: 'comment_reaction',
      recipientUserId: comment.authorId,
      actorUserId: userId,
      targetType: 'comment',
      targetId: commentId,
      dedupKey: `comment_reaction:${commentId}:${userId}`,
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
