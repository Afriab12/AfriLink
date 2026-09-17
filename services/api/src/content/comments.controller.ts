import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { CommentsService } from './comments.service';
import { CreateCommentDto } from './dto/create-comment.dto';
import { UpdateCommentDto } from './dto/update-comment.dto';
import { PaginationQueryDto } from './dto/pagination-query.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../common/guards/optional-jwt-auth.guard';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { OptionalCurrentUser } from '../common/decorators/optional-current-user.decorator';

@Controller()
export class CommentsController {
  constructor(private readonly commentsService: CommentsService) {}

  @Post('posts/:postId/comments')
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async create(@CurrentUser() user: { sub: string }, @Param('postId') postId: string, @Body() dto: CreateCommentDto) {
    return { data: await this.commentsService.createComment(user.sub, postId, dto) };
  }

  @Get('posts/:postId/comments')
  @UseGuards(OptionalJwtAuthGuard)
  async listTopLevel(
    @OptionalCurrentUser() viewer: { sub: string } | undefined,
    @Param('postId') postId: string,
    @Query() query: PaginationQueryDto,
  ) {
    const { data, nextCursor, hasMore } = await this.commentsService.listTopLevelComments(viewer?.sub, postId, query.cursor, query.limit);
    return { data, meta: { page: { nextCursor, hasMore } } };
  }

  @Get('comments/:commentId/replies')
  @UseGuards(OptionalJwtAuthGuard)
  async listReplies(
    @OptionalCurrentUser() viewer: { sub: string } | undefined,
    @Param('commentId') commentId: string,
    @Query() query: PaginationQueryDto,
  ) {
    const { data, nextCursor, hasMore } = await this.commentsService.listReplies(viewer?.sub, commentId, query.cursor, query.limit);
    return { data, meta: { page: { nextCursor, hasMore } } };
  }

  @Patch('comments/:commentId')
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async update(@CurrentUser() user: { sub: string }, @Param('commentId') commentId: string, @Body() dto: UpdateCommentDto) {
    return { data: await this.commentsService.updateComment(user.sub, commentId, dto) };
  }

  @Delete('comments/:commentId')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async remove(@CurrentUser() user: { sub: string }, @Param('commentId') commentId: string) {
    await this.commentsService.deleteComment(user.sub, commentId);
    return { data: { deleted: true } };
  }
}
