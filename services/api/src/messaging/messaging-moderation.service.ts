import { Injectable } from '@nestjs/common';
import type { MessageModerationState, Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';

// The cross-module surface docs/05-api/moderation.md §7 names as
// "Moderation → Messaging": applyMessageModerationStatus executes
// remove_content/restrict_content against a message, resolveMessageOwnerId
// is the privileged lookup Moderation's appeal affected-party check needs.
// Never routed — reachable only via MessagingModule's export + Nest DI (same
// boundary ContentModerationService/PostAccessService/MediaAccessService
// already rely on), so there is no request path for an ordinary user to hit
// these directly.
//
// Conversation-level moderation is out of scope: Conversation has no
// moderationState column yet (docs/04-database/moderation.md §17b proposes
// adding one, not yet reviewed/applied) — mirrors Content's Share/§17a gap.
//
// The "message removed by moderator" placeholder UX and any moderation
// WebSocket event are explicitly deferred to a separate, independently
// reviewed increment (docs/05-api/moderation.md §4's decided requirement,
// not fulfilled by this service alone) — this service only writes
// moderationState and resolves ownership.
@Injectable()
export class MessagingModerationService {
  constructor(private readonly prisma: PrismaService) {}

  // Sets Message.moderationState directly — never touches deletedAt, which
  // is the user's own soft-delete axis, kept independent of moderation
  // state by design (mirrors Content's ContentStatus/deletedAt split).
  // Accepts an optional transaction client so the caller (the future
  // Moderation action-creation flow) can commit this alongside its own
  // Action/Sanction inserts atomically. Throws (propagating Prisma's own
  // P2025) if messageId doesn't resolve — a caller that has already
  // validated the target moments earlier via resolveMessageOwnerId should
  // never legitimately hit this.
  async applyMessageModerationStatus(messageId: string, state: MessageModerationState, tx?: Prisma.TransactionClient): Promise<void> {
    const client = tx ?? this.prisma;
    await client.message.update({ where: { id: messageId }, data: { moderationState: state } });
  }

  // No filtering at all — not moderationState, not deletedAt, not
  // MessagingAccessService, not conversation membership, not sender account
  // status. Returns only senderId, never the message body. Returns null
  // rather than throwing: the caller distinguishes "target doesn't exist"
  // from "caller isn't the affected party" and needs to pick its own
  // exception for each.
  async resolveMessageOwnerId(messageId: string): Promise<string | null> {
    const message = await this.prisma.message.findUnique({ where: { id: messageId }, select: { senderId: true } });
    return message?.senderId ?? null;
  }
}
