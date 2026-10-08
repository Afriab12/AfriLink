import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Notification, UserStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { ProfileVisibilityService } from '../profiles/profile-visibility.service';
import {
  InvalidCursorException,
  ResourceNotFoundException,
  ValidationFailedException,
} from '../common/errors/api-exception';
import { clampLimit, decodeCursor, toPage } from '../common/pagination/cursor';
import type { ListNotificationsQueryDto } from './dto/list-notifications-query.dto';

export const NOTIFICATION_PREFERENCE_CATEGORIES = ['social', 'engagement', 'community'] as const;
export const NOTIFICATION_PREFERENCE_CHANNELS = ['in_app'] as const;

export type NotificationPreferenceCategory = (typeof NOTIFICATION_PREFERENCE_CATEGORIES)[number];
export type NotificationPreferenceChannel = (typeof NOTIFICATION_PREFERENCE_CHANNELS)[number];

const NOTIFICATION_TYPE_CATEGORY = new Map<string, NotificationPreferenceCategory>([
  ['friend_request_received', 'social'],
  ['friend_request_accepted', 'social'],
  ['follow_received', 'social'],
  ['post_reaction', 'engagement'],
  ['comment_reaction', 'engagement'],
  ['post_comment', 'engagement'],
  ['comment_reply', 'engagement'],
  ['community_membership_approved', 'community'],
]);

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
  // contract (database.md §10); producers currently leave it null.
  payload: unknown;
  readAt: Date | null;
  createdAt: Date;
}

// Producer-facing input (Notifications A1). Keep the producer shape generic;
// the supported type-to-preference mapping is enforced centrally in record().
export interface RecordNotificationInput {
  type: string;
  recipientUserId: string;
  actorUserId: string | null;
  targetType?: string;
  targetId?: string;
  // Deterministic, caller-supplied — this IS the dedup mechanism (unique
  // per recipient, database.md §10); callers must derive it from a stable
  // domain-row id, never from a value that recurs across logically
  // distinct events.
  dedupKey?: string;
  payload?: Prisma.InputJsonValue;
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

  // Centralized producer entry point. Producers remain responsible for
  // atomicity classification; current producers use best-effort wrappers.
  //
  // Self-notification: defensively no-ops rather than letting the DB CHECK
  // (`notifications_no_self_notify_check`) throw — every current producer
  // already guards against this upstream, so this path is not expected to
  // be reached in practice, but the service does not trust callers alone.
  //
  // Preference resolution happens before creation, so a disabled event or
  // lookup failure never claims its dedup key.
  //
  // Deduplication: `dedupKey` collisions (the unique
  // `(recipientUserId, dedupKey)` index) are treated as an expected,
  // successful no-op — "already recorded" is not a failure a caller's
  // best-effort wrapper should ever see or log.
  async record(input: RecordNotificationInput): Promise<void> {
    if (input.actorUserId !== null && input.actorUserId === input.recipientUserId) {
      return;
    }
    const category = NOTIFICATION_TYPE_CATEGORY.get(input.type);
    if (!category || !(await this.preferenceEnabled(input.recipientUserId, category, 'in_app'))) {
      return;
    }

    try {
      await this.prisma.notification.create({
        data: {
          type: input.type,
          recipientUserId: input.recipientUserId,
          actorUserId: input.actorUserId,
          targetType: input.targetType,
          targetId: input.targetId,
          dedupKey: input.dedupKey,
          payload: input.payload,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return;
      }
      throw error;
    }
  }

  async getPreferences(userId: string): Promise<
    { category: NotificationPreferenceCategory; channel: NotificationPreferenceChannel; enabled: boolean }[]
  > {
    const overrides = await this.prisma.notificationPreference.findMany({
      where: {
        userId,
        category: { in: [...NOTIFICATION_PREFERENCE_CATEGORIES] },
        channel: 'in_app',
      },
      select: { category: true, enabled: true },
    });
    const enabledByCategory = new Map(overrides.map((preference) => [preference.category, preference.enabled]));

    return NOTIFICATION_PREFERENCE_CATEGORIES.map((category) => ({
      category,
      channel: 'in_app',
      enabled: enabledByCategory.get(category) ?? true,
    }));
  }

  async updatePreferences(
    userId: string,
    preferences: {
      category: NotificationPreferenceCategory;
      channel: NotificationPreferenceChannel;
      enabled: boolean;
    }[],
  ): Promise<{ category: NotificationPreferenceCategory; channel: NotificationPreferenceChannel; enabled: boolean }[]> {
    const keys = preferences.map(({ category, channel }) => `${category}:${channel}`);
    if (new Set(keys).size !== keys.length) {
      throw new ValidationFailedException([
        { field: 'preferences', reason: 'must not contain duplicate category/channel pairs' },
      ]);
    }

    await this.prisma.$transaction(
      preferences.map(({ category, channel, enabled }) =>
        this.prisma.notificationPreference.upsert({
          where: { userId_category_channel: { userId, category, channel } },
          create: { userId, category, channel, enabled },
          update: { enabled },
        }),
      ),
    );

    return this.getPreferences(userId);
  }

  private async preferenceEnabled(
    userId: string,
    category: NotificationPreferenceCategory,
    channel: NotificationPreferenceChannel,
  ): Promise<boolean> {
    const preference = await this.prisma.notificationPreference.findUnique({
      where: { userId_category_channel: { userId, category, channel } },
      select: { enabled: true },
    });

    return preference?.enabled ?? true;
  }

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
