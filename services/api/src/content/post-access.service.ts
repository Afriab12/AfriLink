import { Injectable } from '@nestjs/common';
import type { Post, User } from '@prisma/client';
import type { ProfileVisibility } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { ProfileVisibilityService } from '../profiles/profile-visibility.service';
import { ResourceNotFoundException } from '../common/errors/api-exception';

export type ViewablePost = Post & { author: User };

// Shared by posts/comments/reactions/shares services — every one of them
// needs "can this viewer see/interact with this post" as a first check
// (comments/reactions/shares are only ever as visible as their parent
// post). Reuses ProfileVisibilityService rather than re-implementing the
// public/followers/private rule a second time: content.posts.visibility
// uses the identical three values as social.profiles.visibility, so the
// same self/block/follow logic applies unchanged.
@Injectable()
export class PostAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly visibility: ProfileVisibilityService,
  ) {}

  async resolveViewablePost(viewerId: string | undefined, postId: string): Promise<ViewablePost> {
    const post = await this.prisma.post.findUnique({ where: { id: postId }, include: { author: true } });

    if (
      !post ||
      post.deletedAt ||
      post.status !== 'published' ||
      post.author.status !== 'active' ||
      post.author.deletedAt
    ) {
      throw new ResourceNotFoundException();
    }

    await this.visibility.assertNotBlocked(viewerId, post.authorId);
    await this.visibility.assertCanViewProfile(viewerId, {
      id: post.authorId,
      profile: { visibility: post.visibility as ProfileVisibility },
    });

    return post;
  }

  // Non-throwing variant for filtering a list of posts/shares in memory
  // (e.g. shares, where each row can reference a different post/author —
  // pushing the whole rule into one SQL WHERE isn't practical since
  // "followers of THIS specific author" varies per row).
  async canViewPost(viewerId: string | undefined, post: Post & { author: User }): Promise<boolean> {
    if (post.deletedAt || post.status !== 'published' || post.author.status !== 'active' || post.author.deletedAt) {
      return false;
    }
    // Anonymous viewers have no block relationships to check, same as
    // assertNotBlocked's own no-op-when-anonymous behavior.
    if (viewerId && (await this.visibility.isBlocked(viewerId, post.authorId))) {
      return false;
    }
    return this.visibility.canViewProfile(viewerId, {
      id: post.authorId,
      profile: { visibility: post.visibility as ProfileVisibility },
    });
  }

  async assertOwnsPost(userId: string, postId: string): Promise<Post> {
    const post = await this.prisma.post.findUnique({ where: { id: postId } });
    if (!post || post.deletedAt || post.authorId !== userId) {
      throw new ResourceNotFoundException();
    }
    return post;
  }
}
