import { Injectable } from '@nestjs/common';
import type { Message } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { MessagingAccessService } from './messaging-access.service';
import { MessagingGateway } from './messaging.gateway';
import { InvalidCursorException, PolicyRejectedException, ResourceNotFoundException } from '../common/errors/api-exception';
import { clampLimit, decodeCursor, toPage } from '../common/pagination/cursor';
import type { SendMessageDto } from './dto/send-message.dto';
import type { UpdateMessageDto } from './dto/update-message.dto';
import type { MarkReadDto } from './dto/mark-read.dto';

export interface MessageResponse {
  id: string;
  conversationId: string;
  senderId: string;
  clientMessageId: string;
  body: string;
  status: string;
  replyToMessageId: string | null;
  createdAt: Date;
  editedAt: Date | null;
}

@Injectable()
export class MessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: MessagingAccessService,
    private readonly gateway: MessagingGateway,
  ) {}

  private toResponse(m: Message): MessageResponse {
    return {
      id: m.id,
      conversationId: m.conversationId,
      senderId: m.senderId,
      clientMessageId: m.clientMessageId,
      body: m.body,
      status: m.status,
      replyToMessageId: m.replyToMessageId,
      createdAt: m.createdAt,
      editedAt: m.editedAt,
    };
  }

  // Judgment call 1: while a conversation is still 'pending', only its
  // initiator (conversation.createdBy) may send — the recipient must
  // explicitly accept first (ConversationsService.acceptConversation).
  // 'declined' blocks sending entirely for both parties.
  async sendMessage(userId: string, conversationId: string, dto: SendMessageDto): Promise<MessageResponse> {
    const conversation = await this.access.assertCanAccessConversation(userId, conversationId);

    if (conversation.status === 'declined') {
      throw new PolicyRejectedException('This conversation request was declined.');
    }
    if (conversation.status === 'pending' && conversation.createdBy !== userId) {
      throw new PolicyRejectedException('Accept this conversation request before replying.');
    }

    // (sender_id, client_message_id) is unique in the database — a
    // retried send with the same key returns the original row rather
    // than erroring, matching database.md §9's "makes mobile retries
    // safe" intent.
    const existing = await this.prisma.message.findUnique({
      where: { senderId_clientMessageId: { senderId: userId, clientMessageId: dto.clientMessageId } },
    });
    if (existing) {
      return this.toResponse(existing);
    }

    const message = await this.prisma.message.create({
      data: {
        conversationId,
        senderId: userId,
        clientMessageId: dto.clientMessageId,
        body: dto.body,
      },
    });
    await this.prisma.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: message.createdAt } });

    const response = this.toResponse(message);
    this.gateway.emitToConversation(conversationId, 'message.accepted', response);
    return response;
  }

  async listMessages(userId: string, conversationId: string, cursor: string | undefined, limit: number | undefined) {
    await this.access.assertCanAccessConversation(userId, conversationId);

    const take = clampLimit(limit);
    const decoded = cursor ? decodeCursor(cursor) : null;
    if (cursor && !decoded) {
      throw new InvalidCursorException();
    }

    const rows = await this.prisma.message.findMany({
      where: {
        conversationId,
        deletedAt: null,
        moderationState: 'active',
        ...(decoded && {
          OR: [{ createdAt: { lt: decoded.createdAt } }, { createdAt: decoded.createdAt, id: { lt: decoded.id } }],
        }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
    });

    const page = toPage(rows, take);
    return { data: page.data.map((m) => this.toResponse(m)), nextCursor: page.nextCursor, hasMore: page.hasMore };
  }

  async updateMessage(userId: string, messageId: string, dto: UpdateMessageDto): Promise<MessageResponse> {
    const message = await this.assertOwnsMessage(userId, messageId);
    const updated = await this.prisma.message.update({
      where: { id: messageId },
      data: { body: dto.body, editedAt: new Date() },
    });
    const response = this.toResponse(updated);
    this.gateway.emitToConversation(message.conversationId, 'message.updated', response);
    return response;
  }

  async deleteMessage(userId: string, messageId: string): Promise<void> {
    const message = await this.assertOwnsMessage(userId, messageId);
    const deletedAt = new Date();
    await this.prisma.message.update({ where: { id: messageId }, data: { deletedAt } });
    this.gateway.emitToConversation(message.conversationId, 'message.deleted', { id: messageId, conversationId: message.conversationId, deletedAt });
  }

  async markRead(userId: string, conversationId: string, dto: MarkReadDto): Promise<void> {
    await this.access.assertCanAccessConversation(userId, conversationId);

    const message = await this.prisma.message.findUnique({ where: { id: dto.messageId } });
    if (!message || message.conversationId !== conversationId || message.deletedAt) {
      throw new ResourceNotFoundException();
    }

    const readAt = new Date();
    await this.prisma.participant.update({
      where: { conversationId_userId: { conversationId, userId } },
      data: { lastReadMessageId: dto.messageId },
    });

    this.gateway.emitToConversation(conversationId, 'conversation.read', {
      conversationId,
      userId,
      lastReadMessageId: dto.messageId,
      readAt,
    });
  }

  // Authorship alone is not enough: a sender who has since been blocked (in
  // either direction), left, or whose conversation was deleted must not be
  // able to rewrite or erase history the other side still sees. The
  // conversation-access rule is the same one every other message action
  // uses (ADR-006 §5/§10: one rule, never duplicated per action).
  private async assertOwnsMessage(userId: string, messageId: string): Promise<Message> {
    const message = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!message || message.deletedAt || message.senderId !== userId) {
      throw new ResourceNotFoundException();
    }
    await this.access.assertCanAccessConversation(userId, message.conversationId);
    return message;
  }
}
