import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../common/prisma/prisma.service';
import { MessagingModerationService } from './messaging-moderation.service';

// Unit-level (no HTTP layer, direct PrismaService instantiation — same
// pattern as content-moderation.service.spec.ts): MessagingModerationService
// is the cross-module surface Moderation will call (docs/05-api/moderation.md
// §7) — applyMessageModerationStatus to execute remove_content/
// restrict_content against a message, resolveMessageOwnerId as the
// privileged, visibility/deletion-agnostic lookup appeal eligibility needs.
// Not yet consumed by any module (Moderation doesn't exist yet) — built and
// tested in isolation now so it is correct before anything depends on it.
describe('MessagingModerationService', () => {
  let prisma: PrismaService;
  let service: MessagingModerationService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new MessagingModerationService(prisma);
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  async function makeUser(overrides: Partial<{ status: string }> = {}) {
    return prisma.user.create({ data: { status: (overrides.status as never) ?? 'active', updatedAt: new Date() } });
  }

  async function makeConversation() {
    const a = await makeUser();
    const b = await makeUser();
    return prisma.conversation.create({ data: { directParticipantAId: a.id, directParticipantBId: b.id } });
  }

  async function makeMessage(
    conversationId: string,
    senderId: string,
    overrides: Partial<{ moderationState: string; deletedAt: Date }> = {},
  ) {
    return prisma.message.create({
      data: {
        conversationId,
        senderId,
        clientMessageId: randomUUID(),
        body: 'test message',
        moderationState: (overrides.moderationState as never) ?? 'active',
        deletedAt: overrides.deletedAt ?? null,
      },
    });
  }

  describe('applyMessageModerationStatus', () => {
    it('moves a message from active to hidden', async () => {
      const sender = await makeUser();
      const conversation = await makeConversation();
      const message = await makeMessage(conversation.id, sender.id);
      await service.applyMessageModerationStatus(message.id, 'hidden');
      const updated = await prisma.message.findUniqueOrThrow({ where: { id: message.id } });
      expect(updated.moderationState).toBe('hidden');
    });

    it('moves a message from active to removed', async () => {
      const sender = await makeUser();
      const conversation = await makeConversation();
      const message = await makeMessage(conversation.id, sender.id);
      await service.applyMessageModerationStatus(message.id, 'removed');
      const updated = await prisma.message.findUniqueOrThrow({ where: { id: message.id } });
      expect(updated.moderationState).toBe('removed');
    });

    it('restores a hidden message back to active', async () => {
      const sender = await makeUser();
      const conversation = await makeConversation();
      const message = await makeMessage(conversation.id, sender.id, { moderationState: 'hidden' });
      await service.applyMessageModerationStatus(message.id, 'active');
      const updated = await prisma.message.findUniqueOrThrow({ where: { id: message.id } });
      expect(updated.moderationState).toBe('active');
    });

    it('restores a removed message back to active (appeal-overturned round trip)', async () => {
      const sender = await makeUser();
      const conversation = await makeConversation();
      const message = await makeMessage(conversation.id, sender.id, { moderationState: 'removed' });
      await service.applyMessageModerationStatus(message.id, 'active');
      const updated = await prisma.message.findUniqueOrThrow({ where: { id: message.id } });
      expect(updated.moderationState).toBe('active');
    });

    it("does not touch deletedAt — moderation state and a user's own soft-delete are independent axes", async () => {
      const sender = await makeUser();
      const conversation = await makeConversation();
      const message = await makeMessage(conversation.id, sender.id);
      await service.applyMessageModerationStatus(message.id, 'removed');
      const updated = await prisma.message.findUniqueOrThrow({ where: { id: message.id } });
      expect(updated.deletedAt).toBeNull();
    });

    it('throws (propagating Prisma P2025) for a nonexistent message id', async () => {
      await expect(service.applyMessageModerationStatus(randomUUID(), 'removed')).rejects.toMatchObject({ code: 'P2025' });
    });

    it('applies and commits inside a passed-in transaction', async () => {
      const sender = await makeUser();
      const conversation = await makeConversation();
      const message = await makeMessage(conversation.id, sender.id);
      await prisma.$transaction(async (tx) => {
        await service.applyMessageModerationStatus(message.id, 'removed', tx);
      });
      const updated = await prisma.message.findUniqueOrThrow({ where: { id: message.id } });
      expect(updated.moderationState).toBe('removed');
    });

    it('rolls back with the rest of the transaction when the transaction fails after the call', async () => {
      const sender = await makeUser();
      const conversation = await makeConversation();
      const message = await makeMessage(conversation.id, sender.id);
      await expect(
        prisma.$transaction(async (tx) => {
          await service.applyMessageModerationStatus(message.id, 'removed', tx);
          throw new Error('simulated failure after the status update');
        }),
      ).rejects.toThrow('simulated failure after the status update');
      const unchanged = await prisma.message.findUniqueOrThrow({ where: { id: message.id } });
      expect(unchanged.moderationState).toBe('active');
    });
  });

  describe('resolveMessageOwnerId', () => {
    it('returns senderId for an active message', async () => {
      const sender = await makeUser();
      const conversation = await makeConversation();
      const message = await makeMessage(conversation.id, sender.id);
      await expect(service.resolveMessageOwnerId(message.id)).resolves.toBe(sender.id);
    });

    it('returns senderId for a hidden message', async () => {
      const sender = await makeUser();
      const conversation = await makeConversation();
      const message = await makeMessage(conversation.id, sender.id, { moderationState: 'hidden' });
      await expect(service.resolveMessageOwnerId(message.id)).resolves.toBe(sender.id);
    });

    it('returns senderId for a removed message', async () => {
      const sender = await makeUser();
      const conversation = await makeConversation();
      const message = await makeMessage(conversation.id, sender.id, { moderationState: 'removed' });
      await expect(service.resolveMessageOwnerId(message.id)).resolves.toBe(sender.id);
    });

    it('returns senderId when deletedAt is set', async () => {
      const sender = await makeUser();
      const conversation = await makeConversation();
      const message = await makeMessage(conversation.id, sender.id, { deletedAt: new Date() });
      await expect(service.resolveMessageOwnerId(message.id)).resolves.toBe(sender.id);
    });

    it('returns senderId even when the sender account is non-active', async () => {
      const sender = await makeUser({ status: 'banned' });
      const conversation = await makeConversation();
      const message = await makeMessage(conversation.id, sender.id);
      await expect(service.resolveMessageOwnerId(message.id)).resolves.toBe(sender.id);
    });

    it('returns null (never throws) for a nonexistent message id', async () => {
      await expect(service.resolveMessageOwnerId(randomUUID())).resolves.toBeNull();
    });
  });
});
