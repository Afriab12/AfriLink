import { Body, Controller, Delete, HttpCode, Param, Put, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ReactionsService, type ReactionType } from './reactions.service';
import { SetReactionDto } from './dto/set-reaction.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ParseUuidPipe } from '../common/pipes/parse-uuid.pipe';

@ApiTags('Content')
@Controller()
export class ReactionsController {
  constructor(private readonly reactionsService: ReactionsService) {}

  @Put('posts/:postId/reaction')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async setPostReaction(
    @CurrentUser() user: { sub: string },
    @Param('postId', ParseUuidPipe) postId: string,
    @Body() dto: SetReactionDto,
  ): Promise<{ data: { type: ReactionType } }> {
    return { data: await this.reactionsService.setPostReaction(user.sub, postId, dto.type) };
  }

  @Delete('posts/:postId/reaction')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async removePostReaction(
    @CurrentUser() user: { sub: string },
    @Param('postId', ParseUuidPipe) postId: string,
  ): Promise<{ data: { type: null } }> {
    await this.reactionsService.removePostReaction(user.sub, postId);
    return { data: { type: null } };
  }

  @Put('comments/:commentId/reaction')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async setCommentReaction(
    @CurrentUser() user: { sub: string },
    @Param('commentId', ParseUuidPipe) commentId: string,
    @Body() dto: SetReactionDto,
  ): Promise<{ data: { type: ReactionType } }> {
    return { data: await this.reactionsService.setCommentReaction(user.sub, commentId, dto.type) };
  }

  @Delete('comments/:commentId/reaction')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async removeCommentReaction(
    @CurrentUser() user: { sub: string },
    @Param('commentId', ParseUuidPipe) commentId: string,
  ): Promise<{ data: { type: null } }> {
    await this.reactionsService.removeCommentReaction(user.sub, commentId);
    return { data: { type: null } };
  }
}
