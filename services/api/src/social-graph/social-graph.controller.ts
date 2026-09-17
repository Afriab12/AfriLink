import { Controller, Delete, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { SocialGraphService } from './social-graph.service';
import { ListFriendRequestsQueryDto } from './dto/list-friend-requests.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../common/guards/optional-jwt-auth.guard';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { OptionalCurrentUser } from '../common/decorators/optional-current-user.decorator';

@Controller()
export class SocialGraphController {
  constructor(private readonly socialGraphService: SocialGraphService) {}

  // ---- Follows ----

  @Post('users/:userId/follow')
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async follow(@CurrentUser() user: { sub: string }, @Param('userId') userId: string) {
    return { data: await this.socialGraphService.follow(user.sub, userId) };
  }

  @Delete('users/:userId/follow')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async unfollow(@CurrentUser() user: { sub: string }, @Param('userId') userId: string) {
    return { data: await this.socialGraphService.unfollow(user.sub, userId) };
  }

  @Get('users/:userId/followers')
  @UseGuards(OptionalJwtAuthGuard)
  async followers(@OptionalCurrentUser() viewer: { sub: string } | undefined, @Param('userId') userId: string) {
    return { data: await this.socialGraphService.listFollowers(viewer?.sub, userId) };
  }

  @Get('users/:userId/following')
  @UseGuards(OptionalJwtAuthGuard)
  async following(@OptionalCurrentUser() viewer: { sub: string } | undefined, @Param('userId') userId: string) {
    return { data: await this.socialGraphService.listFollowing(viewer?.sub, userId) };
  }

  // ---- Friendships ----

  @Post('users/:userId/friend-requests')
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async sendFriendRequest(@CurrentUser() user: { sub: string }, @Param('userId') userId: string) {
    return { data: await this.socialGraphService.sendFriendRequest(user.sub, userId) };
  }

  @Get('me/friend-requests')
  @UseGuards(JwtAuthGuard)
  async listFriendRequests(@CurrentUser() user: { sub: string }, @Query() query: ListFriendRequestsQueryDto) {
    return { data: await this.socialGraphService.listFriendRequests(user.sub, query.direction) };
  }

  @Post('friend-requests/:friendshipId/accept')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async acceptFriendRequest(@CurrentUser() user: { sub: string }, @Param('friendshipId') friendshipId: string) {
    return { data: await this.socialGraphService.acceptFriendRequest(user.sub, friendshipId) };
  }

  @Post('friend-requests/:friendshipId/decline')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async declineFriendRequest(@CurrentUser() user: { sub: string }, @Param('friendshipId') friendshipId: string) {
    return { data: await this.socialGraphService.declineFriendRequest(user.sub, friendshipId) };
  }

  @Delete('friend-requests/:friendshipId')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async cancelFriendRequest(@CurrentUser() user: { sub: string }, @Param('friendshipId') friendshipId: string) {
    await this.socialGraphService.cancelFriendRequest(user.sub, friendshipId);
    return { data: { cancelled: true } };
  }

  @Delete('friendships/:friendshipId')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async removeFriendship(@CurrentUser() user: { sub: string }, @Param('friendshipId') friendshipId: string) {
    await this.socialGraphService.removeFriendship(user.sub, friendshipId);
    return { data: { removed: true } };
  }

  @Get('users/:userId/friends')
  @UseGuards(OptionalJwtAuthGuard)
  async friends(@OptionalCurrentUser() viewer: { sub: string } | undefined, @Param('userId') userId: string) {
    return { data: await this.socialGraphService.listFriends(viewer?.sub, userId) };
  }

  // ---- Blocks ----

  @Post('users/:userId/block')
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async block(@CurrentUser() user: { sub: string }, @Param('userId') userId: string) {
    return { data: await this.socialGraphService.block(user.sub, userId) };
  }

  @Delete('users/:userId/block')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async unblock(@CurrentUser() user: { sub: string }, @Param('userId') userId: string) {
    return { data: await this.socialGraphService.unblock(user.sub, userId) };
  }

  @Get('me/blocks')
  @UseGuards(JwtAuthGuard)
  async blocks(@CurrentUser() user: { sub: string }) {
    return { data: await this.socialGraphService.listBlocks(user.sub) };
  }
}
