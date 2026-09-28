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

describe('Reports (e2e)', () => {
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

  async function grantModerator(userId: string) {
    await prisma.userRole.create({ data: { userId, roleId: moderatorRoleId } });
  }

  async function makePost(authorId: string) {
    return prisma.post.create({ data: { authorId, body: 'hello world' } });
  }

  function auth(u: { cookies: Record<string, string> }) {
    return { Cookie: cookieHeader(u.cookies, 'afrilink_at', 'afrilink_csrf'), 'X-CSRF-Token': u.cookies['afrilink_csrf'] };
  }

  // --------------------------------------------------------------- POST /reports

  it('creates a report, 201, correct envelope', async () => {
    const reporter = await registerUser();
    const author = await registerUser();
    const post = await makePost(author.userId);

    const res = await request(app.getHttpServer())
      .post('/api/v1/reports')
      .set(auth(reporter))
      .send({ targetType: 'post', targetId: post.id, reasonCode: 'spam' })
      .expect(201);

    expect(res.body.data.targetType).toBe('post');
    expect(res.body.data.status).toBe('open');
    expect(res.body.data.reporterUserId).toBeUndefined();
  });

  it('rejects an unauthenticated report creation with 401', async () => {
    await request(app.getHttpServer()).post('/api/v1/reports').send({ targetType: 'post', targetId: randomUUID(), reasonCode: 'spam' }).expect(401);
  });

  it('rejects a mutation without a CSRF header with 403', async () => {
    const reporter = await registerUser();
    await request(app.getHttpServer())
      .post('/api/v1/reports')
      .set('Cookie', cookieHeader(reporter.cookies, 'afrilink_at', 'afrilink_csrf'))
      .send({ targetType: 'post', targetId: randomUUID(), reasonCode: 'spam' })
      .expect(403);
  });

  it('rejects an invalid targetType with 422 VALIDATION_FAILED', async () => {
    const reporter = await registerUser();
    const res = await request(app.getHttpServer())
      .post('/api/v1/reports')
      .set(auth(reporter))
      .send({ targetType: 'not-a-type', targetId: randomUUID(), reasonCode: 'spam' })
      .expect(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects an invalid reasonCode with 422', async () => {
    const reporter = await registerUser();
    await request(app.getHttpServer())
      .post('/api/v1/reports')
      .set(auth(reporter))
      .send({ targetType: 'post', targetId: randomUUID(), reasonCode: 'not-a-reason' })
      .expect(422);
  });

  it('rejects a non-UUID targetId with 422', async () => {
    const reporter = await registerUser();
    await request(app.getHttpServer())
      .post('/api/v1/reports')
      .set(auth(reporter))
      .send({ targetType: 'post', targetId: 'not-a-uuid', reasonCode: 'spam' })
      .expect(422);
  });

  it('rejects a description over 1000 characters with 422', async () => {
    const reporter = await registerUser();
    await request(app.getHttpServer())
      .post('/api/v1/reports')
      .set(auth(reporter))
      .send({ targetType: 'post', targetId: randomUUID(), reasonCode: 'spam', description: 'x'.repeat(1001) })
      .expect(422);
  });

  it('rejects a self-report with 422 POLICY_REJECTED', async () => {
    const reporter = await registerUser();
    const res = await request(app.getHttpServer())
      .post('/api/v1/reports')
      .set(auth(reporter))
      .send({ targetType: 'profile', targetId: reporter.userId, reasonCode: 'spam' })
      .expect(422);
    expect(res.body.error.code).toBe('POLICY_REJECTED');
  });

  it('rejects a nonexistent target with 404 RESOURCE_NOT_FOUND', async () => {
    const reporter = await registerUser();
    const res = await request(app.getHttpServer())
      .post('/api/v1/reports')
      .set(auth(reporter))
      .send({ targetType: 'post', targetId: randomUUID(), reasonCode: 'spam' })
      .expect(404);
    expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('rejects a same-reporter active duplicate with 409 CONFLICT', async () => {
    const reporter = await registerUser();
    const author = await registerUser();
    const post = await makePost(author.userId);
    await request(app.getHttpServer()).post('/api/v1/reports').set(auth(reporter)).send({ targetType: 'post', targetId: post.id, reasonCode: 'spam' }).expect(201);

    const res = await request(app.getHttpServer())
      .post('/api/v1/reports')
      .set(auth(reporter))
      .send({ targetType: 'post', targetId: post.id, reasonCode: 'spam' })
      .expect(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('allows a different reporter to independently report the same target', async () => {
    const reporter1 = await registerUser();
    const reporter2 = await registerUser();
    const author = await registerUser();
    const post = await makePost(author.userId);
    await request(app.getHttpServer()).post('/api/v1/reports').set(auth(reporter1)).send({ targetType: 'post', targetId: post.id, reasonCode: 'spam' }).expect(201);

    await request(app.getHttpServer()).post('/api/v1/reports').set(auth(reporter2)).send({ targetType: 'post', targetId: post.id, reasonCode: 'spam' }).expect(201);
  });

  // --------------------------------------------------------------- GET /me/reports

  it('rejects unauthenticated /me/reports with 401', async () => {
    await request(app.getHttpServer()).get('/api/v1/me/reports').expect(401);
  });

  it('returns only the caller\'s own reports', async () => {
    const reporter = await registerUser();
    const other = await registerUser();
    const author = await registerUser();
    const post = await makePost(author.userId);
    await request(app.getHttpServer()).post('/api/v1/reports').set(auth(other)).send({ targetType: 'post', targetId: post.id, reasonCode: 'spam' }).expect(201);
    const mine = await request(app.getHttpServer())
      .post('/api/v1/reports')
      .set(auth(reporter))
      .send({ targetType: 'post', targetId: post.id, reasonCode: 'spam' })
      .expect(201);

    const res = await request(app.getHttpServer()).get('/api/v1/me/reports').set(auth(reporter)).expect(200);
    expect(res.body.data.map((r: { id: string }) => r.id)).toEqual([mine.body.data.id]);
    expect(res.body.meta.page).toBeDefined();
  });

  // --------------------------------------------------------------- GET /reports/{id}

  it('returns own report to its reporter', async () => {
    const reporter = await registerUser();
    const author = await registerUser();
    const post = await makePost(author.userId);
    const created = await request(app.getHttpServer())
      .post('/api/v1/reports')
      .set(auth(reporter))
      .send({ targetType: 'post', targetId: post.id, reasonCode: 'spam' })
      .expect(201);

    const res = await request(app.getHttpServer()).get(`/api/v1/reports/${created.body.data.id}`).set(auth(reporter)).expect(200);
    expect(res.body.data.id).toBe(created.body.data.id);
  });

  it("rejects another user's report with 404", async () => {
    const reporter = await registerUser();
    const stranger = await registerUser();
    const author = await registerUser();
    const post = await makePost(author.userId);
    const created = await request(app.getHttpServer())
      .post('/api/v1/reports')
      .set(auth(reporter))
      .send({ targetType: 'post', targetId: post.id, reasonCode: 'spam' })
      .expect(201);

    const res = await request(app.getHttpServer()).get(`/api/v1/reports/${created.body.data.id}`).set(auth(stranger)).expect(404);
    expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('a moderator can retrieve any report', async () => {
    const reporter = await registerUser();
    const moderator = await registerUser();
    await grantModerator(moderator.userId);
    const author = await registerUser();
    const post = await makePost(author.userId);
    const created = await request(app.getHttpServer())
      .post('/api/v1/reports')
      .set(auth(reporter))
      .send({ targetType: 'post', targetId: post.id, reasonCode: 'spam' })
      .expect(201);

    await request(app.getHttpServer()).get(`/api/v1/reports/${created.body.data.id}`).set(auth(moderator)).expect(200);
  });

  it('a nonexistent report returns the identical 404 shape as an unauthorized one', async () => {
    const stranger = await registerUser();
    const res = await request(app.getHttpServer()).get(`/api/v1/reports/${randomUUID()}`).set(auth(stranger)).expect(404);
    expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
  });

  // --------------------------------------------------------------- GET /moderation/reports

  it('rejects a non-moderator on the moderation queue with 403', async () => {
    const user = await registerUser();
    const res = await request(app.getHttpServer()).get('/api/v1/moderation/reports').set(auth(user)).expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('allows a moderator to list the queue, exposing reporterUserId', async () => {
    const moderator = await registerUser();
    await grantModerator(moderator.userId);
    const reporter = await registerUser();
    const author = await registerUser();
    const post = await makePost(author.userId);
    const created = await request(app.getHttpServer())
      .post('/api/v1/reports')
      .set(auth(reporter))
      .send({ targetType: 'post', targetId: post.id, reasonCode: 'spam' })
      .expect(201);

    const res = await request(app.getHttpServer()).get('/api/v1/moderation/reports').set(auth(moderator)).expect(200);
    const row = res.body.data.find((r: { id: string }) => r.id === created.body.data.id);
    expect(row.reporterUserId).toBe(reporter.userId);
  });

  it('the moderation queue filters by status/priority/targetType/reasonCode', async () => {
    const moderator = await registerUser();
    await grantModerator(moderator.userId);
    const reporter = await registerUser();
    const author = await registerUser();
    const post = await makePost(author.userId);
    const created = await request(app.getHttpServer())
      .post('/api/v1/reports')
      .set(auth(reporter))
      .send({ targetType: 'post', targetId: post.id, reasonCode: 'harassment' })
      .expect(201);

    const matching = await request(app.getHttpServer())
      .get('/api/v1/moderation/reports?status=open&targetType=post&reasonCode=harassment')
      .set(auth(moderator))
      .expect(200);
    expect(matching.body.data.some((r: { id: string }) => r.id === created.body.data.id)).toBe(true);

    const nonMatching = await request(app.getHttpServer()).get('/api/v1/moderation/reports?reasonCode=spam').set(auth(moderator)).expect(200);
    expect(nonMatching.body.data.some((r: { id: string }) => r.id === created.body.data.id)).toBe(false);
  });
});
