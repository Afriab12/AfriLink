import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { PlatformRoleGuard } from './platform-role.guard';
import { ForbiddenActionException } from '../errors/api-exception';

// Unit-level (no HTTP layer, direct PrismaService instantiation — same
// pattern as media-access.service.spec.ts): PlatformRoleGuard's decision
// logic against real user_roles/roles rows. The e2e spec
// (test/platform-role-guard.e2e-spec.ts) covers the parts this can't:
// real composition with JwtAuthGuard/CsrfGuard, and the account-status
// layering order.

function makeReflector(roleKey: string | undefined): Reflector {
  return { get: vi.fn().mockReturnValue(roleKey) } as unknown as Reflector;
}

function makeContext(userId: string): ExecutionContext {
  const handler = () => undefined;
  return {
    getHandler: () => handler,
    getClass: () => ({ name: 'TestController' }) as unknown as new (...args: unknown[]) => unknown,
    switchToHttp: () => ({
      getRequest: () => ({ user: { sub: userId, sid: randomUUID() } }),
    }),
  } as unknown as ExecutionContext;
}

describe('PlatformRoleGuard', () => {
  let prisma: PrismaService;
  let moderatorRoleId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    const role = await prisma.role.upsert({
      where: { key: 'moderator' },
      update: {},
      create: { key: 'moderator', name: 'Moderator', description: 'test fixture' },
    });
    moderatorRoleId = role.id;
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  async function makeUser() {
    return prisma.user.create({ data: { status: 'active', updatedAt: new Date() } });
  }

  async function grantModerator(userId: string, overrides: Partial<{ revokedAt: Date | null; expiresAt: Date | null }> = {}) {
    return prisma.userRole.create({
      data: {
        userId,
        roleId: moderatorRoleId,
        revokedAt: overrides.revokedAt ?? null,
        expiresAt: overrides.expiresAt ?? null,
      },
    });
  }

  it('allows every request when the route has no @RequireRole metadata', async () => {
    const guard = new PlatformRoleGuard(prisma, makeReflector(undefined));
    const user = await makeUser();
    await expect(guard.canActivate(makeContext(user.id))).resolves.toBe(true);
  });

  it('allows a caller with an active moderator grant', async () => {
    const guard = new PlatformRoleGuard(prisma, makeReflector('moderator'));
    const user = await makeUser();
    await grantModerator(user.id);
    await expect(guard.canActivate(makeContext(user.id))).resolves.toBe(true);
  });

  it('rejects an ordinary user with no grant at all', async () => {
    const guard = new PlatformRoleGuard(prisma, makeReflector('moderator'));
    const user = await makeUser();
    await expect(guard.canActivate(makeContext(user.id))).rejects.toThrow(ForbiddenActionException);
  });

  it('rejects a revoked moderator grant', async () => {
    const guard = new PlatformRoleGuard(prisma, makeReflector('moderator'));
    const user = await makeUser();
    await grantModerator(user.id, { revokedAt: new Date() });
    await expect(guard.canActivate(makeContext(user.id))).rejects.toThrow(ForbiddenActionException);
  });

  it('rejects an expired moderator grant', async () => {
    const guard = new PlatformRoleGuard(prisma, makeReflector('moderator'));
    const user = await makeUser();
    await grantModerator(user.id, { expiresAt: new Date(Date.now() - 60_000) });
    await expect(guard.canActivate(makeContext(user.id))).rejects.toThrow(ForbiddenActionException);
  });

  it('allows a grant with a future expiresAt (not yet expired)', async () => {
    const guard = new PlatformRoleGuard(prisma, makeReflector('moderator'));
    const user = await makeUser();
    await grantModerator(user.id, { expiresAt: new Date(Date.now() + 60_000) });
    await expect(guard.canActivate(makeContext(user.id))).resolves.toBe(true);
  });

  it('rejects a grant that exists for a different role key', async () => {
    const otherRole = await prisma.role.upsert({
      where: { key: 'not-a-real-role' },
      update: {},
      create: { key: 'not-a-real-role', name: 'Not Real', description: 'test fixture' },
    });
    const guard = new PlatformRoleGuard(prisma, makeReflector('moderator'));
    const user = await makeUser();
    await prisma.userRole.create({ data: { userId: user.id, roleId: otherRole.id } });
    await expect(guard.canActivate(makeContext(user.id))).rejects.toThrow(ForbiddenActionException);
  });
});
