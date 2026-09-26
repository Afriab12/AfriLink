import { Injectable } from '@nestjs/common';
import type { CommunityMembershipStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';

// The cross-module surface docs/05-api/moderation.md §7 names as
// "Moderation → Communities": applyMembershipSanction/liftMembershipSanction
// execute and reverse restrict_community_participation, resolveMembership/
// resolveCommunityOwnerId are the privileged lookups Moderation's
// action-creation flow and appeal affected-party check need. Never routed —
// reachable only via CommunitiesModule's export + Nest DI (same boundary
// ContentModerationService/MessagingModerationService already rely on), so
// there is no request path for an ordinary user to hit these directly. No
// second moderator-authorization system here: this service trusts its
// caller completely, exactly like the other two — PlatformRoleGuard/
// CommunityAccessService's staff checks are unrelated and untouched.
//
// K.1 (owner-recorded, deliberately not fixed here): MembershipsService.join()
// only blocks re-entry for status='banned' — a 'removed' row has no such
// guard, so a member sanctioned to 'removed' can simply rejoin. Until that
// gap is separately resolved, a caller of this service must not treat
// 'removed' as an enforcement-complete restriction.
@Injectable()
export class CommunityModerationService {
  constructor(private readonly prisma: PrismaService) {}

  // Sets CommunityMembership.status directly — never touches removedAt,
  // leftAt, or approvedAt (owner decision K.3: moderation history lives in
  // moderation.actions/sanctions, not duplicated onto these timestamps).
  // Accepts an optional transaction client so the caller (the future
  // Moderation action-creation flow) can commit this alongside its own
  // Action/Sanction inserts atomically. Throws (propagating Prisma's own
  // P2025) if membershipId doesn't resolve — a caller that has already
  // validated the target moments earlier via resolveMembership should never
  // legitimately hit this.
  async applyMembershipSanction(membershipId: string, status: 'removed' | 'banned', tx?: Prisma.TransactionClient): Promise<void> {
    const client = tx ?? this.prisma;
    await client.communityMembership.update({ where: { id: membershipId }, data: { status } });
  }

  // Restores the SAME membership row to 'active' (owner decision K.2): never
  // creates a new row, never evaluates community.membershipPolicy — an
  // overturned moderation action restores the prior relationship, it is not
  // a fresh join request. Does not touch removedAt/leftAt/approvedAt (K.3).
  // Repeated calls are a no-op update, same idempotency convention as
  // applyMembershipSanction.
  async liftMembershipSanction(membershipId: string, tx?: Prisma.TransactionClient): Promise<void> {
    const client = tx ?? this.prisma;
    await client.communityMembership.update({ where: { id: membershipId }, data: { status: 'active' } });
  }

  // Privileged (communityId, userId) -> membership row resolution for
  // Moderation's action-creation flow, mirroring CommunityAccessService.
  // viewerRelation's own priority order (active, then pending, then most
  // recent historical row) but returning the row's own id — which
  // viewerRelation's computed ViewerRelation never exposes — and never
  // gating on the community's own active/deleted status the way
  // CommunityAccessService.findActiveById does. Does not filter out
  // removed/banned/left/rejected rows: sanctioning or lifting a sanction on
  // an already-non-active member is the normal use case here.
  async resolveMembership(communityId: string, userId: string): Promise<{ id: string; status: CommunityMembershipStatus } | null> {
    const rows = await this.prisma.communityMembership.findMany({
      where: { communityId, userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    if (rows.length === 0) {
      return null;
    }
    const active = rows.find((r) => r.status === 'active');
    if (active) {
      return { id: active.id, status: active.status };
    }
    const pending = rows.find((r) => r.status === 'pending');
    if (pending) {
      return { id: pending.id, status: pending.status };
    }
    return { id: rows[0].id, status: rows[0].status };
  }

  // No filtering at all — not status, not deletedAt. Unlike
  // CommunityAccessService.findActiveById (throws 404 for a deleted or
  // non-active community), this exists precisely because Moderation needs
  // to resolve a community's owner for the appeal affected-party check
  // (api.md §5) even when the community itself has been moderator-removed.
  async resolveCommunityOwnerId(communityId: string): Promise<string | null> {
    const community = await this.prisma.community.findUnique({ where: { id: communityId }, select: { ownerUserId: true } });
    return community?.ownerUserId ?? null;
  }
}
