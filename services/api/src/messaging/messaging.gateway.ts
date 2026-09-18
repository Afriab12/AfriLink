import { Injectable } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import type { Server, Socket } from 'socket.io';
import { MessagingAccessService } from './messaging-access.service';
import { parseCookieHeader } from './cookie.util';
import { ACCESS_COOKIE } from '../auth/cookies.util';
import type { AccessTokenPayload } from '../common/guards/jwt-auth.guard';

interface WsAck {
  ok: boolean;
  error?: { code: string; message: string };
}

// ADR-006 §6/§7: client -> server is subscription-management ONLY
// (conversation.join/leave) — no message.send, no WS message.read.
// Sending/reading are REST-only, unchanged from ADR-004 §6. This gateway
// never writes to the database; MessagesService/ConversationsService call
// emitToConversation() after a REST write commits, never the reverse.
@Injectable()
@WebSocketGateway({
  namespace: 'messaging',
  cors: {
    origin: process.env.FRONTEND_ORIGIN ?? true,
    credentials: true,
  },
})
export class MessagingGateway implements OnGatewayInit, OnGatewayDisconnect {
  // In-memory per-socket strike counter for repeated invalid events
  // (ADR-006 §11) — same minimalism precedent as RateLimitGuard's
  // in-memory store, not a new dependency.
  private readonly strikes = new Map<string, number>();
  private static readonly MAX_STRIKES = 20;

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwtService: JwtService,
    private readonly access: MessagingAccessService,
  ) {}

  // Authentication runs as Socket.IO connection middleware, NOT in
  // handleConnection: calling socket.disconnect() inside handleConnection
  // happens AFTER the client has already received its 'connect' event
  // (the transport-level handshake completes before that hook runs) — a
  // real bug caught by this implementation's own smoke test, not a
  // theoretical concern. Middleware's next(new Error(...)) rejects the
  // connection before 'connect' ever fires client-side; the client gets
  // 'connect_error' instead, matching ADR-006 §3's "rejected before any
  // event handler runs."
  afterInit(server: Server): void {
    server.use((socket, next) => {
      const token = this.extractToken(socket);
      if (!token) {
        next(new Error('AUTHENTICATION_REQUIRED'));
        return;
      }
      try {
        const payload = this.jwtService.verify<AccessTokenPayload>(token);
        socket.data.user = payload;
        next();
      } catch {
        next(new Error('TOKEN_INVALID'));
      }
    });

    server.on('connection', (socket: Socket) => {
      // Every user's own account-level room, joined automatically once
      // middleware above has already verified auth — no authorization
      // check needed (a user may always subscribe to themselves).
      // Reserved for future cross-device events; no MVP event in this
      // gateway targets it yet (messaging-websocket.md §6).
      void socket.join(`user:${(socket.data.user as AccessTokenPayload).sub}`);
    });
  }

  handleDisconnect(socket: Socket): void {
    this.strikes.delete(socket.id);
  }

  @SubscribeMessage('conversation.join')
  async handleJoin(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): Promise<WsAck> {
    const user = this.requireUser(socket);
    if (!user) {
      return { ok: false, error: { code: 'AUTHENTICATION_REQUIRED', message: 'Not authenticated.' } };
    }

    const conversationId = this.extractConversationId(body);
    if (!conversationId) {
      this.strike(socket);
      return { ok: false, error: { code: 'VALIDATION_FAILED', message: 'conversationId is required.' } };
    }

    const allowed = await this.access.canAccessConversation(user.sub, conversationId);
    if (!allowed) {
      return { ok: false, error: { code: 'RESOURCE_NOT_FOUND', message: 'Conversation not found.' } };
    }

    await socket.join(`conversation:${conversationId}`);
    return { ok: true };
  }

  @SubscribeMessage('conversation.leave')
  async handleLeave(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): Promise<WsAck> {
    const conversationId = this.extractConversationId(body);
    if (!conversationId) {
      // Leaving is naturally idempotent (messaging-websocket.md §7) —
      // malformed input here still isn't worth a strike, it's a no-op.
      return { ok: true };
    }
    await socket.leave(`conversation:${conversationId}`);
    return { ok: true };
  }

  // Called by MessagesService/ConversationsService after a REST write
  // commits. Never the other way around.
  emitToConversation(conversationId: string, event: string, payload: unknown): void {
    this.server.to(`conversation:${conversationId}`).emit(event, payload);
  }

  private requireUser(socket: Socket): AccessTokenPayload | null {
    return (socket.data.user as AccessTokenPayload | undefined) ?? null;
  }

  private extractConversationId(body: unknown): string | null {
    if (typeof body === 'object' && body !== null && typeof (body as { conversationId?: unknown }).conversationId === 'string') {
      return (body as { conversationId: string }).conversationId;
    }
    return null;
  }

  private strike(socket: Socket): void {
    const count = (this.strikes.get(socket.id) ?? 0) + 1;
    this.strikes.set(socket.id, count);
    if (count > MessagingGateway.MAX_STRIKES) {
      socket.emit('error', { code: 'TOO_MANY_INVALID_REQUESTS', message: 'Too many invalid requests.' });
      socket.disconnect(true);
    }
  }

  // Web: the afrilink_at HttpOnly cookie, sent automatically on the
  // handshake Upgrade request (ADR-006 §3) — parsed manually since
  // Socket.IO's handshake bypasses cookie-parser. Mobile (no shared
  // cookie jar): Socket.IO's own handshake `auth` payload — sent over the
  // already-established connection's initial frame, never a query string
  // or the URL, matching ADR-006 §4's constraints via Socket.IO's native
  // mechanism for exactly this rather than a custom post-connect event.
  private extractToken(socket: Socket): string | null {
    const cookieHeader = socket.handshake.headers.cookie;
    if (cookieHeader) {
      const cookies = parseCookieHeader(cookieHeader);
      if (cookies[ACCESS_COOKIE]) {
        return cookies[ACCESS_COOKIE];
      }
    }
    const authToken = socket.handshake.auth?.['accessToken'];
    return typeof authToken === 'string' ? authToken : null;
  }
}
