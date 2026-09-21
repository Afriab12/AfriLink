import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ConversationsService, type ConversationResponse } from './conversations.service';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { PaginationQueryDto } from './dto/pagination-query.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ParseUuidPipe } from '../common/pipes/parse-uuid.pipe';

interface PageMeta {
  meta: { page: { nextCursor: string | null; hasMore: boolean } };
}

@ApiTags('Messaging')
@Controller('conversations')
@UseGuards(JwtAuthGuard)
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  @Post()
  @UseGuards(CsrfGuard)
  async create(@CurrentUser() user: { sub: string }, @Body() dto: CreateConversationDto): Promise<{ data: ConversationResponse }> {
    return { data: await this.conversationsService.createConversation(user.sub, dto) };
  }

  @Get()
  async list(
    @CurrentUser() user: { sub: string },
    @Query() query: PaginationQueryDto,
  ): Promise<{ data: ConversationResponse[] } & PageMeta> {
    const { data, nextCursor, hasMore } = await this.conversationsService.listConversations(user.sub, query.cursor, query.limit);
    return { data, meta: { page: { nextCursor, hasMore } } };
  }

  @Get(':conversationId')
  async get(
    @CurrentUser() user: { sub: string },
    @Param('conversationId', ParseUuidPipe) conversationId: string,
  ): Promise<{ data: ConversationResponse }> {
    return { data: await this.conversationsService.getConversation(user.sub, conversationId) };
  }

  @Post(':conversationId/accept')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  async accept(
    @CurrentUser() user: { sub: string },
    @Param('conversationId', ParseUuidPipe) conversationId: string,
  ): Promise<{ data: ConversationResponse }> {
    return { data: await this.conversationsService.acceptConversation(user.sub, conversationId) };
  }

  @Post(':conversationId/decline')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  async decline(
    @CurrentUser() user: { sub: string },
    @Param('conversationId', ParseUuidPipe) conversationId: string,
  ): Promise<{ data: ConversationResponse }> {
    return { data: await this.conversationsService.declineConversation(user.sub, conversationId) };
  }
}
