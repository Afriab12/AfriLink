import { Injectable } from '@nestjs/common';
import type { Conversation, Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { ProfileVisibilityService } from '../profiles/profile-visibility.service';
import { MessagingAccessService } from './messaging-access.service';
import { MessagingGateway } from './messaging.gateway';
import { InvalidCursorException, PolicyRejectedException } from '../common/errors/api-exception';
import { clampLimit } from '../common/pagination/cursor';
import type { CreateConversationDto } from './dto/create-conversation.dto';

// Opaque cursor for the conversation list: the (last_message_at, id) sort key
// of the last row returned. last_message_at is null for a conversation with no
// messages yet. Same base64url-JSON convention as common/pagination/cursor.ts,
// different shape — a createdAt-shaped cursor does not decode here.
interface ConversationCursor {
  lastMessageAt: Date | null;
  id: string;
}

function encodeConversationCursor(row: { lastMessageAt: Date | null; id: string }): string {
  return Buffer.from(
    JSON.stringify({ lastMessageAt: row.lastMessageAt ? row.lastMessageAt.toISOString() : null, id: row.id }),
  ).toString('base64url');
}

// Returns null on any malformed input; the caller turns that into INVALID_CURSOR.
function decodeConversationCursor(cursor: string): ConversationCursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const { lastMessageAt, id } = parsed as { lastMessageAt?: unknown; id?: unknown };
    if (typeof id !== 'string') {
      return null;
    }
    if (lastMessageAt === null) {
      return { lastMessageAt: null, id };
    }
    if (typeof lastMessageAt !== 'string') {
      return null; // also rejects a legacy { createdAt, id } cursor (no lastMessageAt key)
    }
    const at = new Date(lastMessageAt);
    return Number.isNaN(at.getTime()) ? null : { lastMessageAt: at, id };
  } catch {
    return null;
  }
}

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

  // Inbox order: most recent message first (last_message_at DESC), then id
  // DESC as the tie-breaker (UUIDv7, so time-ordered). A conversation with no
  // messages yet has no last_message_at and sorts AFTER every conversation
  // that has one (NULLS LAST), among themselves newest-created first.
  //
  // The cursor is the same (last_message_at, id) key, not the (createdAt, id)
  // shape used by the other lists — last_message_at is nullable, so the
  // keyset condition has two branches (see below). Cursors from the earlier
  // createdAt-ordered version of this endpoint fail to decode and are
  // rejected as INVALID_CURSOR.
  //
  // last_message_at only ever moves forward (MessagesService), so a
  // conversation can move UP between page fetches (new activity) but never
  // down — no row is returned twice while paging; one that jumps to the top
  // mid-scroll is simply seen on the next refresh.
  async listConversations(userId: string, cursor: string | undefined, limit: number | undefined) {
    const take = clampLimit(limit);
    const decoded = cursor ? decodeConversationCursor(cursor) : null;
    if (cursor && !decoded) {
      throw new InvalidCursorException();
    }

    let after: Prisma.ConversationWhereInput | undefined;
    if (decoded?.lastMessageAt) {
      // Cursor row had a message: continue with older/equal-then-smaller-id
      // rows, then every conversation without messages (they come last).
      after = {
        OR: [
          { lastMessageAt: { lt: decoded.lastMessageAt } },
          { lastMessageAt: decoded.lastMessageAt, id: { lt: decoded.id } },
          { lastMessageAt: null },
        ],
      };
    } else if (decoded) {
      // Cursor row had no message: only other message-less rows remain.
      after = { lastMessageAt: null, id: { lt: decoded.id } };
    }

    const rows = await this.prisma.conversation.findMany({
      where: {
        deletedAt: null,
        participants: { some: { userId, leftAt: null } },
        ...after,
      },
      orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
      take: take + 1,
    });

    const hasMore = rows.length > take;
    const pageRows = hasMore ? rows.slice(0, take) : rows;
    const last = pageRows[pageRows.length - 1];
    return {
      data: pageRows.map((c) => this.toResponse(c)),
      nextCursor: hasMore && last ? encodeConversationCursor(last) : null,
      hasMore,
    };
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
