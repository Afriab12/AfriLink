import { Injectable } from '@nestjs/common';
import type { ContentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';

export type ContentModerationTargetType = 'post' | 'comment';
export type ContentOwnerTargetType = 'post' | 'comment' | 'share';

// The cross-module surface docs/05-api/moderation.md §7 names as
// "Moderation → Content": applyContentModerationStatus executes
// remove_content/restrict_content, resolveContentOwnerId is the privileged
// lookup Moderation's appeal affected-party check needs. Never routed —
// reachable only via ContentModule's export + Nest DI (same boundary
// PostAccessService/MediaAccessService already rely on), so there is no
// request path for an ordinary user to hit these directly.
//
// 'share' is deliberately excluded from applyContentModerationStatus: Share
// has no status column yet (docs/04-database/moderation.md §17a proposes
// adding one, not yet reviewed/applied). resolveContentOwnerId still covers
// 'share' — appeal-eligibility lookups need it today, independent of §17a.
@Injectable()
export class ContentModerationService {
  constructor(private readonly prisma: PrismaService) {}

  // Sets Post/Comment.status directly — never touches deletedAt, which is
  // the user's own soft-delete axis, kept independent of moderation status
  // by design. Accepts an optional transaction client so the caller (the
  // future Moderation action-creation flow) can commit this alongside its
  // own Action/Sanction inserts atomically, matching the
  // memberships.service.ts `tx`-passing pattern. Throws (propagating
  // Prisma's own P2025) if targetId doesn't resolve — a caller that has
  // already validated the target moments earlier via resolveContentOwnerId
  // should never legitimately hit this.
  async applyContentModerationStatus(
    targetType: ContentModerationTargetType,
    targetId: string,
    status: ContentStatus,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = tx ?? this.prisma;
    if (targetType === 'post') {
      await client.post.update({ where: { id: targetId }, data: { status } });
    } else {
      await client.comment.update({ where: { id: targetId }, data: { status } });
    }
  }

  // No filtering at all — not status, not deletedAt, not author account
  // status. Unlike PostAccessService.resolveViewablePost (visibility-aware,
  // throws 404 for anything not published/active), this exists precisely
  // because Moderation needs to resolve the owner of already-removed/hidden
  // content for appeal eligibility. Returns null rather than throwing: the
  // caller distinguishes "target doesn't exist" from "caller isn't the
  // affected party" and needs to pick its own exception for each.
  async resolveContentOwnerId(targetType: ContentOwnerTargetType, targetId: string): Promise<string | null> {
    if (targetType === 'post') {
      const post = await this.prisma.post.findUnique({ where: { id: targetId }, select: { authorId: true } });
      return post?.authorId ?? null;
    }
    if (targetType === 'comment') {
      const comment = await this.prisma.comment.findUnique({ where: { id: targetId }, select: { authorId: true } });
      return comment?.authorId ?? null;
    }
    const share = await this.prisma.share.findUnique({ where: { id: targetId }, select: { userId: true } });
    return share?.userId ?? null;
  }
}
