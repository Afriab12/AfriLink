import { Injectable } from '@nestjs/common';
import type { Community, Post, User } from '@prisma/client';
import type { ProfileVisibility } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { ProfileVisibilityService } from '../profiles/profile-visibility.service';
import { CommunityAccessService } from '../communities/community-access.service';
import { ForbiddenActionException, ResourceNotFoundException } from '../common/errors/api-exception';

export type ViewablePost = Post & { author: User };

// Shared by posts/comments/reactions/shares services — every one of them
// needs "can this viewer see/interact with this post" as a first check
// (comments/reactions/shares are only ever as visible as their parent
// post). Reuses ProfileVisibilityService rather than re-implementing the
// public/followers/private rule a second time: content.posts.visibility
// uses the identical three values as social.profiles.visibility, so the
// same self/block/follow logic applies unchanged.
//
// A post in a community is different: its audience is not the author's
// followers but the community's, and it is the MORE RESTRICTIVE of the
// post's own visibility and the community's, evaluated now (not when the
// post was written), so a community that turns private never leaks.
@Injectable()
export class PostAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly visibility: ProfileVisibilityService,
    private readonly communities: CommunityAccessService,
  ) {}

  // Community posts only. Returns the community when the post is readable in
  // it by this viewer, null when it is not (community gone, or the viewer is
  // outside the audience). `member` is whether the viewer is the owner or an
  // active member.
  private async communityAudience(
    viewerId: string | undefined,
    post: Pick<Post, 'communityId' | 'visibility'>,
  ): Promise<{ community: Community; member: boolean } | null> {
    const community = await this.prisma.community.findFirst({
      where: { id: post.communityId!, deletedAt: null, status: 'active' },
    });
    if (!community) {
      return null;
    }
    const member = this.communities.isMember(await this.communities.viewerRelation(community, viewerId));
    // Open to everyone only when BOTH the post and the community are public;
    // every other combination (including an unrecognised visibility) is
    // members-only.
    const open = post.visibility === 'public' && community.visibility === 'public';
    return open || member ? { community, member } : null;
  }

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

    if (post.communityId) {
      if (!(await this.communityAudience(viewerId, post))) {
        throw new ResourceNotFoundException();
      }
      return post;
    }

    await this.visibility.assertCanViewProfile(viewerId, {
      id: post.authorId,
      profile: { visibility: post.visibility as ProfileVisibility },
    });

    return post;
  }

  // Reading a post is not the same as taking part in it: commenting,
  // reacting and sharing on a community post need active membership, even
  // when the post is public. Otherwise a banned or removed member could
  // simply carry on through the visibility rule. Withdrawing a reaction or
  // deleting one's own comment is deliberately not gated.
  async resolveInteractablePost(userId: string, postId: string): Promise<ViewablePost> {
    const post = await this.resolveViewablePost(userId, postId);
    if (post.communityId) {
      const audience = await this.communityAudience(userId, post);
      if (!audience?.member) {
        throw new ForbiddenActionException();
      }
    }
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
    if (post.communityId) {
      return (await this.communityAudience(viewerId, post)) !== null;
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
