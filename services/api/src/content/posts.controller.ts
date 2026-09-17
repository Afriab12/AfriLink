import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { PostsService } from './posts.service';
import { CreatePostDto } from './dto/create-post.dto';
import { UpdatePostDto } from './dto/update-post.dto';
import { PaginationQueryDto } from './dto/pagination-query.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../common/guards/optional-jwt-auth.guard';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { OptionalCurrentUser } from '../common/decorators/optional-current-user.decorator';

@Controller()
export class PostsController {
  constructor(private readonly postsService: PostsService) {}

  @Post('posts')
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async create(@CurrentUser() user: { sub: string }, @Body() dto: CreatePostDto) {
    return { data: await this.postsService.createPost(user.sub, dto) };
  }

  @Get('posts/:postId')
  @UseGuards(OptionalJwtAuthGuard)
  async get(@OptionalCurrentUser() viewer: { sub: string } | undefined, @Param('postId') postId: string) {
    return { data: await this.postsService.getPost(viewer?.sub, postId) };
  }

  @Patch('posts/:postId')
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async update(@CurrentUser() user: { sub: string }, @Param('postId') postId: string, @Body() dto: UpdatePostDto) {
    return { data: await this.postsService.updatePost(user.sub, postId, dto) };
  }

  @Delete('posts/:postId')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async remove(@CurrentUser() user: { sub: string }, @Param('postId') postId: string) {
    await this.postsService.deletePost(user.sub, postId);
    return { data: { deleted: true } };
  }

  @Get('users/:userId/posts')
  @UseGuards(OptionalJwtAuthGuard)
  async listByUser(
    @OptionalCurrentUser() viewer: { sub: string } | undefined,
    @Param('userId') userId: string,
    @Query() query: PaginationQueryDto,
  ) {
    const { data, nextCursor, hasMore } = await this.postsService.listPostsByUser(viewer?.sub, userId, query.cursor, query.limit);
    return { data, meta: { page: { nextCursor, hasMore } } };
  }
}
