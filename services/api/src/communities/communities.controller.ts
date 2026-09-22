import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CommunitiesService, type CommunityResponse } from './communities.service';
import { MembershipsService } from './memberships.service';
import { CreateCommunityDto } from './dto/create-community.dto';
import { UpdateCommunityDto } from './dto/update-community.dto';
import { ListCommunitiesQueryDto } from './dto/list-communities-query.dto';
import { ListMembersQueryDto } from './dto/list-members-query.dto';
import { SetMemberRoleDto } from './dto/set-member-role.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../common/guards/optional-jwt-auth.guard';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { OptionalCurrentUser } from '../common/decorators/optional-current-user.decorator';
import { ParseUuidPipe } from '../common/pipes/parse-uuid.pipe';

interface PageMeta {
  meta: { page: { nextCursor: string | null; hasMore: boolean } };
}

type Me = { sub: string };

// Rate limiting: contract only, as everywhere else (api.md §11). The one
// limiter that exists is per IP, in memory, on the auth routes.
@ApiTags('Communities')
@Controller('communities')
export class CommunitiesController {
  constructor(
    private readonly communities: CommunitiesService,
    private readonly memberships: MembershipsService,
  ) {}

  @Post()
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async create(@CurrentUser() user: Me, @Body() dto: CreateCommunityDto): Promise<{ data: CommunityResponse }> {
    return { data: await this.communities.create(user.sub, dto) };
  }

  @Get()
  @UseGuards(OptionalJwtAuthGuard)
  async list(
    @OptionalCurrentUser() viewer: Me | undefined,
    @Query() query: ListCommunitiesQueryDto,
  ): Promise<{ data: CommunityResponse[] } & PageMeta> {
    const { data, nextCursor, hasMore } = await this.communities.list(viewer?.sub, query);
    return { data, meta: { page: { nextCursor, hasMore } } };
  }

  // Accepts a community id or a slug, so it is not a pure UUID route (it is
  // exempt from ParseUuidPipe by design; see test/path-params.e2e-spec.ts).
  @Get(':communityIdOrSlug')
  @UseGuards(OptionalJwtAuthGuard)
  async get(
    @OptionalCurrentUser() viewer: Me | undefined,
    @Param('communityIdOrSlug') idOrSlug: string,
  ): Promise<{ data: CommunityResponse }> {
    return { data: await this.communities.get(viewer?.sub, idOrSlug) };
  }

  @Patch(':communityId')
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async update(
    @CurrentUser() user: Me,
    @Param('communityId', ParseUuidPipe) communityId: string,
    @Body() dto: UpdateCommunityDto,
  ): Promise<{ data: CommunityResponse }> {
    return { data: await this.communities.update(user.sub, communityId, dto) };
  }

  @Delete(':communityId')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async remove(@CurrentUser() user: Me, @Param('communityId', ParseUuidPipe) communityId: string): Promise<{ data: { deleted: boolean } }> {
    await this.communities.remove(user.sub, communityId);
    return { data: { deleted: true } };
  }

  // -------------------------------------------------------------- membership

  @Put(':communityId/membership')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async join(@CurrentUser() user: Me, @Param('communityId', ParseUuidPipe) communityId: string) {
    return { data: await this.memberships.join(user.sub, communityId) };
  }

  @Delete(':communityId/membership')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async leave(@CurrentUser() user: Me, @Param('communityId', ParseUuidPipe) communityId: string) {
    return { data: await this.memberships.leave(user.sub, communityId) };
  }

  @Get(':communityId/members')
  @UseGuards(JwtAuthGuard)
  async listMembers(
    @CurrentUser() user: Me,
    @Param('communityId', ParseUuidPipe) communityId: string,
    @Query() query: ListMembersQueryDto,
  ) {
    const { data, nextCursor, hasMore } = await this.memberships.listMembers(user.sub, communityId, query);
    return { data, meta: { page: { nextCursor, hasMore } } };
  }

  @Post(':communityId/members/:userId/approve')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async approve(
    @CurrentUser() user: Me,
    @Param('communityId', ParseUuidPipe) communityId: string,
    @Param('userId', ParseUuidPipe) userId: string,
  ) {
    return { data: await this.memberships.approve(user.sub, communityId, userId) };
  }

  @Post(':communityId/members/:userId/reject')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async reject(
    @CurrentUser() user: Me,
    @Param('communityId', ParseUuidPipe) communityId: string,
    @Param('userId', ParseUuidPipe) userId: string,
  ) {
    return { data: await this.memberships.reject(user.sub, communityId, userId) };
  }

  @Delete(':communityId/members/:userId')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async removeMember(
    @CurrentUser() user: Me,
    @Param('communityId', ParseUuidPipe) communityId: string,
    @Param('userId', ParseUuidPipe) userId: string,
  ) {
    return { data: await this.memberships.remove(user.sub, communityId, userId) };
  }

  @Patch(':communityId/members/:userId')
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async setRole(
    @CurrentUser() user: Me,
    @Param('communityId', ParseUuidPipe) communityId: string,
    @Param('userId', ParseUuidPipe) userId: string,
    @Body() dto: SetMemberRoleDto,
  ) {
    return { data: await this.memberships.setRole(user.sub, communityId, userId, dto.role) };
  }
}
