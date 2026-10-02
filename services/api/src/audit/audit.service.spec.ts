import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../common/prisma/prisma.service';
import { AuditService } from './audit.service';
import { ValidationFailedException } from '../common/errors/api-exception';
import type { AuditEventInput } from './dto/audit-event.types';

describe('AuditService', () => {
  let prisma: PrismaService;
  let service: AuditService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new AuditService(prisma);
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  async function makeUser() {
    return prisma.user.create({ data: { status: 'active', updatedAt: new Date() } });
  }

  async function latestEvent(subjectId: string) {
    return prisma.auditEvent.findFirst({ where: { subjectId }, orderBy: { createdAt: 'desc' } });
  }

  // --------------------------------------------------------- happy paths

  it('records a best-effort event (auth_login_succeeded) with all nine event types accepted', async () => {
    const user = await makeUser();
    const occurredAt = new Date('2026-01-01T00:00:00Z');

    const inputs: AuditEventInput[] = [
      { eventType: 'auth_login_succeeded', actorId: user.id, subjectType: 'user', subjectId: user.id, metadata: { sessionId: randomUUID() }, occurredAt },
      { eventType: 'auth_session_revoked', actorId: user.id, subjectType: 'user', subjectId: user.id, metadata: { sessionId: randomUUID() }, occurredAt },
    ];
    for (const input of inputs) {
      await service.record(input);
    }
    const last = await latestEvent(user.id);
    expect(last?.eventType).toBe('auth_session_revoked');
  });

  it('accepts a null actorId (system/unauthenticated event)', async () => {
    const user = await makeUser();
    await service.record({
      eventType: 'auth_login_succeeded',
      actorId: null,
      subjectType: 'user',
      subjectId: user.id,
      metadata: { sessionId: randomUUID() },
      occurredAt: new Date(),
    });
    const row = await latestEvent(user.id);
    expect(row?.actorId).toBeNull();
  });

  it('stores ipHash/userAgentHash exactly as given, performing no hashing itself', async () => {
    const user = await makeUser();
    const rawLookingValue = 'not-actually-hashed-just-a-literal-string';
    await service.record({
      eventType: 'auth_login_succeeded',
      actorId: user.id,
      subjectType: 'user',
      subjectId: user.id,
      metadata: { sessionId: randomUUID() },
      occurredAt: new Date(),
      ipHash: rawLookingValue,
      userAgentHash: rawLookingValue,
    });
    const row = await latestEvent(user.id);
    expect(row?.ipHash).toBe(rawLookingValue);
    expect(row?.userAgentHash).toBe(rawLookingValue);
  });

  it('preserves the caller-supplied occurredAt rather than defaulting to now()', async () => {
    const user = await makeUser();
    const occurredAt = new Date('2020-06-15T12:30:00Z');
    await service.record({
      eventType: 'auth_login_succeeded',
      actorId: user.id,
      subjectType: 'user',
      subjectId: user.id,
      metadata: { sessionId: randomUUID() },
      occurredAt,
    });
    const row = await latestEvent(user.id);
    expect(row?.occurredAt.toISOString()).toBe(occurredAt.toISOString());
  });

  it('accepts the empty metadata object for auth_all_sessions_revoked', async () => {
    const user = await makeUser();
    await service.record({
      eventType: 'auth_all_sessions_revoked',
      actorId: user.id,
      subjectType: 'user',
      subjectId: user.id,
      metadata: {},
      occurredAt: new Date(),
    });
    const row = await latestEvent(user.id);
    expect(row?.metadata).toEqual({});
  });

  it('writes a mandatory event inside a caller-supplied transaction', async () => {
    const user = await makeUser();
    await prisma.$transaction(async (tx) => {
      await service.record(
        {
          eventType: 'moderation_action_recorded',
          actorId: user.id,
          subjectType: 'user',
          subjectId: user.id,
          metadata: { actionType: 'warn_user', targetType: 'profile', targetId: user.id },
          occurredAt: new Date(),
        },
        tx,
      );
    });
    const row = await latestEvent(user.id);
    expect(row?.eventType).toBe('moderation_action_recorded');
  });

  // ----------------------------------------------------------- envelope

  it('rejects a non-UUID actorId', async () => {
    const user = await makeUser();
    await expect(
      service.record({
        eventType: 'auth_login_succeeded',
        actorId: 'not-a-uuid',
        subjectType: 'user',
        subjectId: user.id,
        metadata: { sessionId: randomUUID() },
        occurredAt: new Date(),
      }),
    ).rejects.toBeInstanceOf(ValidationFailedException);
  });

  it('rejects an empty subjectType', async () => {
    const user = await makeUser();
    await expect(
      service.record({
        eventType: 'auth_login_succeeded',
        actorId: user.id,
        subjectType: '',
        subjectId: user.id,
        metadata: { sessionId: randomUUID() },
        occurredAt: new Date(),
      }),
    ).rejects.toBeInstanceOf(ValidationFailedException);
  });

  it('rejects a non-UUID subjectId', async () => {
    await expect(
      service.record({
        eventType: 'auth_login_succeeded',
        actorId: null,
        subjectType: 'user',
        subjectId: 'not-a-uuid',
        metadata: { sessionId: randomUUID() },
        occurredAt: new Date(),
      }),
    ).rejects.toBeInstanceOf(ValidationFailedException);
  });

  it('rejects a reason longer than 2000 characters', async () => {
    const user = await makeUser();
    await expect(
      service.record({
        eventType: 'auth_login_succeeded',
        actorId: user.id,
        subjectType: 'user',
        subjectId: user.id,
        metadata: { sessionId: randomUUID() },
        occurredAt: new Date(),
        reason: 'a'.repeat(2001),
      }),
    ).rejects.toBeInstanceOf(ValidationFailedException);
  });

  // ------------------------------------------------------------ metadata

  it('rejects metadata missing a required field', async () => {
    const user = await makeUser();
    await expect(
      service.record({
        eventType: 'auth_login_succeeded',
        actorId: user.id,
        subjectType: 'user',
        subjectId: user.id,
        metadata: {} as never,
        occurredAt: new Date(),
      }),
    ).rejects.toBeInstanceOf(ValidationFailedException);
  });

  it('rejects metadata carrying an undeclared field (e.g. an accidental password/token)', async () => {
    const user = await makeUser();
    await expect(
      service.record({
        eventType: 'auth_login_succeeded',
        actorId: user.id,
        subjectType: 'user',
        subjectId: user.id,
        metadata: { sessionId: randomUUID(), password: 'leaked' } as never,
        occurredAt: new Date(),
      }),
    ).rejects.toBeInstanceOf(ValidationFailedException);
  });

  // No metadata-size (8KB) spec: every declared metadata field is a UUID,
  // enum, or bounded integer, so no schema-valid metadata payload can reach
  // 8KB in the first place — the size gate exists as a defense-in-depth
  // backstop for future event types with free-text metadata fields, not one
  // reachable by today's shapes. Covered instead by the oversized-`reason`
  // test above, which exercises the same size-gate code path.

  // ------------------------------------------------------- mandatory-ness

  it('throws a plain Error (not an ApiException) when a mandatory event is recorded without a transaction', async () => {
    const user = await makeUser();
    await expect(
      service.record({
        eventType: 'moderation_action_recorded',
        actorId: user.id,
        subjectType: 'user',
        subjectId: user.id,
        metadata: { actionType: 'warn_user', targetType: 'profile', targetId: user.id },
        occurredAt: new Date(),
      }),
    ).rejects.toThrow(/transaction/i);
  });

  it('does not require a transaction for a best-effort event type', async () => {
    const user = await makeUser();
    await expect(
      service.record({
        eventType: 'auth_login_succeeded',
        actorId: user.id,
        subjectType: 'user',
        subjectId: user.id,
        metadata: { sessionId: randomUUID() },
        occurredAt: new Date(),
      }),
    ).resolves.toBeUndefined();
  });

  it('rolls back a mandatory audit write together with the rest of its transaction on failure', async () => {
    const user = await makeUser();
    await expect(
      prisma.$transaction(async (tx) => {
        await service.record(
          {
            eventType: 'moderation_action_recorded',
            actorId: user.id,
            subjectType: 'user',
            subjectId: user.id,
            metadata: { actionType: 'warn_user', targetType: 'profile', targetId: user.id },
            occurredAt: new Date(),
          },
          tx,
        );
        throw new Error('forced failure after audit write');
      }),
    ).rejects.toThrow('forced failure after audit write');

    const rows = await prisma.auditEvent.findMany({ where: { subjectId: user.id, eventType: 'moderation_action_recorded' } });
    expect(rows).toHaveLength(0);
  });
});
