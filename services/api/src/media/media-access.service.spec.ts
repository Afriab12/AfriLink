import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../common/prisma/prisma.service';
import { MediaAccessService } from './media-access.service';
import { ResourceNotFoundException, PolicyRejectedException } from '../common/errors/api-exception';

// Unit-level (no HTTP layer): MediaAccessService.assertAttachable is the
// cross-module authority docs/05-api/media.md §7 requires — "use the Media
// service as the ownership/purpose/readiness authority, don't duplicate this
// logic in every owning module." Not yet consumed by any other module (that
// wiring is future work, media.md §15 step 5); tested directly here so it's
// correct before anything depends on it.
describe('MediaAccessService', () => {
  let prisma: PrismaService;
  let access: MediaAccessService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    access = new MediaAccessService(prisma);
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  async function makeUser() {
    return prisma.user.create({ data: { status: 'active', updatedAt: new Date() } });
  }

  async function makeAsset(ownerUserId: string, overrides: Partial<{ purpose: string; state: string; deletedAt: Date }> = {}) {
    return prisma.asset.create({
      data: {
        ownerUserId,
        kind: 'image',
        purpose: overrides.purpose ?? 'post',
        state: (overrides.state as never) ?? 'ready',
        declaredMimeType: 'image/png',
        storageProvider: 's3_compatible',
        storageKey: `media/${ownerUserId}/${randomUUID()}/original`,
        deletedAt: overrides.deletedAt ?? null,
        updatedAt: new Date(),
      },
    });
  }

  describe('assertAttachable', () => {
    it('returns the asset when owned, matching purpose, and ready', async () => {
      const owner = await makeUser();
      const asset = await makeAsset(owner.id, { purpose: 'post', state: 'ready' });
      const result = await access.assertAttachable(owner.id, asset.id, 'post');
      expect(result.id).toBe(asset.id);
    });

    it('throws ResourceNotFoundException for a nonexistent asset', async () => {
      const owner = await makeUser();
      await expect(access.assertAttachable(owner.id, randomUUID(), 'post')).rejects.toThrow(ResourceNotFoundException);
    });

    it("throws ResourceNotFoundException — never a different error — for someone else's asset (a user must not attach another user's media by knowing its ID)", async () => {
      const owner = await makeUser();
      const stranger = await makeUser();
      const asset = await makeAsset(owner.id, { purpose: 'post', state: 'ready' });
      await expect(access.assertAttachable(stranger.id, asset.id, 'post')).rejects.toThrow(ResourceNotFoundException);
    });

    it('throws ResourceNotFoundException for a soft-deleted asset, even when owned', async () => {
      const owner = await makeUser();
      const asset = await makeAsset(owner.id, { purpose: 'post', state: 'ready', deletedAt: new Date() });
      await expect(access.assertAttachable(owner.id, asset.id, 'post')).rejects.toThrow(ResourceNotFoundException);
    });

    it('throws PolicyRejectedException when the purpose does not match', async () => {
      const owner = await makeUser();
      const asset = await makeAsset(owner.id, { purpose: 'avatar', state: 'ready' });
      await expect(access.assertAttachable(owner.id, asset.id, 'post')).rejects.toThrow(PolicyRejectedException);
    });

    it.each(['pending', 'processing', 'rejected'] as const)('throws PolicyRejectedException when the asset is not ready (state=%s)', async (state) => {
      const owner = await makeUser();
      const asset = await makeAsset(owner.id, { purpose: 'post', state });
      await expect(access.assertAttachable(owner.id, asset.id, 'post')).rejects.toThrow(PolicyRejectedException);
    });
  });

  describe('findOwnedAsset', () => {
    it('returns the asset when owned', async () => {
      const owner = await makeUser();
      const asset = await makeAsset(owner.id, { state: 'pending' });
      const result = await access.findOwnedAsset(owner.id, asset.id);
      expect(result.id).toBe(asset.id);
    });

    it('throws ResourceNotFoundException for another owner, an unknown id, or a soft-deleted asset', async () => {
      const owner = await makeUser();
      const stranger = await makeUser();
      const asset = await makeAsset(owner.id);
      const deleted = await makeAsset(owner.id, { deletedAt: new Date() });
      await expect(access.findOwnedAsset(stranger.id, asset.id)).rejects.toThrow(ResourceNotFoundException);
      await expect(access.findOwnedAsset(owner.id, randomUUID())).rejects.toThrow(ResourceNotFoundException);
      await expect(access.findOwnedAsset(owner.id, deleted.id)).rejects.toThrow(ResourceNotFoundException);
    });
  });
});
