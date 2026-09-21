import { Injectable } from '@nestjs/common';
import type { Notification, Prisma, UserStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { ProfileVisibilityService } from '../profiles/profile-visibility.service';
import { InvalidCursorException, ResourceNotFoundException } from '../common/errors/api-exception';
import { clampLimit, decodeCursor, toPage } from '../common/pagination/cursor';
import type { ListNotificationsQueryDto } from './dto/list-notifications-query.dto';

// The unread badge is capped so the query stays cheap however large a
// backlog gets: exact up to this many, "this many or more" beyond it.
const UNREAD_COUNT_CAP = 100;

// Who triggered the notification, as far as the recipient may know:
//  - null: a system notification, or an actor who is no longer active
//    (suspended, banned, deleted, ...) — the notification is kept, the
//    identity is not shown;
//  - { id }: the actor's profile is not public, so only the id is exposed;
//  - the full summary: a public profile (including a user with no profile
//    row yet, which the existing visibility rule treats as public).
export type NotificationActor = { id: string } | { id: string; displayName: string | null; handle: string | null };

export interface NotificationResponse {
  id: string;
  type: string;
  actor: NotificationActor | null;
  targetType: string | null;
  targetId: string | null;
  groupKey: string | null;
  // Returned exactly as stored. It is "safe display metadata only" by
  // contract (database.md §10) but nothing validates it: there are no
  // producers and no notification type vocabulary yet.
  payload: unknown;
  readAt: Date | null;
  createdAt: Date;
}

interface ActorRow {
  id: string;
  handle: string | null;
  status: UserStatus;
  deletedAt: Date | null;
  profile: { displayName: string | null; visibility: 'public' | 'followers' | 'private' } | null;
}

type NotificationWithActor = Notification & { actor: ActorRow | null };

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly visibility: ProfileVisibilityService,
  ) {}

  // The rows this recipient may see, as AND-ed conditions (AND, because the
  // block filter and the cursor each need their own OR and would otherwise
  // overwrite one another under the same key):
  //  - their own, not dismissed (and, when asked, not yet read);
  //  - not from a user they blocked or who blocked them. System
  //    notifications (no actor) are always kept — note that a bare
  //    `notIn` would silently drop them, since NULL NOT IN (...) is never
  //    true, so the null case is spelled out.
  // Used by both the list and the count so the badge can never disagree
  // with the list.
  private async visibleTo(userId: string, unreadOnly: boolean): Promise<Prisma.NotificationWhereInput[]> {
    const conditions: Prisma.NotificationWhereInput[] = [
      { recipientUserId: userId, deletedAt: null, ...(unreadOnly && { readAt: null }) },
    ];
    // Two indexed lookups, then an array filter: measured far cheaper than
    // a per-row anti-join when a blocked actor floods the inbox. A user with
    // tens of thousands of blocks would hit bind-parameter limits; that is
    // not a realistic MVP case and is not handled.
    const blocked = await this.visibility.blockedUserIds(userId);
    if (blocked.length > 0) {
      conditions.push({ OR: [{ actorUserId: null }, { actorUserId: { notIn: blocked } }] });
    }
    return conditions;
  }

  async list(userId: string, query: ListNotificationsQueryDto) {
    const take = clampLimit(query.limit);
    const decoded = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !decoded) {
      throw new InvalidCursorException();
    }

    const conditions = await this.visibleTo(userId, query.unread === 'true');
    if (decoded) {
      conditions.push({ OR: [{ createdAt: { lt: decoded.createdAt } }, { createdAt: decoded.createdAt, id: { lt: decoded.id } }] });
    }

    const rows = await this.prisma.notification.findMany({
      where: { AND: conditions },
      include: {
        actor: {
          select: {
            id: true,
            handle: true,
            status: true,
            deletedAt: true,
            profile: { select: { displayName: true, visibility: true } },
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
    });

    const page = toPage(rows, take);
    return { data: page.data.map((n) => this.toResponse(n)), nextCursor: page.nextCursor, hasMore: page.hasMore };
  }

  async unreadCount(userId: string): Promise<{ count: number; capped: boolean }> {
    const conditions = await this.visibleTo(userId, true);
    // Fetch one row past the cap and stop: the block filter can discard rows,
    // so the cap is applied after filtering, never before.
    const rows = await this.prisma.notification.findMany({
      where: { AND: conditions },
      select: { id: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: UNREAD_COUNT_CAP + 1,
    });
    return { count: Math.min(rows.length, UNREAD_COUNT_CAP), capped: rows.length > UNREAD_COUNT_CAP };
  }

  // Idempotent. One conditional update does the work, so two concurrent
  // reads cannot both write and the first read time is never overwritten.
  // Only when it changes nothing do we look again, to tell "already read"
  // (fine) from "not yours / not there / dismissed" (404, the same answer
  // for all three so ids cannot be probed). Not block-filtered: a hidden
  // row is unreachable from the list anyway.
  async markRead(userId: string, id: string): Promise<void> {
    const { count } = await this.prisma.notification.updateMany({
      where: { id, recipientUserId: userId, deletedAt: null, readAt: null },
      data: { readAt: new Date() },
    });
    if (count > 0) {
      return;
    }
    const exists = await this.prisma.notification.findFirst({
      where: { id, recipientUserId: userId, deletedAt: null },
      select: { id: true },
    });
    if (!exists) {
      throw new ResourceNotFoundException();
    }
  }

  // Idempotent soft delete: the row stays (its dedup_key stays claimed, so a
  // replayed event cannot bring a dismissed notification back) and read_at
  // is left alone — dismissing is not reading. On a repeat the lookup
  // deliberately includes dismissed rows, so a second dismissal is a 204.
  async dismiss(userId: string, id: string): Promise<void> {
    const { count } = await this.prisma.notification.updateMany({
      where: { id, recipientUserId: userId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (count > 0) {
      return;
    }
    const exists = await this.prisma.notification.findFirst({
      where: { id, recipientUserId: userId },
      select: { id: true },
    });
    if (!exists) {
      throw new ResourceNotFoundException();
    }
  }

  private toActor(actor: ActorRow | null): NotificationActor | null {
    if (!actor || actor.status !== 'active' || actor.deletedAt) {
      return null;
    }
    const visibility = actor.profile?.visibility ?? 'public';
    if (visibility !== 'public') {
      return { id: actor.id };
    }
    return { id: actor.id, displayName: actor.profile?.displayName ?? null, handle: actor.handle };
  }

  // Explicit mapping: never spread the row (it carries dedupKey,
  // recipientUserId and deletedAt, which are not part of the contract).
  private toResponse(n: NotificationWithActor): NotificationResponse {
    return {
      id: n.id,
      type: n.type,
      actor: this.toActor(n.actor),
      targetType: n.targetType,
      targetId: n.targetId,
      groupKey: n.groupKey,
      payload: n.payload,
      readAt: n.readAt,
      createdAt: n.createdAt,
    };
  }
}
