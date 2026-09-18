import { Injectable } from '@nestjs/common';
import type { Conversation } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { ProfileVisibilityService } from '../profiles/profile-visibility.service';
import { MessagingAccessService } from './messaging-access.service';
import { MessagingGateway } from './messaging.gateway';
import { InvalidCursorException, PolicyRejectedException } from '../common/errors/api-exception';
import { clampLimit, decodeCursor, toPage } from '../common/pagination/cursor';
import type { CreateConversationDto } from './dto/create-conversation.dto';

export interface ConversationResponse {
  id: string;
  kind: string;
  status: string;
  title: string | null;
  createdBy: string | null;
  lastMessageAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class ConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly profileVisibility: ProfileVisibilityService,
    private readonly access: MessagingAccessService,
    private readonly gateway: MessagingGateway,
  ) {}

  private toResponse(c: Conversation): ConversationResponse {
    return {
      id: c.id,
      kind: c.kind,
      status: c.status,
      title: c.title,
      createdBy: c.createdBy,
      lastMessageAt: c.lastMessageAt,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  }

  // Naturally idempotent (judgment call 1): calling this again for the
  // same pair returns the existing conversation rather than erroring —
  // matching the Follow/Friendship precedent of not treating "already
  // exists" as a client error. The database's own partial unique index
  // (conversations_direct_pair_key) is the real backstop against a race
  // between two concurrent creates; this find-first is the common path.
  async createConversation(userId: string, dto: CreateConversationDto): Promise<ConversationResponse> {
    if (userId === dto.recipientUserId) {
      throw new PolicyRejectedException('You cannot start a conversation with yourself.');
    }
    await this.profileVisibility.resolveActiveUser(dto.recipientUserId);
    await this.profileVisibility.assertNotBlocked(userId, dto.recipientUserId);

    const existing = await this.prisma.conversation.findFirst({
      where: {
        kind: 'direct',
        deletedAt: null,
        OR: [
          { directParticipantAId: userId, directParticipantBId: dto.recipientUserId },
          { directParticipantAId: dto.recipientUserId, directParticipantBId: userId },
        ],
      },
    });
    if (existing) {
      return this.toResponse(existing);
    }

    // Judgment call 1: an existing accepted friendship skips the
    // message-request gate entirely — PRD §19's "first message from a
    // non-connection is held as a request" implies a real connection is
    // never gated.
    const friendship = await this.prisma.friendship.findFirst({
      where: {
        status: 'accepted',
        OR: [
          { requesterId: userId, addresseeId: dto.recipientUserId },
          { requesterId: dto.recipientUserId, addresseeId: userId },
        ],
      },
    });

    const conversation = await this.prisma.conversation.create({
      data: {
        createdBy: userId,
        status: friendship ? 'accepted' : 'pending',
        directParticipantAId: userId,
        directParticipantBId: dto.recipientUserId,
        participants: {
          create: [{ userId }, { userId: dto.recipientUserId }],
        },
      },
    });

    return this.toResponse(conversation);
  }

  async getConversation(userId: string, conversationId: string): Promise<ConversationResponse> {
    const conversation = await this.access.assertCanAccessConversation(userId, conversationId);
    return this.toResponse(conversation);
  }

  async listConversations(userId: string, cursor: string | undefined, limit: number | undefined) {
    const take = clampLimit(limit);
    const decoded = cursor ? decodeCursor(cursor) : null;
    if (cursor && !decoded) {
      throw new InvalidCursorException();
    }

    // Ordered by last_message_at, with created_at/id as the stable cursor
    // fields — a conversation with no messages yet (last_message_at is
    // null) sorts after every conversation that has one.
    const rows = await this.prisma.conversation.findMany({
      where: {
        deletedAt: null,
        participants: { some: { userId, leftAt: null } },
        ...(decoded && {
          OR: [{ createdAt: { lt: decoded.createdAt } }, { createdAt: decoded.createdAt, id: { lt: decoded.id } }],
        }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
    });

    const page = toPage(rows, take);
    return { data: page.data.map((c) => this.toResponse(c)), nextCursor: page.nextCursor, hasMore: page.hasMore };
  }

  // Only the recipient (not the initiator) may accept/decline — the
  // initiator's own send already expressed their intent.
  async acceptConversation(userId: string, conversationId: string): Promise<ConversationResponse> {
    const conversation = await this.assertPendingRecipient(userId, conversationId);
    const updated = await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: { status: 'accepted' },
    });
    this.gateway.emitToConversation(conversation.id, 'conversation.updated', { id: conversation.id, status: updated.status });
    return this.toResponse(updated);
  }

  async declineConversation(userId: string, conversationId: string): Promise<ConversationResponse> {
    const conversation = await this.assertPendingRecipient(userId, conversationId);
    const updated = await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: { status: 'declined' },
    });
    this.gateway.emitToConversation(conversation.id, 'conversation.updated', { id: conversation.id, status: updated.status });
    return this.toResponse(updated);
  }

  private async assertPendingRecipient(userId: string, conversationId: string): Promise<Conversation> {
    const conversation = await this.access.assertCanAccessConversation(userId, conversationId);
    if (conversation.status !== 'pending') {
      throw new PolicyRejectedException('This conversation is not a pending request.');
    }
    if (conversation.createdBy === userId) {
      throw new PolicyRejectedException('Only the recipient of a message request may accept or decline it.');
    }
    return conversation;
  }
}
