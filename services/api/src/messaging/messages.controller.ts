import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { MessagesService, type MessageResponse } from './messages.service';
import { SendMessageDto } from './dto/send-message.dto';
import { UpdateMessageDto } from './dto/update-message.dto';
import { MarkReadDto } from './dto/mark-read.dto';
import { PaginationQueryDto } from './dto/pagination-query.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

interface PageMeta {
  meta: { page: { nextCursor: string | null; hasMore: boolean } };
}

@ApiTags('Messaging')
@Controller()
@UseGuards(JwtAuthGuard)
export class MessagesController {
  constructor(private readonly messagesService: MessagesService) {}

  @Post('conversations/:conversationId/messages')
  @UseGuards(CsrfGuard)
  async send(
    @CurrentUser() user: { sub: string },
    @Param('conversationId') conversationId: string,
    @Body() dto: SendMessageDto,
  ): Promise<{ data: MessageResponse }> {
    return { data: await this.messagesService.sendMessage(user.sub, conversationId, dto) };
  }

  @Get('conversations/:conversationId/messages')
  async list(
    @CurrentUser() user: { sub: string },
    @Param('conversationId') conversationId: string,
    @Query() query: PaginationQueryDto,
  ): Promise<{ data: MessageResponse[] } & PageMeta> {
    const { data, nextCursor, hasMore } = await this.messagesService.listMessages(user.sub, conversationId, query.cursor, query.limit);
    return { data, meta: { page: { nextCursor, hasMore } } };
  }

  @Patch('messages/:messageId')
  @UseGuards(CsrfGuard)
  async update(
    @CurrentUser() user: { sub: string },
    @Param('messageId') messageId: string,
    @Body() dto: UpdateMessageDto,
  ): Promise<{ data: MessageResponse }> {
    return { data: await this.messagesService.updateMessage(user.sub, messageId, dto) };
  }

  @Delete('messages/:messageId')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  async remove(@CurrentUser() user: { sub: string }, @Param('messageId') messageId: string): Promise<{ data: { deleted: boolean } }> {
    await this.messagesService.deleteMessage(user.sub, messageId);
    return { data: { deleted: true } };
  }

  @Post('conversations/:conversationId/read')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  async markRead(
    @CurrentUser() user: { sub: string },
    @Param('conversationId') conversationId: string,
    @Body() dto: MarkReadDto,
  ): Promise<{ data: { read: boolean } }> {
    await this.messagesService.markRead(user.sub, conversationId, dto);
    return { data: { read: true } };
  }
}
