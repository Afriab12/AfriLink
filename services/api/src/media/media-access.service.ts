import { Injectable } from '@nestjs/common';
import type { Asset } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { PolicyRejectedException, ResourceNotFoundException } from '../common/errors/api-exception';
import type { AssetPurpose } from './media.constants';

// The cross-module ownership/purpose/readiness authority docs/05-api/media.md
// §7 requires: "a user must not be able to attach another user's media
// simply by knowing its ID." Every owning module (Profiles, Communities,
// Content, Messaging) is meant to call assertAttachable through this
// exported service, not re-implement the check — matching how
// CommunityAccessService is already consumed by Content rather than
// duplicated. Not yet consumed by any module (that wiring is its own future,
// separately-reviewed increment, media.md §15 step 5) — built and tested in
// isolation now so it is correct before anything depends on it.
@Injectable()
export class MediaAccessService {
  constructor(private readonly prisma: PrismaService) {}

  // Owner-only lookup — same 404 regardless of "doesn't exist", "not yours"
  // or "soft-deleted" (api.md §6: never disambiguate why a resource is
  // unreachable). Used directly by GET/DELETE /media/{id}.
  async findOwnedAsset(userId: string, assetId: string): Promise<Asset> {
    const asset = await this.prisma.asset.findFirst({ where: { id: assetId, ownerUserId: userId, deletedAt: null } });
    if (!asset) {
      throw new ResourceNotFoundException();
    }
    return asset;
  }

  // Everything an owning module needs before writing its own attachment
  // reference (a post_media row, avatarMediaId, ...): the asset exists, is
  // owned by the caller, matches the purpose it was reserved for, and has
  // finished processing. "Not found" and "not yours" collapse into the same
  // 404; "wrong purpose" and "not ready" are POLICY_REJECTED — a different
  // class of failure (the asset is real and owned, but not usable here yet
  // or not usable this way), matching the 404-vs-422-POLICY_REJECTED split
  // already used throughout Communities.
  async assertAttachable(userId: string, assetId: string, expectedPurpose: AssetPurpose): Promise<Asset> {
    const asset = await this.prisma.asset.findFirst({ where: { id: assetId, deletedAt: null } });
    if (!asset || asset.ownerUserId !== userId) {
      throw new ResourceNotFoundException();
    }
    if (asset.purpose !== expectedPurpose) {
      throw new PolicyRejectedException(`This asset was reserved for '${asset.purpose}', not '${expectedPurpose}'.`);
    }
    if (asset.state !== 'ready') {
      throw new PolicyRejectedException('This asset is not ready to be attached.');
    }
    return asset;
  }
}
