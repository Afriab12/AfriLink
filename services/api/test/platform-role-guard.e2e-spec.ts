import 'reflect-metadata';
import { Controller, Get, Post, HttpCode, Module, UseGuards, ValidationPipe, type INestApplication } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';
import { CsrfGuard } from '../src/common/guards/csrf.guard';
import { PlatformRoleGuard } from '../src/common/guards/platform-role.guard';
import { RequireRole } from '../src/common/decorators/require-role.decorator';

// Throwaway, test-only controller — not part of AppModule, no Moderation
// controller exists yet to test the real composition/wiring against.
// Mirrors exactly how a real future @RequireRole('moderator') route would
// be decorated, so this proves the actual guard chain, not just the
// guard's isolated logic (platform-role.guard.spec.ts covers that half).
@Controller('__test-platform-role')
class TestPlatformRoleController {
  @Get('moderator-only')
  @UseGuards(JwtAuthGuard, PlatformRoleGuard)
  @RequireRole('moderator')
  moderatorOnlyRead() {
    return { data: { ok: true } };
  }

  @Get('no-role-required')
  @UseGuards(JwtAuthGuard)
  noRoleRequired() {
    return { data: { ok: true } };
  }

  @Post('moderator-only-mutate')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, PlatformRoleGuard, CsrfGuard)
  @RequireRole('moderator')
  moderatorOnlyMutate() {
    return { data: { ok: true } };
  }
}

@Module({
  imports: [JwtModule.register({ secret: process.env.JWT_ACCESS_SECRET })],
  controllers: [TestPlatformRoleController],
  providers: [JwtAuthGuard, CsrfGuard, PlatformRoleGuard],
})
class TestPlatformRoleModule {}

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

describe('PlatformRoleGuard (e2e — real composition with JwtAuthGuard/CsrfGuard)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let moderatorRoleId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule, TestPlatformRoleModule] }).compile();
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

  it('rejects an unauthenticated request (JwtAuthGuard runs first)', async () => {
    await request(app.getHttpServer()).get('/api/v1/__test-platform-role/moderator-only').expect(401);
  });

  it('allows a granted moderator through the full guard chain', async () => {
    const u = await registerUser();
    await grantModerator(u.userId);
    await request(app.getHttpServer())
      .get('/api/v1/__test-platform-role/moderator-only')
      .set('Cookie', cookieHeader(u.cookies, 'afrilink_at'))
      .expect(200);
  });

  it('rejects an ordinary authenticated user with no role grant', async () => {
    const u = await registerUser();
    const res = await request(app.getHttpServer())
      .get('/api/v1/__test-platform-role/moderator-only')
      .set('Cookie', cookieHeader(u.cookies, 'afrilink_at'))
      .expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('rejects a suspended user even with an active moderator grant — JwtAuthGuard rejects before PlatformRoleGuard ever runs', async () => {
    const u = await registerUser();
    await grantModerator(u.userId);
    await prisma.user.update({ where: { id: u.userId }, data: { status: 'suspended' } });

    const res = await request(app.getHttpServer())
      .get('/api/v1/__test-platform-role/moderator-only')
      .set('Cookie', cookieHeader(u.cookies, 'afrilink_at'))
      .expect(403);
    // ACCOUNT_RESTRICTED (JwtAuthGuard), not FORBIDDEN (PlatformRoleGuard)
    // — proves the account-status check runs first and short-circuits the
    // role check entirely; a sanctioned moderator cannot use their role to
    // bypass their own sanction.
    expect(res.body.error.code).toBe('ACCOUNT_RESTRICTED');
  });

  it('a route with no @RequireRole() is unaffected by role state', async () => {
    const u = await registerUser();
    // No grant at all — still succeeds, since this route never checks role.
    await request(app.getHttpServer())
      .get('/api/v1/__test-platform-role/no-role-required')
      .set('Cookie', cookieHeader(u.cookies, 'afrilink_at'))
      .expect(200);
  });

  it('a moderator cannot use their role to bypass another user\'s resource ownership (existing route, not a @RequireRole() route)', async () => {
    const moderator = await registerUser();
    await grantModerator(moderator.userId);
    const other = await registerUser();

    // Someone else's session id — DELETE /auth/sessions/{id} has its own,
    // independent ownership check (assertOwnsMessage-style: userId must
    // match), unrelated to platform role.
    const otherSessionId = (await prisma.session.findFirstOrThrow({ where: { userId: other.userId } })).id;

    await request(app.getHttpServer())
      .delete(`/api/v1/auth/sessions/${otherSessionId}`)
      .set('Cookie', cookieHeader(moderator.cookies, 'afrilink_at', 'afrilink_csrf'))
      .set('X-CSRF-Token', moderator.cookies['afrilink_csrf'])
      .expect(404);
  });

  it('full composition including CsrfGuard: a granted moderator with a valid CSRF header succeeds on a mutating route', async () => {
    const u = await registerUser();
    await grantModerator(u.userId);
    await request(app.getHttpServer())
      .post('/api/v1/__test-platform-role/moderator-only-mutate')
      .set('Cookie', cookieHeader(u.cookies, 'afrilink_at', 'afrilink_csrf'))
      .set('X-CSRF-Token', u.cookies['afrilink_csrf'])
      .expect(200);
  });

  it('a granted moderator without a CSRF header is still rejected on a mutating route', async () => {
    const u = await registerUser();
    await grantModerator(u.userId);
    const res = await request(app.getHttpServer())
      .post('/api/v1/__test-platform-role/moderator-only-mutate')
      .set('Cookie', cookieHeader(u.cookies, 'afrilink_at', 'afrilink_csrf'))
      .expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('an ordinary user with a valid CSRF header is still rejected on a mutating route (no role grant)', async () => {
    const u = await registerUser();
    const res = await request(app.getHttpServer())
      .post('/api/v1/__test-platform-role/moderator-only-mutate')
      .set('Cookie', cookieHeader(u.cookies, 'afrilink_at', 'afrilink_csrf'))
      .set('X-CSRF-Token', u.cookies['afrilink_csrf'])
      .expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});
