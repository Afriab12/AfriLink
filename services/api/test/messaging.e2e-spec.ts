import 'reflect-metadata';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { ACCESS_COOKIE } from '../src/auth/cookies.util';

function extractCookies(res: request.Response): Record<string, string> {
  const setCookie = res.headers['set-cookie'];
  const list: string[] = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const cookies: Record<string, string> = {};
  for (const raw of list) {
    const [pair] = raw.split(';');
    const [name, value] = pair.split('=');
    cookies[name] = value;
  }
  return cookies;
}

function cookieHeader(cookies: Record<string, string>, ...names: string[]): string {
  return names
    .filter((n) => cookies[n] !== undefined)
    .map((n) => `${n}=${cookies[n]}`)
    .join('; ');
}

function uniqueEmail(): string {
  return `test-${randomUUID()}@example.com`;
}

// WebSocket tests need a real bound port (unlike supertest, which injects
// requests without one) — socket.io-client makes real network
// connections. REST calls in this file still go through
// request(app.getHttpServer()), same as every other e2e spec; only the
// WS sections need `baseUrl`.
describe('Messaging (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let baseUrl: string;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0);
    const address = app.getHttpServer().address();
    const port = typeof address === 'object' && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    for (const socket of sockets.splice(0)) {
      socket.close();
    }
  });

  async function registerUser(): Promise<{ userId: string; cookies: Record<string, string> }> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email: uniqueEmail(), password: 'correct-horse-battery-staple' })
      .expect(201);
    return { userId: res.body.data.user.id as string, cookies: extractCookies(res) };
  }

  function auth(u: { cookies: Record<string, string> }) {
    return { Cookie: cookieHeader(u.cookies, 'afrilink_at', 'afrilink_csrf'), 'X-CSRF-Token': u.cookies['afrilink_csrf'] };
  }

  async function makeFriends(a: { userId: string }, b: { userId: string }): Promise<void> {
    await prisma.friendship.create({
      data: { requesterId: a.userId, addresseeId: b.userId, status: 'accepted', respondedAt: new Date() },
    });
  }

  function connectSocket(u: { cookies: Record<string, string> }): Socket {
    const socket = io(`${baseUrl}/messaging`, {
      extraHeaders: { Cookie: cookieHeader(u.cookies, ACCESS_COOKIE) },
      transports: ['websocket'],
      forceNew: true,
    });
    sockets.push(socket);
    return socket;
  }

  function waitForConnect(socket: Socket): Promise<void> {
    return new Promise((resolve, reject) => {
      socket.on('connect', () => resolve());
      socket.on('connect_error', (err: Error) => reject(err));
      setTimeout(() => reject(new Error('connect timeout')), 4000);
    });
  }

  function waitForConnectError(socket: Socket): Promise<Error> {
    return new Promise((resolve, reject) => {
      socket.on('connect_error', (err: Error) => resolve(err));
      socket.on('connect', () => reject(new Error('expected connect_error, got connect')));
      setTimeout(() => reject(new Error('connect_error timeout')), 4000);
    });
  }

  // ============================================================
  // REST: Conversations
  // ============================================================

  describe('Conversations', () => {
    it('starting a conversation with a non-connection creates it as pending', async () => {
      const a = await registerUser();
      const b = await registerUser();
      const res = await request(app.getHttpServer())
        .post('/api/v1/conversations')
        .set(auth(a))
        .send({ recipientUserId: b.userId })
        .expect(201);
      expect(res.body.data.status).toBe('pending');
      expect(res.body.data.createdBy).toBe(a.userId);
    });

    it('starting a conversation with an accepted friend skips the request gate (starts accepted)', async () => {
      const a = await registerUser();
      const b = await registerUser();
      await makeFriends(a, b);
      const res = await request(app.getHttpServer())
        .post('/api/v1/conversations')
        .set(auth(a))
        .send({ recipientUserId: b.userId })
        .expect(201);
      expect(res.body.data.status).toBe('accepted');
    });

    it('creating a conversation twice for the same pair is idempotent', async () => {
      const a = await registerUser();
      const b = await registerUser();
      const first = await request(app.getHttpServer()).post('/api/v1/conversations').set(auth(a)).send({ recipientUserId: b.userId }).expect(201);
      const second = await request(app.getHttpServer()).post('/api/v1/conversations').set(auth(b)).send({ recipientUserId: a.userId }).expect(201);
      expect(second.body.data.id).toBe(first.body.data.id);
    });

    it('rejects starting a conversation with yourself', async () => {
      const a = await registerUser();
      await request(app.getHttpServer()).post('/api/v1/conversations').set(auth(a)).send({ recipientUserId: a.userId }).expect(422);
    });

    it('rejects starting a conversation with a blocked user', async () => {
      const a = await registerUser();
      const b = await registerUser();
      await request(app.getHttpServer()).post(`/api/v1/users/${b.userId}/block`).set(auth(a)).expect(201);
      await request(app.getHttpServer()).post('/api/v1/conversations').set(auth(a)).send({ recipientUserId: b.userId }).expect(404);
    });

    it('only a participant can get a conversation; a non-participant gets 404', async () => {
      const a = await registerUser();
      const b = await registerUser();
      const stranger = await registerUser();
      const created = await request(app.getHttpServer()).post('/api/v1/conversations').set(auth(a)).send({ recipientUserId: b.userId }).expect(201);

      await request(app.getHttpServer()).get(`/api/v1/conversations/${created.body.data.id}`).set(auth(a)).expect(200);
      await request(app.getHttpServer()).get(`/api/v1/conversations/${created.body.data.id}`).set(auth(stranger)).expect(404);
    });

    it('lists my conversations with cursor pagination', async () => {
      const a = await registerUser();
      const partners = [await registerUser(), await registerUser(), await registerUser()];
      for (const p of partners) {
        await request(app.getHttpServer()).post('/api/v1/conversations').set(auth(a)).send({ recipientUserId: p.userId }).expect(201);
      }
      const page1 = await request(app.getHttpServer()).get('/api/v1/conversations?limit=2').set(auth(a)).expect(200);
      expect(page1.body.data).toHaveLength(2);
      expect(page1.body.meta.page.hasMore).toBe(true);
    });

    // ---- List ordering: by last_message_at (descending), the inbox order ----
    // The conversation list is ordered by most recent message, with
    // conversations that have no messages yet after every conversation that
    // has one, and id (UUIDv7, time-ordered) as the tie-breaker. The cursor
    // carries that same (last_message_at, id) key.
    describe('list ordering by last_message_at', () => {
      type ConvUser = { userId: string; cookies: Record<string, string> };

      async function startConversation(from: ConvUser, to: ConvUser): Promise<string> {
        const res = await request(app.getHttpServer())
          .post('/api/v1/conversations')
          .set(auth(from))
          .send({ recipientUserId: to.userId })
          .expect(201);
        return res.body.data.id as string;
      }

      // The initiator may send while a conversation is still pending.
      async function say(from: ConvUser, conversationId: string): Promise<void> {
        await request(app.getHttpServer())
          .post(`/api/v1/conversations/${conversationId}/messages`)
          .set(auth(from))
          .send({ body: 'hi', clientMessageId: randomUUID() })
          .expect(201);
      }

      async function listIds(u: ConvUser, query = ''): Promise<string[]> {
        const res = await request(app.getHttpServer()).get(`/api/v1/conversations${query}`).set(auth(u)).expect(200);
        return res.body.data.map((c: { id: string }) => c.id);
      }

      async function walkAllPages(u: ConvUser, limit: number): Promise<string[]> {
        const seen: string[] = [];
        let cursor: string | null = null;
        for (let guard = 0; guard < 20; guard++) {
          const qs: string = `?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
          const res: request.Response = await request(app.getHttpServer()).get(`/api/v1/conversations${qs}`).set(auth(u)).expect(200);
          seen.push(...res.body.data.map((c: { id: string }) => c.id));
          if (!res.body.meta.page.hasMore) {
            return seen;
          }
          cursor = res.body.meta.page.nextCursor as string;
        }
        throw new Error('pagination did not terminate');
      }

      it('orders by most recent message, and new activity moves a conversation to the top', async () => {
        const a = await registerUser();
        const [p1, p2, p3] = [await registerUser(), await registerUser(), await registerUser()];
        const c1 = await startConversation(a, p1);
        const c2 = await startConversation(a, p2);
        const c3 = await startConversation(a, p3);

        await say(a, c1);
        await say(a, c2);
        await say(a, c3);
        expect(await listIds(a)).toEqual([c3, c2, c1]);

        await say(a, c1); // fresh activity in the oldest conversation
        expect(await listIds(a)).toEqual([c1, c3, c2]);

        const res = await request(app.getHttpServer()).get('/api/v1/conversations').set(auth(a)).expect(200);
        const stamps: number[] = res.body.data.map((c: { lastMessageAt: string }) => new Date(c.lastMessageAt).getTime());
        expect(stamps).toEqual([...stamps].sort((x, y) => y - x));
      });

      it('lists conversations with no messages after every conversation that has one, regardless of creation order', async () => {
        const a = await registerUser();
        const [p1, p2, p3] = [await registerUser(), await registerUser(), await registerUser()];
        const messaged = await startConversation(a, p1); // created FIRST
        const emptyOlder = await startConversation(a, p2);
        const emptyNewer = await startConversation(a, p3);
        await say(a, messaged);

        expect(await listIds(a)).toEqual([messaged, emptyNewer, emptyOlder]);
      });

      it('paginates across the messaged/empty boundary without skipping or duplicating', async () => {
        const a = await registerUser();
        const partners = [await registerUser(), await registerUser(), await registerUser(), await registerUser(), await registerUser()];
        const ids: string[] = [];
        for (const p of partners) {
          ids.push(await startConversation(a, p));
        }
        // Message three of the five, in a deliberately non-creation order.
        await say(a, ids[1]);
        await say(a, ids[3]);
        await say(a, ids[0]);

        const expected = [ids[0], ids[3], ids[1], ids[4], ids[2]]; // messaged newest-first, then empty newest-created-first
        expect(await listIds(a)).toEqual(expected);
        expect(await walkAllPages(a, 1)).toEqual(expected);
        expect(await walkAllPages(a, 2)).toEqual(expected);
      });

      it('breaks last_message_at ties by id so pagination stays stable', async () => {
        const a = await registerUser();
        const partners = [await registerUser(), await registerUser(), await registerUser(), await registerUser()];
        const ids: string[] = [];
        for (const p of partners) {
          const id = await startConversation(a, p);
          await say(a, id);
          ids.push(id);
        }
        const sameInstant = new Date('2030-01-01T00:00:00.000Z');
        await prisma.conversation.updateMany({ where: { id: { in: ids } }, data: { lastMessageAt: sameInstant } });

        const expected = [...ids].sort().reverse(); // UUIDv7 ids sort in creation order
        expect(await walkAllPages(a, 1)).toEqual(expected);
        expect(await walkAllPages(a, 3)).toEqual(expected);
      });

      it('shows the same recency ordering to the recipient', async () => {
        const a = await registerUser();
        const b = await registerUser();
        const [p2, p3] = [await registerUser(), await registerUser()];
        const withB = await startConversation(a, b);
        const other2 = await startConversation(p2, b);
        const other3 = await startConversation(p3, b);
        await say(a, withB);
        await say(p3, other3);
        await say(p2, other2);
        await say(a, withB);

        expect(await listIds(b)).toEqual([withB, other2, other3]);
      });

      it('rejects malformed and legacy (createdAt-shaped) cursors with INVALID_CURSOR', async () => {
        const a = await registerUser();
        const garbage = await request(app.getHttpServer()).get('/api/v1/conversations?cursor=not-a-real-cursor!!').set(auth(a)).expect(400);
        expect(garbage.body.error.code).toBe('INVALID_CURSOR');

        const legacy = Buffer.from(JSON.stringify({ createdAt: new Date().toISOString(), id: randomUUID() })).toString('base64url');
        const res = await request(app.getHttpServer()).get(`/api/v1/conversations?cursor=${legacy}`).set(auth(a)).expect(400);
        expect(res.body.error.code).toBe('INVALID_CURSOR');
      });

      it('last_message_at only ever moves forward, even if a send lands after a newer one', async () => {
        const a = await registerUser();
        const b = await registerUser();
        const id = await startConversation(a, b);
        await say(a, id);

        // Simulate a newer send from the other participant having already
        // committed its update (the concurrent-send interleaving).
        const newer = new Date(Date.now() + 60 * 60 * 1000);
        await prisma.conversation.update({ where: { id }, data: { lastMessageAt: newer } });

        await say(a, id); // this message's timestamp is OLDER than `newer`
        const row = await prisma.conversation.findUnique({ where: { id } });
        expect(row?.lastMessageAt?.getTime()).toBe(newer.getTime());
      });
    });

    it('only the recipient may accept or decline a pending request', async () => {
      const a = await registerUser();
      const b = await registerUser();
      const created = await request(app.getHttpServer()).post('/api/v1/conversations').set(auth(a)).send({ recipientUserId: b.userId }).expect(201);

      await request(app.getHttpServer()).post(`/api/v1/conversations/${created.body.data.id}/accept`).set(auth(a)).expect(422);
      const accepted = await request(app.getHttpServer()).post(`/api/v1/conversations/${created.body.data.id}/accept`).set(auth(b)).expect(200);
      expect(accepted.body.data.status).toBe('accepted');
    });

    it('declining sets status to declined', async () => {
      const a = await registerUser();
      const b = await registerUser();
      const created = await request(app.getHttpServer()).post('/api/v1/conversations').set(auth(a)).send({ recipientUserId: b.userId }).expect(201);
      const declined = await request(app.getHttpServer()).post(`/api/v1/conversations/${created.body.data.id}/decline`).set(auth(b)).expect(200);
      expect(declined.body.data.status).toBe('declined');
    });

    it('requires authentication and CSRF to create a conversation', async () => {
      const b = await registerUser();
      await request(app.getHttpServer()).post('/api/v1/conversations').send({ recipientUserId: b.userId }).expect(401);

      const a = await registerUser();
      await request(app.getHttpServer())
        .post('/api/v1/conversations')
        .set('Cookie', cookieHeader(a.cookies, 'afrilink_at', 'afrilink_csrf'))
        .send({ recipientUserId: b.userId })
        .expect(403);
    });
  });

  // ============================================================
  // REST: Messages
  // ============================================================

  describe('Messages', () => {
    async function startAcceptedConversation() {
      const a = await registerUser();
      const b = await registerUser();
      await makeFriends(a, b);
      const created = await request(app.getHttpServer()).post('/api/v1/conversations').set(auth(a)).send({ recipientUserId: b.userId }).expect(201);
      return { a, b, conversationId: created.body.data.id as string };
    }

    it('sends and lists messages, cursor-paginated newest-first', async () => {
      const { a, conversationId } = await startAcceptedConversation();
      for (const body of ['first', 'second', 'third']) {
        await request(app.getHttpServer())
          .post(`/api/v1/conversations/${conversationId}/messages`)
          .set(auth(a))
          .send({ body, clientMessageId: randomUUID() })
          .expect(201);
      }
      const page = await request(app.getHttpServer()).get(`/api/v1/conversations/${conversationId}/messages?limit=2`).set(auth(a)).expect(200);
      expect(page.body.data).toHaveLength(2);
      expect(page.body.data[0].body).toBe('third');
      expect(page.body.meta.page.hasMore).toBe(true);
    });

    it('retried send with the same clientMessageId returns the original message, not a duplicate', async () => {
      const { a, conversationId } = await startAcceptedConversation();
      const clientMessageId = randomUUID();
      const first = await request(app.getHttpServer())
        .post(`/api/v1/conversations/${conversationId}/messages`)
        .set(auth(a))
        .send({ body: 'hello', clientMessageId })
        .expect(201);
      const retry = await request(app.getHttpServer())
        .post(`/api/v1/conversations/${conversationId}/messages`)
        .set(auth(a))
        .send({ body: 'hello', clientMessageId })
        .expect(201);
      expect(retry.body.data.id).toBe(first.body.data.id);
    });

    it('the recipient cannot send while the conversation is still pending; the initiator can', async () => {
      const a = await registerUser();
      const b = await registerUser();
      const created = await request(app.getHttpServer()).post('/api/v1/conversations').set(auth(a)).send({ recipientUserId: b.userId }).expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/conversations/${created.body.data.id}/messages`)
        .set(auth(b))
        .send({ body: 'not allowed yet', clientMessageId: randomUUID() })
        .expect(422);
      await request(app.getHttpServer())
        .post(`/api/v1/conversations/${created.body.data.id}/messages`)
        .set(auth(a))
        .send({ body: 'allowed as initiator', clientMessageId: randomUUID() })
        .expect(201);
    });

    it('sending is rejected once a conversation is declined', async () => {
      const a = await registerUser();
      const b = await registerUser();
      const created = await request(app.getHttpServer()).post('/api/v1/conversations').set(auth(a)).send({ recipientUserId: b.userId }).expect(201);
      await request(app.getHttpServer()).post(`/api/v1/conversations/${created.body.data.id}/decline`).set(auth(b)).expect(200);
      await request(app.getHttpServer())
        .post(`/api/v1/conversations/${created.body.data.id}/messages`)
        .set(auth(a))
        .send({ body: 'too late', clientMessageId: randomUUID() })
        .expect(422);
    });

    it('only the sender can update or delete their own message', async () => {
      const { a, b, conversationId } = await startAcceptedConversation();
      const sent = await request(app.getHttpServer())
        .post(`/api/v1/conversations/${conversationId}/messages`)
        .set(auth(a))
        .send({ body: 'original', clientMessageId: randomUUID() })
        .expect(201);

      await request(app.getHttpServer()).patch(`/api/v1/messages/${sent.body.data.id}`).set(auth(b)).send({ body: 'hijacked' }).expect(404);
      const updated = await request(app.getHttpServer())
        .patch(`/api/v1/messages/${sent.body.data.id}`)
        .set(auth(a))
        .send({ body: 'edited' })
        .expect(200);
      expect(updated.body.data.body).toBe('edited');
      expect(updated.body.data.editedAt).not.toBeNull();

      await request(app.getHttpServer()).delete(`/api/v1/messages/${sent.body.data.id}`).set(auth(b)).expect(404);
      await request(app.getHttpServer()).delete(`/api/v1/messages/${sent.body.data.id}`).set(auth(a)).expect(200);

      const list = await request(app.getHttpServer()).get(`/api/v1/conversations/${conversationId}/messages`).set(auth(a)).expect(200);
      expect(list.body.data.map((m: { id: string }) => m.id)).not.toContain(sent.body.data.id);
    });

    it('marking read updates the participant read cursor', async () => {
      const { a, b, conversationId } = await startAcceptedConversation();
      const sent = await request(app.getHttpServer())
        .post(`/api/v1/conversations/${conversationId}/messages`)
        .set(auth(a))
        .send({ body: 'read me', clientMessageId: randomUUID() })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/conversations/${conversationId}/read`)
        .set(auth(b))
        .send({ messageId: sent.body.data.id })
        .expect(200);

      const participant = await prisma.participant.findUnique({
        where: { conversationId_userId: { conversationId, userId: b.userId } },
      });
      expect(participant?.lastReadMessageId).toBe(sent.body.data.id);
    });

    // Regression: assertOwnsMessage used to check sender identity only, so a
    // sender who had lost access to the conversation (blocked either way,
    // left, or conversation soft-deleted) could still edit or delete their
    // own old messages. Every message action must go through the same
    // conversation-access rule (MessagingAccessService).
    describe('edit/delete requires conversation access, not just authorship', () => {
      async function sendOne() {
        const { a, b, conversationId } = await startAcceptedConversation();
        const sent = await request(app.getHttpServer())
          .post(`/api/v1/conversations/${conversationId}/messages`)
          .set(auth(a))
          .send({ body: 'original', clientMessageId: randomUUID() })
          .expect(201);
        return { a, b, conversationId, messageId: sent.body.data.id as string };
      }

      async function expectRejectedAndUntouched(sender: { cookies: Record<string, string> }, messageId: string) {
        await request(app.getHttpServer()).patch(`/api/v1/messages/${messageId}`).set(auth(sender)).send({ body: 'rewritten' }).expect(404);
        await request(app.getHttpServer()).delete(`/api/v1/messages/${messageId}`).set(auth(sender)).expect(404);
        const row = await prisma.message.findUniqueOrThrow({ where: { id: messageId } });
        expect(row.body).toBe('original');
        expect(row.editedAt).toBeNull();
        expect(row.deletedAt).toBeNull();
      }

      it('a sender who was blocked by the other participant cannot edit or delete their message', async () => {
        const { a, b, messageId } = await sendOne();
        await request(app.getHttpServer()).post(`/api/v1/users/${a.userId}/block`).set(auth(b)).expect(201);
        await expectRejectedAndUntouched(a, messageId);
      });

      it('a sender who blocked the other participant cannot edit or delete their message either', async () => {
        const { a, b, messageId } = await sendOne();
        await request(app.getHttpServer()).post(`/api/v1/users/${b.userId}/block`).set(auth(a)).expect(201);
        await expectRejectedAndUntouched(a, messageId);
      });

      it('a sender who left the conversation cannot edit or delete their message', async () => {
        const { a, conversationId, messageId } = await sendOne();
        // No REST endpoint for leaving exists yet; set the participant state directly.
        await prisma.participant.update({ where: { conversationId_userId: { conversationId, userId: a.userId } }, data: { leftAt: new Date() } });
        await expectRejectedAndUntouched(a, messageId);
      });

      it('nobody can edit or delete a message in a soft-deleted conversation', async () => {
        const { a, conversationId, messageId } = await sendOne();
        await prisma.conversation.update({ where: { id: conversationId }, data: { deletedAt: new Date() } });
        await expectRejectedAndUntouched(a, messageId);
      });

      it('an ordinary participant can still edit and delete (access check does not over-reject)', async () => {
        const { a, messageId } = await sendOne();
        await request(app.getHttpServer()).patch(`/api/v1/messages/${messageId}`).set(auth(a)).send({ body: 'fine' }).expect(200);
        await request(app.getHttpServer()).delete(`/api/v1/messages/${messageId}`).set(auth(a)).expect(200);
      });
    });

    it('blocking a participant hides the conversation and rejects further sends for both directions', async () => {
      const { a, b, conversationId } = await startAcceptedConversation();
      await request(app.getHttpServer()).post(`/api/v1/users/${b.userId}/block`).set(auth(a)).expect(201);

      await request(app.getHttpServer()).get(`/api/v1/conversations/${conversationId}`).set(auth(a)).expect(404);
      await request(app.getHttpServer()).get(`/api/v1/conversations/${conversationId}`).set(auth(b)).expect(404);
      await request(app.getHttpServer())
        .post(`/api/v1/conversations/${conversationId}/messages`)
        .set(auth(b))
        .send({ body: 'blocked', clientMessageId: randomUUID() })
        .expect(404);
    });
  });

  // ============================================================
  // WebSocket: connection auth
  // ============================================================

  describe('WebSocket connection authentication', () => {
    it('rejects a connection with no credential', async () => {
      const socket = connectSocket({ cookies: {} });
      const err = await waitForConnectError(socket);
      expect(err.message).toBe('AUTHENTICATION_REQUIRED');
    });

    it('rejects a connection with an invalid access token', async () => {
      const socket = io(`${baseUrl}/messaging`, {
        auth: { accessToken: 'not-a-real-jwt' },
        transports: ['websocket'],
        forceNew: true,
      });
      sockets.push(socket);
      const err = await waitForConnectError(socket);
      expect(err.message).toBe('TOKEN_INVALID');
    });

    it('accepts a connection authenticated via the afrilink_at cookie', async () => {
      const a = await registerUser();
      const socket = connectSocket(a);
      await expect(waitForConnect(socket)).resolves.toBeUndefined();
    });
  });

  // ============================================================
  // WebSocket: room join/leave authorization
  // ============================================================

  describe('WebSocket room join/leave authorization', () => {
    it('a participant can join their conversation room', async () => {
      const a = await registerUser();
      const b = await registerUser();
      await makeFriends(a, b);
      const created = await request(app.getHttpServer()).post('/api/v1/conversations').set(auth(a)).send({ recipientUserId: b.userId }).expect(201);

      const socket = connectSocket(a);
      await waitForConnect(socket);
      const ack = await socket.emitWithAck('conversation.join', { conversationId: created.body.data.id });
      expect(ack).toEqual({ ok: true });
    });

    it('a non-participant cannot join the conversation room', async () => {
      const a = await registerUser();
      const b = await registerUser();
      const stranger = await registerUser();
      await makeFriends(a, b);
      const created = await request(app.getHttpServer()).post('/api/v1/conversations').set(auth(a)).send({ recipientUserId: b.userId }).expect(201);

      const socket = connectSocket(stranger);
      await waitForConnect(socket);
      const ack = await socket.emitWithAck('conversation.join', { conversationId: created.body.data.id });
      expect(ack.ok).toBe(false);
      expect(ack.error.code).toBe('RESOURCE_NOT_FOUND');
    });

    it('a blocked participant loses room-join access', async () => {
      const a = await registerUser();
      const b = await registerUser();
      await makeFriends(a, b);
      const created = await request(app.getHttpServer()).post('/api/v1/conversations').set(auth(a)).send({ recipientUserId: b.userId }).expect(201);
      await request(app.getHttpServer()).post(`/api/v1/users/${b.userId}/block`).set(auth(a)).expect(201);

      const socket = connectSocket(b);
      await waitForConnect(socket);
      const ack = await socket.emitWithAck('conversation.join', { conversationId: created.body.data.id });
      expect(ack.ok).toBe(false);
    });

    it('leave acknowledges even for a room never joined (idempotent no-op)', async () => {
      const a = await registerUser();
      const socket = connectSocket(a);
      await waitForConnect(socket);
      const ack = await socket.emitWithAck('conversation.leave', { conversationId: randomUUID() });
      expect(ack).toEqual({ ok: true });
    });
  });

  // ============================================================
  // WebSocket: event broadcasting
  // ============================================================

  describe('WebSocket event broadcasting', () => {
    async function joinedPair() {
      const a = await registerUser();
      const b = await registerUser();
      await makeFriends(a, b);
      const created = await request(app.getHttpServer()).post('/api/v1/conversations').set(auth(a)).send({ recipientUserId: b.userId }).expect(201);
      const conversationId = created.body.data.id as string;

      const socketB = connectSocket(b);
      await waitForConnect(socketB);
      await socketB.emitWithAck('conversation.join', { conversationId });

      return { a, b, conversationId, socketB };
    }

    function waitForEvent<T = unknown>(socket: Socket, event: string): Promise<T> {
      return new Promise((resolve, reject) => {
        socket.once(event, (payload: T) => resolve(payload));
        setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), 4000);
      });
    }

    it('broadcasts message.accepted to joined participants when a message is sent', async () => {
      const { a, conversationId, socketB } = await joinedPair();
      const eventPromise = waitForEvent<{ id: string; body: string }>(socketB, 'message.accepted');

      const sent = await request(app.getHttpServer())
        .post(`/api/v1/conversations/${conversationId}/messages`)
        .set(auth(a))
        .send({ body: 'ws broadcast test', clientMessageId: randomUUID() })
        .expect(201);

      const event = await eventPromise;
      expect(event.id).toBe(sent.body.data.id);
      expect(event.body).toBe('ws broadcast test');
    });

    it('broadcasts message.updated when a message is edited', async () => {
      const { a, conversationId, socketB } = await joinedPair();
      const sent = await request(app.getHttpServer())
        .post(`/api/v1/conversations/${conversationId}/messages`)
        .set(auth(a))
        .send({ body: 'before edit', clientMessageId: randomUUID() })
        .expect(201);

      const eventPromise = waitForEvent<{ id: string; body: string }>(socketB, 'message.updated');
      await request(app.getHttpServer()).patch(`/api/v1/messages/${sent.body.data.id}`).set(auth(a)).send({ body: 'after edit' }).expect(200);

      const event = await eventPromise;
      expect(event.id).toBe(sent.body.data.id);
      expect(event.body).toBe('after edit');
    });

    it('broadcasts message.deleted when a message is deleted', async () => {
      const { a, conversationId, socketB } = await joinedPair();
      const sent = await request(app.getHttpServer())
        .post(`/api/v1/conversations/${conversationId}/messages`)
        .set(auth(a))
        .send({ body: 'to be deleted', clientMessageId: randomUUID() })
        .expect(201);

      const eventPromise = waitForEvent<{ id: string }>(socketB, 'message.deleted');
      await request(app.getHttpServer()).delete(`/api/v1/messages/${sent.body.data.id}`).set(auth(a)).expect(200);

      const event = await eventPromise;
      expect(event.id).toBe(sent.body.data.id);
    });

    // Regression companion to the REST tests above: a rejected edit/delete
    // must not reach the room. (The rejection happens before the emit.)
    it('a blocked sender\'s rejected edit and delete are not broadcast to the room', async () => {
      const { a, b, conversationId, socketB } = await joinedPair();
      const sent = await request(app.getHttpServer())
        .post(`/api/v1/conversations/${conversationId}/messages`)
        .set(auth(a))
        .send({ body: 'original', clientMessageId: randomUUID() })
        .expect(201);
      await request(app.getHttpServer()).post(`/api/v1/users/${a.userId}/block`).set(auth(b)).expect(201);

      const received: string[] = [];
      socketB.on('message.updated', () => received.push('message.updated'));
      socketB.on('message.deleted', () => received.push('message.deleted'));

      await request(app.getHttpServer()).patch(`/api/v1/messages/${sent.body.data.id}`).set(auth(a)).send({ body: 'rewritten' }).expect(404);
      await request(app.getHttpServer()).delete(`/api/v1/messages/${sent.body.data.id}`).set(auth(a)).expect(404);
      await new Promise((r) => setTimeout(r, 500)); // give any (buggy) emit time to arrive

      expect(received).toEqual([]);
    });

    it('broadcasts conversation.read when a participant marks a message read', async () => {
      const { a, b, conversationId, socketB } = await joinedPair();
      const sent = await request(app.getHttpServer())
        .post(`/api/v1/conversations/${conversationId}/messages`)
        .set(auth(a))
        .send({ body: 'read me too', clientMessageId: randomUUID() })
        .expect(201);

      const eventPromise = waitForEvent<{ userId: string; lastReadMessageId: string }>(socketB, 'conversation.read');
      await request(app.getHttpServer())
        .post(`/api/v1/conversations/${conversationId}/read`)
        .set(auth(b))
        .send({ messageId: sent.body.data.id })
        .expect(200);

      const event = await eventPromise;
      expect(event.userId).toBe(b.userId);
      expect(event.lastReadMessageId).toBe(sent.body.data.id);
    });
  });
});
