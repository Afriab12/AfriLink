import 'reflect-metadata';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { PrismaService } from '../src/common/prisma/prisma.service';

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

describe('Actions (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let moderatorRoleId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);

    const role = await prisma.role.upsert({
      where: { key: 'moderator' },
      update: {},
      create: { key: 'moderator', name: 'Moderator', description: 'test fixture' },
    });
    moderatorRoleId = role.id;
  });

  afterAll(async () => {
    await app.close();
  });

  async function registerUser(): Promise<{ userId: string; cookies: Record<string, string> }> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email: uniqueEmail(), password: 'correct-horse-battery-staple' })
      .expect(201);
    return { userId: res.body.data.user.id as string, cookies: extractCookies(res) };
  }

  async function registerModerator() {
    const u = await registerUser();
    await prisma.userRole.create({ data: { userId: u.userId, roleId: moderatorRoleId } });
    return u;
  }

  function auth(u: { cookies: Record<string, string> }) {
    return { Cookie: cookieHeader(u.cookies, 'afrilink_at', 'afrilink_csrf'), 'X-CSRF-Token': u.cookies['afrilink_csrf'] };
  }

  async function makeCase() {
    return prisma.case.create({ data: { queue: 'content', source: 'user_report' } });
  }

  async function makePost(authorId: string) {
    return prisma.post.create({ data: { authorId, body: 'hello world' } });
  }

  it('rejects an unauthenticated request with 401', async () => {
    const kase = await makeCase();
    await request(app.getHttpServer())
      .post(`/api/v1/moderation/cases/${kase.id}/actions`)
      .send({ actionType: 'warn_user', targetType: 'profile', targetId: randomUUID(), reasonCode: 'spam' })
      .expect(401);
  });

  it('rejects a non-moderator with 403', async () => {
    const user = await registerUser();
    const kase = await makeCase();
    const res = await request(app.getHttpServer())
      .post(`/api/v1/moderation/cases/${kase.id}/actions`)
      .set(auth(user))
      .send({ actionType: 'warn_user', targetType: 'profile', targetId: randomUUID(), reasonCode: 'spam' })
      .expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('rejects a mutation without a CSRF header with 403', async () => {
    const moderator = await registerModerator();
    const kase = await makeCase();
    await request(app.getHttpServer())
      .post(`/api/v1/moderation/cases/${kase.id}/actions`)
      .set('Cookie', cookieHeader(moderator.cookies, 'afrilink_at', 'afrilink_csrf'))
      .send({ actionType: 'warn_user', targetType: 'profile', targetId: randomUUID(), reasonCode: 'spam' })
      .expect(403);
  });

  it('a moderator can create a warn_user action, 201, correct envelope', async () => {
    const moderator = await registerModerator();
    const target = await registerUser();
    const kase = await makeCase();

    const res = await request(app.getHttpServer())
      .post(`/api/v1/moderation/cases/${kase.id}/actions`)
      .set(auth(moderator))
      .send({ actionType: 'warn_user', targetType: 'profile', targetId: target.userId, reasonCode: 'spam' })
      .expect(201);

    expect(res.body.data.actionType).toBe('warn_user');
    expect(res.body.data.caseId).toBe(kase.id);
    expect(res.body.data.sanctionId).toBeUndefined();
  });

  it('a moderator can remove a post, sets ContentStatus.removed', async () => {
    const moderator = await registerModerator();
    const author = await registerUser();
    const post = await makePost(author.userId);
    const kase = await makeCase();

    await request(app.getHttpServer())
      .post(`/api/v1/moderation/cases/${kase.id}/actions`)
      .set(auth(moderator))
      .send({ actionType: 'remove_content', targetType: 'post', targetId: post.id, reasonCode: 'spam' })
      .expect(201);

    const reloaded = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(reloaded.status).toBe('removed');
  });

  it('rejects a share target for remove_content with 422 POLICY_REJECTED', async () => {
    const moderator = await registerModerator();
    const author = await registerUser();
    const post = await makePost(author.userId);
    const share = await prisma.share.create({ data: { userId: author.userId, postId: post.id } });
    const kase = await makeCase();

    const res = await request(app.getHttpServer())
      .post(`/api/v1/moderation/cases/${kase.id}/actions`)
      .set(auth(moderator))
      .send({ actionType: 'remove_content', targetType: 'share', targetId: share.id, reasonCode: 'spam' })
      .expect(422);
    expect(res.body.error.code).toBe('POLICY_REJECTED');
  });

  it('rejects a moderator banning themselves with 403', async () => {
    const moderator = await registerModerator();
    const kase = await makeCase();
    const res = await request(app.getHttpServer())
      .post(`/api/v1/moderation/cases/${kase.id}/actions`)
      .set(auth(moderator))
      .send({ actionType: 'ban_account', targetType: 'profile', targetId: moderator.userId, reasonCode: 'spam' })
      .expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('a moderator can ban a target account: sanctionId present, User.status banned', async () => {
    const moderator = await registerModerator();
    const target = await registerUser();
    const kase = await makeCase();

    const res = await request(app.getHttpServer())
      .post(`/api/v1/moderation/cases/${kase.id}/actions`)
      .set(auth(moderator))
      .send({ actionType: 'ban_account', targetType: 'profile', targetId: target.userId, reasonCode: 'harassment' })
      .expect(201);

    expect(res.body.data.sanctionId).toBeDefined();
    const user = await prisma.user.findUniqueOrThrow({ where: { id: target.userId } });
    expect(user.status).toBe('banned');
  });

  it('rejects a nonexistent case with 404', async () => {
    const moderator = await registerModerator();
    const target = await registerUser();
    const res = await request(app.getHttpServer())
      .post(`/api/v1/moderation/cases/${randomUUID()}/actions`)
      .set(auth(moderator))
      .send({ actionType: 'warn_user', targetType: 'profile', targetId: target.userId, reasonCode: 'spam' })
      .expect(404);
    expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('actions remain allowed on a closed case', async () => {
    const moderator = await registerModerator();
    const target = await registerUser();
    const kase = await makeCase();
    await request(app.getHttpServer()).post(`/api/v1/moderation/cases/${kase.id}/close`).set(auth(moderator)).expect(200);

    await request(app.getHttpServer())
      .post(`/api/v1/moderation/cases/${kase.id}/actions`)
      .set(auth(moderator))
      .send({ actionType: 'warn_user', targetType: 'profile', targetId: target.userId, reasonCode: 'spam' })
      .expect(201);
  });

  it('the created action appears in GET /moderation/cases/{caseId} with a real actions array', async () => {
    const moderator = await registerModerator();
    const target = await registerUser();
    const kase = await makeCase();

    const created = await request(app.getHttpServer())
      .post(`/api/v1/moderation/cases/${kase.id}/actions`)
      .set(auth(moderator))
      .send({ actionType: 'ban_account', targetType: 'profile', targetId: target.userId, reasonCode: 'harassment' })
      .expect(201);

    const detail = await request(app.getHttpServer()).get(`/api/v1/moderation/cases/${kase.id}`).set(auth(moderator)).expect(200);
    expect(detail.body.data.actions).toHaveLength(1);
    expect(detail.body.data.actions[0].id).toBe(created.body.data.id);
    expect(detail.body.data.actions[0].sanctionId).toBe(created.body.data.sanctionId);
  });
});
