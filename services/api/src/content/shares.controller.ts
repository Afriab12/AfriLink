import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { SharesService } from './shares.service';
import { CreateShareDto } from './dto/create-share.dto';
import { PaginationQueryDto } from './dto/pagination-query.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../common/guards/optional-jwt-auth.guard';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { OptionalCurrentUser } from '../common/decorators/optional-current-user.decorator';

@Controller()
export class SharesController {
  constructor(private readonly sharesService: SharesService) {}

  @Post('posts/:postId/shares')
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async create(@CurrentUser() user: { sub: string }, @Param('postId') postId: string, @Body() dto: CreateShareDto) {
    return { data: await this.sharesService.createShare(user.sub, postId, dto) };
  }

  @Delete('shares/:shareId')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async remove(@CurrentUser() user: { sub: string }, @Param('shareId') shareId: string) {
    await this.sharesService.deleteShare(user.sub, shareId);
    return { data: { deleted: true } };
  }

  @Get('users/:userId/shares')
  @UseGuards(OptionalJwtAuthGuard)
  async listByUser(
    @OptionalCurrentUser() viewer: { sub: string } | undefined,
    @Param('userId') userId: string,
    @Query() query: PaginationQueryDto,
  ) {
    const { data, nextCursor, hasMore } = await this.sharesService.listSharesByUser(viewer?.sub, userId, query.cursor, query.limit);
    return { data, meta: { page: { nextCursor, hasMore } } };
  }
}
