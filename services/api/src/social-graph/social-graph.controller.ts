import { Controller, Delete, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SocialGraphService, type FriendshipResponse } from './social-graph.service';
import { ListFriendRequestsQueryDto } from './dto/list-friend-requests.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../common/guards/optional-jwt-auth.guard';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { OptionalCurrentUser } from '../common/decorators/optional-current-user.decorator';
import { ParseUuidPipe } from '../common/pipes/parse-uuid.pipe';

type ListFollowersResult = Awaited<ReturnType<SocialGraphService['listFollowers']>>;
type ListFollowingResult = Awaited<ReturnType<SocialGraphService['listFollowing']>>;
type ListFriendsResult = Awaited<ReturnType<SocialGraphService['listFriends']>>;
type ListBlocksResult = Awaited<ReturnType<SocialGraphService['listBlocks']>>;

@ApiTags('Social Graph')
@Controller()
export class SocialGraphController {
  constructor(private readonly socialGraphService: SocialGraphService) {}

  // ---- Follows ----

  @Post('users/:userId/follow')
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async follow(@CurrentUser() user: { sub: string }, @Param('userId', ParseUuidPipe) userId: string): Promise<{ data: { following: boolean } }> {
    return { data: await this.socialGraphService.follow(user.sub, userId) };
  }

  @Delete('users/:userId/follow')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async unfollow(@CurrentUser() user: { sub: string }, @Param('userId', ParseUuidPipe) userId: string): Promise<{ data: { following: boolean } }> {
    return { data: await this.socialGraphService.unfollow(user.sub, userId) };
  }

  @Get('users/:userId/followers')
  @UseGuards(OptionalJwtAuthGuard)
  async followers(
    @OptionalCurrentUser() viewer: { sub: string } | undefined,
    @Param('userId', ParseUuidPipe) userId: string,
  ): Promise<{ data: ListFollowersResult }> {
    return { data: await this.socialGraphService.listFollowers(viewer?.sub, userId) };
  }

  @Get('users/:userId/following')
  @UseGuards(OptionalJwtAuthGuard)
  async following(
    @OptionalCurrentUser() viewer: { sub: string } | undefined,
    @Param('userId', ParseUuidPipe) userId: string,
  ): Promise<{ data: ListFollowingResult }> {
    return { data: await this.socialGraphService.listFollowing(viewer?.sub, userId) };
  }

  // ---- Friendships ----

  @Post('users/:userId/friend-requests')
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async sendFriendRequest(
    @CurrentUser() user: { sub: string },
    @Param('userId', ParseUuidPipe) userId: string,
  ): Promise<{ data: FriendshipResponse }> {
    return { data: await this.socialGraphService.sendFriendRequest(user.sub, userId) };
  }

  @Get('me/friend-requests')
  @UseGuards(JwtAuthGuard)
  async listFriendRequests(
    @CurrentUser() user: { sub: string },
    @Query() query: ListFriendRequestsQueryDto,
  ): Promise<{ data: FriendshipResponse[] }> {
    return { data: await this.socialGraphService.listFriendRequests(user.sub, query.direction) };
  }

  @Post('friend-requests/:friendshipId/accept')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async acceptFriendRequest(
    @CurrentUser() user: { sub: string },
    @Param('friendshipId', ParseUuidPipe) friendshipId: string,
  ): Promise<{ data: FriendshipResponse }> {
    return { data: await this.socialGraphService.acceptFriendRequest(user.sub, friendshipId) };
  }

  @Post('friend-requests/:friendshipId/decline')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async declineFriendRequest(
    @CurrentUser() user: { sub: string },
    @Param('friendshipId', ParseUuidPipe) friendshipId: string,
  ): Promise<{ data: FriendshipResponse }> {
    return { data: await this.socialGraphService.declineFriendRequest(user.sub, friendshipId) };
  }

  @Delete('friend-requests/:friendshipId')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async cancelFriendRequest(
    @CurrentUser() user: { sub: string },
    @Param('friendshipId', ParseUuidPipe) friendshipId: string,
  ): Promise<{ data: { cancelled: boolean } }> {
    await this.socialGraphService.cancelFriendRequest(user.sub, friendshipId);
    return { data: { cancelled: true } };
  }

  @Delete('friendships/:friendshipId')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async removeFriendship(
    @CurrentUser() user: { sub: string },
    @Param('friendshipId', ParseUuidPipe) friendshipId: string,
  ): Promise<{ data: { removed: boolean } }> {
    await this.socialGraphService.removeFriendship(user.sub, friendshipId);
    return { data: { removed: true } };
  }

  @Get('users/:userId/friends')
  @UseGuards(OptionalJwtAuthGuard)
  async friends(
    @OptionalCurrentUser() viewer: { sub: string } | undefined,
    @Param('userId', ParseUuidPipe) userId: string,
  ): Promise<{ data: ListFriendsResult }> {
    return { data: await this.socialGraphService.listFriends(viewer?.sub, userId) };
  }

  // ---- Blocks ----

  @Post('users/:userId/block')
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async block(@CurrentUser() user: { sub: string }, @Param('userId', ParseUuidPipe) userId: string): Promise<{ data: { blocked: boolean } }> {
    return { data: await this.socialGraphService.block(user.sub, userId) };
  }

  @Delete('users/:userId/block')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async unblock(@CurrentUser() user: { sub: string }, @Param('userId', ParseUuidPipe) userId: string): Promise<{ data: { blocked: boolean } }> {
    return { data: await this.socialGraphService.unblock(user.sub, userId) };
  }

  @Get('me/blocks')
  @UseGuards(JwtAuthGuard)
  async blocks(@CurrentUser() user: { sub: string }): Promise<{ data: ListBlocksResult }> {
    return { data: await this.socialGraphService.listBlocks(user.sub) };
  }
}
