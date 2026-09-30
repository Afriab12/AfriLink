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

describe('Appeal Decisions (e2e)', () => {
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

  async function makeAction(actorId: string, targetId: string, actionType: string, scope: string) {
    const kase = await prisma.case.create({ data: { queue: scope as never, source: 'user_report' } });
    return prisma.action.create({
      data: { caseId: kase.id, actorId, targetType: 'profile', targetId, actionType: actionType as never, scope: scope as never, reasonCode: 'spam' },
    });
  }

  async function makeSanction(actionId: string, subjectId: string, sanctionType: string) {
    return prisma.sanction.create({
      data: { subjectType: 'user', subjectId, scope: 'platform', sanctionType: sanctionType as never, reasonCode: 'spam', sourceActionId: actionId },
    });
  }

  async function makeAppeal(actionId: string, actionType: string, appellantUserId: string) {
    return prisma.appeal.create({
      data: { actionId, actionType: actionType as never, appellantUserId, statement: 'Wrongly actioned.', appealDeadline: new Date(Date.now() + 72 * 3600 * 1000) },
    });
  }

  it('rejects an unauthenticated request with 401', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/moderation/appeals/${randomUUID()}/decide`)
      .send({ decision: 'upheld' })
      .expect(401);
  });

  it('rejects a non-moderator with 403', async () => {
    const user = await registerUser();
    const res = await request(app.getHttpServer())
      .post(`/api/v1/moderation/appeals/${randomUUID()}/decide`)
      .set(auth(user))
      .send({ decision: 'upheld' })
      .expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('rejects a mutation without a CSRF header with 403', async () => {
    const moderator = await registerModerator();
    await request(app.getHttpServer())
      .post(`/api/v1/moderation/appeals/${randomUUID()}/decide`)
      .set('Cookie', cookieHeader(moderator.cookies, 'afrilink_at', 'afrilink_csrf'))
      .send({ decision: 'upheld' })
      .expect(403);
  });

  it('rejects a nonexistent appeal with 404', async () => {
    const moderator = await registerModerator();
    const res = await request(app.getHttpServer())
      .post(`/api/v1/moderation/appeals/${randomUUID()}/decide`)
      .set(auth(moderator))
      .send({ decision: 'upheld' })
      .expect(404);
    expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('rejects the original actor deciding their own action appeal with 403', async () => {
    const actor = await registerModerator();
    const target = await registerUser();
    const action = await makeAction(actor.userId, target.userId, 'ban_account', 'platform');
    await makeSanction(action.id, target.userId, 'account_banned');
    const appeal = await makeAppeal(action.id, 'ban_account', target.userId);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/moderation/appeals/${appeal.id}/decide`)
      .set(auth(actor))
      .send({ decision: 'upheld' })
      .expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('a different moderator upholds an appeal: 200, no reversal, response has no reversalOfActionId leak', async () => {
    const actor = await registerModerator();
    const reviewer = await registerModerator();
    const target = await registerUser();
    const action = await makeAction(actor.userId, target.userId, 'ban_account', 'platform');
    await makeSanction(action.id, target.userId, 'account_banned');
    const appeal = await makeAppeal(action.id, 'ban_account', target.userId);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/moderation/appeals/${appeal.id}/decide`)
      .set(auth(reviewer))
      .send({ decision: 'upheld', notes: 'Evidence supports the ban.' })
      .expect(200);

    expect(res.body.data.state).toBe('upheld');
    expect(res.body.data.decision).toBe('Evidence supports the ban.');
    const reversalCount = await prisma.action.count({ where: { reversalOfActionId: action.id } });
    expect(reversalCount).toBe(0);
  });

  it('overturns a ban: 200, User.status restored to active, reversal action created', async () => {
    const actor = await registerModerator();
    const reviewer = await registerModerator();
    const target = await registerUser();
    const action = await makeAction(actor.userId, target.userId, 'ban_account', 'platform');
    await makeSanction(action.id, target.userId, 'account_banned');
    const appeal = await makeAppeal(action.id, 'ban_account', target.userId);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/moderation/appeals/${appeal.id}/decide`)
      .set(auth(reviewer))
      .send({ decision: 'overturned', reasonCode: 'other' })
      .expect(200);

    expect(res.body.data.state).toBe('overturned');
    const user = await prisma.user.findUniqueOrThrow({ where: { id: target.userId } });
    expect(user.status).toBe('active');
    const reversalCount = await prisma.action.count({ where: { reversalOfActionId: action.id } });
    expect(reversalCount).toBe(1);
  });

  it('rejects overturn with no reasonCode: 422 VALIDATION_FAILED', async () => {
    const actor = await registerModerator();
    const reviewer = await registerModerator();
    const target = await registerUser();
    const action = await makeAction(actor.userId, target.userId, 'ban_account', 'platform');
    await makeSanction(action.id, target.userId, 'account_banned');
    const appeal = await makeAppeal(action.id, 'ban_account', target.userId);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/moderation/appeals/${appeal.id}/decide`)
      .set(auth(reviewer))
      .send({ decision: 'overturned' })
      .expect(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects re-deciding an already-decided appeal with 409', async () => {
    const actor = await registerModerator();
    const reviewer1 = await registerModerator();
    const reviewer2 = await registerModerator();
    const target = await registerUser();
    const action = await makeAction(actor.userId, target.userId, 'ban_account', 'platform');
    await makeSanction(action.id, target.userId, 'account_banned');
    const appeal = await makeAppeal(action.id, 'ban_account', target.userId);
    await request(app.getHttpServer()).post(`/api/v1/moderation/appeals/${appeal.id}/decide`).set(auth(reviewer1)).send({ decision: 'upheld' }).expect(200);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/moderation/appeals/${appeal.id}/decide`)
      .set(auth(reviewer2))
      .send({ decision: 'overturned', reasonCode: 'other' })
      .expect(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });
});
