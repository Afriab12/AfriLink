import 'reflect-metadata';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { sha256 } from '../src/auth/token.util';

// e2e coverage for the first real Moderation route: POST /moderation/
// account-appeals (docs/05-api/moderation.md §5). Unlike Content/Messaging/
// Community/Auth's moderation-callee services (internal DI only, never
// routed), this endpoint is genuinely public HTTP — no JwtAuthGuard, no
// cookies presented at all — so it needs real supertest coverage the way
// auth.e2e-spec.ts covers login/register, not just a unit spec.
describe('POST /api/v1/moderation/account-appeals (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  async function makeUser(overrides: Partial<{ status: string }> = {}) {
    return prisma.user.create({ data: { status: (overrides.status as never) ?? 'banned', updatedAt: new Date() } });
  }

  async function makeAppealChallenge(userId: string, code = '482913') {
    return prisma.verificationChallenge.create({
      data: {
        userId,
        channel: 'email',
        destinationHash: sha256(`${randomUUID()}@example.com`),
        purpose: 'account_appeal',
        challengeHash: sha256(code),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
  }

  async function makeCase() {
    return prisma.case.create({ data: { queue: 'platform', source: 'user_report' } });
  }

  async function makeAction(targetUserId: string, overrides: Partial<{ actionType: string; targetType: string }> = {}) {
    const c = await makeCase();
    return prisma.action.create({
      data: {
        caseId: c.id,
        targetType: (overrides.targetType as never) ?? 'profile',
        targetId: targetUserId,
        actionType: (overrides.actionType as never) ?? 'ban_account',
        scope: 'platform',
        reasonCode: 'spam',
      },
    });
  }

  async function makeSanction(actionId: string, subjectId: string, overrides: Partial<{ state: string }> = {}) {
    return prisma.sanction.create({
      data: {
        subjectType: 'user',
        subjectId,
        scope: 'platform',
        sanctionType: 'account_banned',
        reasonCode: 'spam',
        sourceActionId: actionId,
        state: (overrides.state as never) ?? 'active',
      },
    });
  }

  async function eligibleSetup() {
    const user = await makeUser();
    const action = await makeAction(user.id);
    await makeSanction(action.id, user.id);
    const challenge = await makeAppealChallenge(user.id);
    return { user, action, challenge };
  }

  it('creates an appeal, 201, correct envelope shape, no cookies set (never creates a session)', async () => {
    const { action, user, challenge } = await eligibleSetup();
    const res = await request(app.getHttpServer())
      .post('/api/v1/moderation/account-appeals')
      .send({ credential: `${challenge.id}.482913`, actionId: action.id, statement: 'I was wrongly banned.' })
      .expect(201);

    expect(res.body.data.actionId).toBe(action.id);
    expect(res.body.data.appellantUserId).toBe(user.id);
    expect(res.body.data.state).toBe('submitted');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('rejects an active account holding an otherwise-fully-valid credential with 401 TOKEN_INVALID, no cookies set — stale-credential-after-lift mitigation', async () => {
    const user = await makeUser({ status: 'active' });
    const action = await makeAction(user.id);
    await makeSanction(action.id, user.id);
    const challenge = await makeAppealChallenge(user.id);
    const res = await request(app.getHttpServer())
      .post('/api/v1/moderation/account-appeals')
      .send({ credential: `${challenge.id}.482913`, actionId: action.id, statement: 'x' })
      .expect(401);
    expect(res.body.error.code).toBe('TOKEN_INVALID');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('is reachable with no cookies/Authorization header at all — genuinely public, no JwtAuthGuard', async () => {
    const { action, challenge } = await eligibleSetup();
    // No .set('Cookie', ...) call anywhere — proves the route never
    // required an authenticated session in the first place.
    await request(app.getHttpServer())
      .post('/api/v1/moderation/account-appeals')
      .send({ credential: `${challenge.id}.482913`, actionId: action.id, statement: 'x' })
      .expect(201);
  });

  it('rejects a malformed body with 422 VALIDATION_FAILED and a details[] array', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/moderation/account-appeals')
      .send({ credential: 'x', actionId: 'not-a-uuid', statement: '' })
      .expect(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(Array.isArray(res.body.error.details)).toBe(true);
  });

  it('rejects an invalid credential with 401 TOKEN_INVALID', async () => {
    const { action } = await eligibleSetup();
    const res = await request(app.getHttpServer())
      .post('/api/v1/moderation/account-appeals')
      .send({ credential: `${randomUUID()}.000000`, actionId: action.id, statement: 'x' })
      .expect(401);
    expect(res.body.error.code).toBe('TOKEN_INVALID');
  });

  it("rejects an action belonging to another user with 404 RESOURCE_NOT_FOUND", async () => {
    const owner = await makeUser();
    const action = await makeAction(owner.id);
    await makeSanction(action.id, owner.id);
    const stranger = await makeUser();
    const strangerChallenge = await makeAppealChallenge(stranger.id);
    const res = await request(app.getHttpServer())
      .post('/api/v1/moderation/account-appeals')
      .send({ credential: `${strangerChallenge.id}.482913`, actionId: action.id, statement: 'x' })
      .expect(404);
    expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('rejects an actionType outside {suspend_account, ban_account} with 422 POLICY_REJECTED', async () => {
    const user = await makeUser();
    const action = await makeAction(user.id, { actionType: 'remove_content' });
    const challenge = await makeAppealChallenge(user.id);
    const res = await request(app.getHttpServer())
      .post('/api/v1/moderation/account-appeals')
      .send({ credential: `${challenge.id}.482913`, actionId: action.id, statement: 'x' })
      .expect(422);
    expect(res.body.error.code).toBe('POLICY_REJECTED');
  });

  it('rejects a duplicate appeal submission with 409 CONFLICT', async () => {
    const { action, user } = await eligibleSetup();
    const first = await makeAppealChallenge(user.id, '111111');
    await request(app.getHttpServer())
      .post('/api/v1/moderation/account-appeals')
      .send({ credential: `${first.id}.111111`, actionId: action.id, statement: 'first' })
      .expect(201);

    const second = await makeAppealChallenge(user.id, '222222');
    const res = await request(app.getHttpServer())
      .post('/api/v1/moderation/account-appeals')
      .send({ credential: `${second.id}.222222`, actionId: action.id, statement: 'second' })
      .expect(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });
});
