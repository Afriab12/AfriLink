import { Controller, Delete, Get, Header, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { NotificationsService, type NotificationResponse } from './notifications.service';
import { ListNotificationsQueryDto } from './dto/list-notifications-query.dto';
import { NotificationIdParamDto } from './dto/notification-id-param.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

interface PageMeta {
  meta: { page: { nextCursor: string | null; hasMore: boolean } };
}

// REST/polling only for the MVP (ADR-004 §7): no WebSocket event exists for
// notifications. Every route is recipient-scoped — there is no way to name
// another user's notification.
//
// Rate limiting: NOT implemented or enforced here, and no Notifications-
// specific limits are defined yet (api.md §11). The only limiter that exists
// (RateLimitGuard) is per IP, in memory and per process; users behind one
// shared carrier IP would share a counter, so polling `unread-count` could
// 429 legitimate users. Left off deliberately until an account-keyed limiter
// exists.
@ApiTags('Notifications')
@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  // User-specific and polled, so never cached by a browser or shared proxy.
  @Get()
  @Header('Cache-Control', 'private, no-store')
  async list(
    @CurrentUser() user: { sub: string },
    @Query() query: ListNotificationsQueryDto,
  ): Promise<{ data: NotificationResponse[] } & PageMeta> {
    const { data, nextCursor, hasMore } = await this.notificationsService.list(user.sub, query);
    return { data, meta: { page: { nextCursor, hasMore } } };
  }

  @Get('unread-count')
  @Header('Cache-Control', 'private, no-store')
  async unreadCount(@CurrentUser() user: { sub: string }): Promise<{ data: { count: number; capped: boolean } }> {
    return { data: await this.notificationsService.unreadCount(user.sub) };
  }

  // 204, not the 200 + body other mutation routes use: approved for the
  // Notifications contract (repeat calls are a no-op, there is nothing to
  // return).
  @Post(':id/read')
  @HttpCode(204)
  @UseGuards(CsrfGuard)
  async markRead(@CurrentUser() user: { sub: string }, @Param() params: NotificationIdParamDto): Promise<void> {
    await this.notificationsService.markRead(user.sub, params.id);
  }

  @Delete(':id')
  @HttpCode(204)
  @UseGuards(CsrfGuard)
  async dismiss(@CurrentUser() user: { sub: string }, @Param() params: NotificationIdParamDto): Promise<void> {
    await this.notificationsService.dismiss(user.sub, params.id);
  }
}
