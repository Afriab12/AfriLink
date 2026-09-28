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

describe('Cases (e2e)', () => {
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

  async function registerModerator() {
    const u = await registerUser();
    await grantModerator(u.userId);
    return u;
  }

  function auth(u: { cookies: Record<string, string> }) {
    return { Cookie: cookieHeader(u.cookies, 'afrilink_at', 'afrilink_csrf'), 'X-CSRF-Token': u.cookies['afrilink_csrf'] };
  }

  async function createReportDirect(reporterUserId: string, reasonCode = 'spam'): Promise<string> {
    const author = await registerUser();
    const post = await prisma.post.create({ data: { authorId: author.userId, body: 'hi' } });
    const report = await prisma.report.create({
      data: { reporterUserId, targetType: 'post', targetId: post.id, reasonCode: reasonCode as never, dedupKey: randomUUID() },
    });
    return report.id;
  }

  // ---------------------------------------------------------------- authz

  it('rejects a non-moderator on every case route with 403', async () => {
    const user = await registerUser();
    await request(app.getHttpServer()).get('/api/v1/moderation/cases').set(auth(user)).expect(403);
    await request(app.getHttpServer()).get(`/api/v1/moderation/cases/${randomUUID()}`).set(auth(user)).expect(403);
    await request(app.getHttpServer()).post('/api/v1/moderation/cases').set(auth(user)).send({ reportIds: [], queue: 'platform', source: 'user_report' }).expect(403);
  });

  // --------------------------------------------------------------- creation

  it('creates a case with one report, links it, transitions it to under_review', async () => {
    const moderator = await registerModerator();
    const reportId = await createReportDirect(moderator.userId);

    const res = await request(app.getHttpServer())
      .post('/api/v1/moderation/cases')
      .set(auth(moderator))
      .send({ reportIds: [reportId], queue: 'platform', source: 'user_report' })
      .expect(201);

    expect(res.body.data.reportCount).toBe(1);
    expect(res.body.data.reports[0].id).toBe(reportId);
    expect(res.body.data.actions).toEqual([]);

    const report = await prisma.report.findUniqueOrThrow({ where: { id: reportId } });
    expect(report.status).toBe('under_review');
  });

  it('creates a case with multiple reports', async () => {
    const moderator = await registerModerator();
    const r1 = await createReportDirect(moderator.userId);
    const r2 = await createReportDirect(moderator.userId);

    const res = await request(app.getHttpServer())
      .post('/api/v1/moderation/cases')
      .set(auth(moderator))
      .send({ reportIds: [r1, r2], queue: 'platform', source: 'user_report' })
      .expect(201);

    expect(res.body.data.reportCount).toBe(2);
  });

  it('rejects an already-cased report with 409', async () => {
    const moderator = await registerModerator();
    const reportId = await createReportDirect(moderator.userId);
    await request(app.getHttpServer())
      .post('/api/v1/moderation/cases')
      .set(auth(moderator))
      .send({ reportIds: [reportId], queue: 'platform', source: 'user_report' })
      .expect(201);

    const other = await createReportDirect(moderator.userId);
    const res = await request(app.getHttpServer())
      .post('/api/v1/moderation/cases')
      .set(auth(moderator))
      .send({ reportIds: [reportId, other], queue: 'platform', source: 'user_report' })
      .expect(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('rejects a closed report with 409', async () => {
    const moderator = await registerModerator();
    const reportId = await createReportDirect(moderator.userId);
    await prisma.report.update({ where: { id: reportId }, data: { status: 'closed' } });

    await request(app.getHttpServer())
      .post('/api/v1/moderation/cases')
      .set(auth(moderator))
      .send({ reportIds: [reportId], queue: 'platform', source: 'user_report' })
      .expect(409);
  });

  it('rejects a nonexistent reportId with 404', async () => {
    const moderator = await registerModerator();
    await request(app.getHttpServer())
      .post('/api/v1/moderation/cases')
      .set(auth(moderator))
      .send({ reportIds: [randomUUID()], queue: 'platform', source: 'user_report' })
      .expect(404);
  });

  it('rejects a mutation without CSRF with 403', async () => {
    const moderator = await registerModerator();
    const reportId = await createReportDirect(moderator.userId);
    await request(app.getHttpServer())
      .post('/api/v1/moderation/cases')
      .set('Cookie', cookieHeader(moderator.cookies, 'afrilink_at', 'afrilink_csrf'))
      .send({ reportIds: [reportId], queue: 'platform', source: 'user_report' })
      .expect(403);
  });

  // -------------------------------------------------------------------- read

  it('gets case detail with linked reports', async () => {
    const moderator = await registerModerator();
    const reportId = await createReportDirect(moderator.userId);
    const created = await request(app.getHttpServer())
      .post('/api/v1/moderation/cases')
      .set(auth(moderator))
      .send({ reportIds: [reportId], queue: 'platform', source: 'user_report' })
      .expect(201);

    const res = await request(app.getHttpServer()).get(`/api/v1/moderation/cases/${created.body.data.id}`).set(auth(moderator)).expect(200);
    expect(res.body.data.reports).toHaveLength(1);
  });

  it('a nonexistent case returns 404', async () => {
    const moderator = await registerModerator();
    await request(app.getHttpServer()).get(`/api/v1/moderation/cases/${randomUUID()}`).set(auth(moderator)).expect(404);
  });

  it('lists cases with filters and cursor pagination', async () => {
    const moderator = await registerModerator();
    const reportId = await createReportDirect(moderator.userId);
    await request(app.getHttpServer())
      .post('/api/v1/moderation/cases')
      .set(auth(moderator))
      .send({ reportIds: [reportId], queue: 'content', priority: 'high', source: 'user_report' })
      .expect(201);

    const res = await request(app.getHttpServer()).get('/api/v1/moderation/cases?queue=content&priority=high').set(auth(moderator)).expect(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.meta.page).toBeDefined();
  });

  // ----------------------------------------------------------------- assign

  it('self-assigns a case', async () => {
    const moderator = await registerModerator();
    const reportId = await createReportDirect(moderator.userId);
    const created = await request(app.getHttpServer())
      .post('/api/v1/moderation/cases')
      .set(auth(moderator))
      .send({ reportIds: [reportId], queue: 'platform', source: 'user_report' })
      .expect(201);

    const res = await request(app.getHttpServer()).post(`/api/v1/moderation/cases/${created.body.data.id}/assign`).set(auth(moderator)).send({}).expect(200);
    expect(res.body.data.assignedModeratorId).toBe(moderator.userId);
    expect(res.body.data.status).toBe('in_review');
  });

  it('assigns to another moderator', async () => {
    const moderator = await registerModerator();
    const target = await registerModerator();
    const reportId = await createReportDirect(moderator.userId);
    const created = await request(app.getHttpServer())
      .post('/api/v1/moderation/cases')
      .set(auth(moderator))
      .send({ reportIds: [reportId], queue: 'platform', source: 'user_report' })
      .expect(201);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/moderation/cases/${created.body.data.id}/assign`)
      .set(auth(moderator))
      .send({ moderatorId: target.userId })
      .expect(200);
    expect(res.body.data.assignedModeratorId).toBe(target.userId);
  });

  it('rejects assigning to a non-moderator target', async () => {
    const moderator = await registerModerator();
    const nonModerator = await registerUser();
    const reportId = await createReportDirect(moderator.userId);
    const created = await request(app.getHttpServer())
      .post('/api/v1/moderation/cases')
      .set(auth(moderator))
      .send({ reportIds: [reportId], queue: 'platform', source: 'user_report' })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/api/v1/moderation/cases/${created.body.data.id}/assign`)
      .set(auth(moderator))
      .send({ moderatorId: nonModerator.userId })
      .expect(422);
  });

  it('rejects assigning a closed case with 409', async () => {
    const moderator = await registerModerator();
    const reportId = await createReportDirect(moderator.userId);
    const created = await request(app.getHttpServer())
      .post('/api/v1/moderation/cases')
      .set(auth(moderator))
      .send({ reportIds: [reportId], queue: 'platform', source: 'user_report' })
      .expect(201);
    await request(app.getHttpServer()).post(`/api/v1/moderation/cases/${created.body.data.id}/close`).set(auth(moderator)).expect(200);

    const res = await request(app.getHttpServer()).post(`/api/v1/moderation/cases/${created.body.data.id}/assign`).set(auth(moderator)).send({}).expect(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  // --------------------------------------------------------------- priority

  it('updates priority via PATCH', async () => {
    const moderator = await registerModerator();
    const reportId = await createReportDirect(moderator.userId);
    const created = await request(app.getHttpServer())
      .post('/api/v1/moderation/cases')
      .set(auth(moderator))
      .send({ reportIds: [reportId], queue: 'platform', source: 'user_report' })
      .expect(201);

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/moderation/cases/${created.body.data.id}`)
      .set(auth(moderator))
      .send({ priority: 'critical' })
      .expect(200);
    expect(res.body.data.priority).toBe('critical');
  });

  it('rejects PATCH attempting to set status through the priority endpoint (whitelisted body)', async () => {
    const moderator = await registerModerator();
    const reportId = await createReportDirect(moderator.userId);
    const created = await request(app.getHttpServer())
      .post('/api/v1/moderation/cases')
      .set(auth(moderator))
      .send({ reportIds: [reportId], queue: 'platform', source: 'user_report' })
      .expect(201);

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/moderation/cases/${created.body.data.id}`)
      .set(auth(moderator))
      .send({ priority: 'high', status: 'closed' })
      .expect(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a non-moderator priority update with 403', async () => {
    const moderator = await registerModerator();
    const user = await registerUser();
    const reportId = await createReportDirect(moderator.userId);
    const created = await request(app.getHttpServer())
      .post('/api/v1/moderation/cases')
      .set(auth(moderator))
      .send({ reportIds: [reportId], queue: 'platform', source: 'user_report' })
      .expect(201);

    await request(app.getHttpServer()).patch(`/api/v1/moderation/cases/${created.body.data.id}`).set(auth(user)).send({ priority: 'high' }).expect(403);
  });

  // ---------------------------------------------------------------- closure

  it('closes a case and cascades linked open reports to closed', async () => {
    const moderator = await registerModerator();
    const reportId = await createReportDirect(moderator.userId);
    const created = await request(app.getHttpServer())
      .post('/api/v1/moderation/cases')
      .set(auth(moderator))
      .send({ reportIds: [reportId], queue: 'platform', source: 'user_report' })
      .expect(201);

    const res = await request(app.getHttpServer()).post(`/api/v1/moderation/cases/${created.body.data.id}/close`).set(auth(moderator)).expect(200);
    expect(res.body.data.status).toBe('closed');

    const report = await prisma.report.findUniqueOrThrow({ where: { id: reportId } });
    expect(report.status).toBe('closed');
  });

  it('repeated close is idempotent, 200', async () => {
    const moderator = await registerModerator();
    const reportId = await createReportDirect(moderator.userId);
    const created = await request(app.getHttpServer())
      .post('/api/v1/moderation/cases')
      .set(auth(moderator))
      .send({ reportIds: [reportId], queue: 'platform', source: 'user_report' })
      .expect(201);

    await request(app.getHttpServer()).post(`/api/v1/moderation/cases/${created.body.data.id}/close`).set(auth(moderator)).expect(200);
    const second = await request(app.getHttpServer()).post(`/api/v1/moderation/cases/${created.body.data.id}/close`).set(auth(moderator)).expect(200);
    expect(second.body.data.status).toBe('closed');
  });

  it('any moderator (not just the assignee) may close a case', async () => {
    const owner = await registerModerator();
    const closer = await registerModerator();
    const reportId = await createReportDirect(owner.userId);
    const created = await request(app.getHttpServer())
      .post('/api/v1/moderation/cases')
      .set(auth(owner))
      .send({ reportIds: [reportId], queue: 'platform', source: 'user_report' })
      .expect(201);
    await request(app.getHttpServer()).post(`/api/v1/moderation/cases/${created.body.data.id}/assign`).set(auth(owner)).send({}).expect(200);

    await request(app.getHttpServer()).post(`/api/v1/moderation/cases/${created.body.data.id}/close`).set(auth(closer)).expect(200);
  });
});
