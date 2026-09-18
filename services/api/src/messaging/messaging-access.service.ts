import { Injectable } from '@nestjs/common';
import type { Conversation } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { ProfileVisibilityService } from '../profiles/profile-visibility.service';
import { ResourceNotFoundException } from '../common/errors/api-exception';

// Single source of truth for "can this user act on this conversation" —
// consumed identically by ConversationsService/MessagesService (REST) and
// MessagingGateway (WS). ADR-006 §5/§10: never duplicate this rule
// between the two transports. Mirrors the PostAccessService/
// ProfileVisibilityService pattern already established for Content and
// Social Graph.
@Injectable()
export class MessagingAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly visibility: ProfileVisibilityService,
  ) {}

  // Throws 404 (non-enumerating — matches the rest of the codebase: never
  // distinguish "doesn't exist" from "you can't see it") unless the user
  // has an active participant row and isn't blocked by the other
  // participant.
  async assertCanAccessConversation(userId: string, conversationId: string): Promise<Conversation> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { participants: true },
    });

    if (!conversation || conversation.deletedAt) {
      throw new ResourceNotFoundException();
    }

    const mine = conversation.participants.find((p) => p.userId === userId && p.leftAt === null);
    if (!mine) {
      throw new ResourceNotFoundException();
    }

    for (const other of conversation.participants) {
      if (other.userId !== userId && (await this.visibility.isBlocked(userId, other.userId))) {
        throw new ResourceNotFoundException();
      }
    }

    return conversation;
  }

  // Non-throwing variant — the WS gateway's join handler needs to emit a
  // typed `error` event rather than let an exception propagate as an
  // unhandled rejection (see MessagingGateway.handleJoin).
  async canAccessConversation(userId: string, conversationId: string): Promise<boolean> {
    try {
      await this.assertCanAccessConversation(userId, conversationId);
      return true;
    } catch {
      return false;
    }
  }
}
