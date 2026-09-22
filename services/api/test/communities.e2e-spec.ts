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

type U = { userId: string; cookies: Record<string, string> };
type MembershipStatus = 'pending' | 'active' | 'rejected' | 'left' | 'removed' | 'banned';

const FULL_KEYS = [
  'createdAt',
  'description',
  'id',
  'isPreview',
  'memberCount',
  'membershipPolicy',
  'name',
  'owner',
  'rules',
  'slug',
  'updatedAt',
  'viewer',
  'visibility',
];

// Communities API (api.md section 15). Vocabulary approved for this module: policies
// open | approval_required | invite_only; member roles member | moderator (the owner is implicit,
// communities.owner_user_id, and has no membership row).
describe('Communities (e2e)', () => {
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

  // ---------------------------------------------------------------- helpers

  async function registerUser(): Promise<U> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email: `test-${randomUUID()}@example.com`, password: 'correct-horse-battery-staple' })
      .expect(201);
    return { userId: res.body.data.user.id as string, cookies: extractCookies(res) };
  }

  function auth(u: U) {
    const csrf = u.cookies['afrilink_csrf'];
    return { Cookie: `afrilink_at=${u.cookies['afrilink_at']}; afrilink_csrf=${csrf}`, 'X-CSRF-Token': csrf };
  }

  const slug = () => `c-${randomUUID().replace(/-/g, '').slice(0, 12)}`;

  interface CommunityBody {
    slug?: string;
    name?: string;
    description?: string;
    rules?: string;
    visibility?: string;
    membershipPolicy?: string;
  }

  function post(u: U, path: string, body?: object) {
    return request(app.getHttpServer()).post(`/api/v1${path}`).set(auth(u)).send(body ?? {});
  }
  function get(u: U | null, path: string) {
    const req = request(app.getHttpServer()).get(`/api/v1${path}`);
    return u ? req.set(auth(u)) : req;
  }
  function put(u: U, path: string) {
    return request(app.getHttpServer()).put(`/api/v1${path}`).set(auth(u));
  }
  function patch(u: U, path: string, body: object) {
    return request(app.getHttpServer()).patch(`/api/v1${path}`).set(auth(u)).send(body);
  }
  function del(u: U, path: string) {
    return request(app.getHttpServer()).delete(`/api/v1${path}`).set(auth(u));
  }

  async function createCommunity(owner: U, body: CommunityBody = {}) {
    const res = await post(owner, '/communities', { slug: slug(), name: 'Test Community', ...body }).expect(201);
    return res.body.data as { id: string; slug: string };
  }

  async function seedMembership(communityId: string, userId: string, status: MembershipStatus, role = 'member', createdAt?: Date) {
    return prisma.communityMembership.create({
      data: {
        communityId,
        userId,
        status,
        role,
        approvedAt: status === 'active' ? new Date() : null,
        removedAt: status === 'removed' ? new Date() : null,
        leftAt: status === 'left' ? new Date() : null,
        ...(createdAt && { createdAt }),
      },
    });
  }

  async function rows(communityId: string, userId: string) {
    return prisma.communityMembership.findMany({ where: { communityId, userId }, orderBy: { createdAt: 'asc' } });
  }

  async function activeMember(communityId: string, role = 'member'): Promise<U> {
    const u = await registerUser();
    await seedMembership(communityId, u.userId, 'active', role);
    return u;
  }

  function expectError(res: request.Response, status: number, code: string) {
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
  }

  // ================================================================ create

  describe('POST /communities', () => {
    it('requires authentication and CSRF', async () => {
      const u = await registerUser();
      await request(app.getHttpServer()).post('/api/v1/communities').send({ slug: slug(), name: 'x' }).expect(401);
      await request(app.getHttpServer())
        .post('/api/v1/communities')
        .set('Cookie', `afrilink_at=${u.cookies['afrilink_at']}; afrilink_csrf=${u.cookies['afrilink_csrf']}`)
        .send({ slug: slug(), name: 'x' })
        .expect(403);
    });

    it('creates a public, open community by default and makes the caller its owner', async () => {
      const owner = await registerUser();
      const res = await post(owner, '/communities', { slug: 'lagos-devs-' + slug().slice(2, 8), name: 'Lagos Devs', description: 'Developers in Lagos', rules: 'Be kind.' }).expect(201);
      const c = res.body.data;

      expect(Object.keys(c).sort()).toEqual(FULL_KEYS);
      expect(c).toMatchObject({
        name: 'Lagos Devs',
        description: 'Developers in Lagos',
        rules: 'Be kind.',
        visibility: 'public',
        membershipPolicy: 'open',
        isPreview: false,
        memberCount: 1, // the owner
        owner: { userId: owner.userId },
        viewer: { role: 'owner', membershipStatus: 'active' },
      });
      // no membership row is created for the owner (single source of truth: communities.owner_user_id)
      expect(await prisma.communityMembership.count({ where: { communityId: c.id } })).toBe(0);
    });

    it.each([
      ['private', 'approval_required'],
      ['public', 'invite_only'],
      ['private', 'open'],
    ])('accepts visibility=%s with membershipPolicy=%s', async (visibility, membershipPolicy) => {
      const owner = await registerUser();
      const res = await post(owner, '/communities', { slug: slug(), name: 'X', visibility, membershipPolicy }).expect(201);
      expect(res.body.data).toMatchObject({ visibility, membershipPolicy });
    });

    it.each([
      ['upper case', 'Lagos-Devs'],
      ['a space', 'lagos devs'],
      ['an underscore', 'lagos_devs'],
      ['a leading hyphen', '-lagos'],
      ['a trailing hyphen', 'lagos-'],
      ['a double hyphen', 'lagos--devs'],
      ['fewer than 3 characters', 'ab'],
      ['more than 40 characters', 'a'.repeat(41)],
      ['non-ASCII text', 'lägos-devs'],
      ['a UUID shape (it would be mistaken for an id)', '9b2e2bd0-5f0c-4c1e-8f4e-2f3a5a8f7c11'],
    ])('rejects a slug with %s', async (_name, bad) => {
      const owner = await registerUser();
      const res = await post(owner, '/communities', { slug: bad, name: 'X' });
      expectError(res, 422, 'VALIDATION_FAILED');
      expect(res.body.error.details.map((d: { field: string }) => d.field)).toContain('slug');
    });

    it.each([
      ['a missing name', { slug: slug() }, 'name'],
      ['a blank name', { slug: slug(), name: '   ' }, 'name'],
      ['a name over 100 characters', { slug: slug(), name: 'n'.repeat(101) }, 'name'],
      ['a description over 2000 characters', { slug: slug(), name: 'X', description: 'd'.repeat(2001) }, 'description'],
      ['rules over 5000 characters', { slug: slug(), name: 'X', rules: 'r'.repeat(5001) }, 'rules'],
      ['an unknown visibility', { slug: slug(), name: 'X', visibility: 'secret' }, 'visibility'],
      ['an unknown membership policy', { slug: slug(), name: 'X', membershipPolicy: 'anyone' }, 'membershipPolicy'],
      ['a hyphenated policy name', { slug: slug(), name: 'X', membershipPolicy: 'approval-required' }, 'membershipPolicy'],
    ])('rejects %s with 422 and the offending field', async (_name, body, field) => {
      const owner = await registerUser();
      const res = await post(owner, '/communities', body);
      expectError(res, 422, 'VALIDATION_FAILED');
      expect(res.body.error.details.map((d: { field: string }) => d.field)).toContain(field);
    });

    it.each(['ownerUserId', 'status', 'memberCount', 'avatarMediaId', 'id', 'deletedAt'])('rejects the mass-assigned field %s', async (field) => {
      const owner = await registerUser();
      const res = await post(owner, '/communities', { slug: slug(), name: 'X', [field]: field === 'memberCount' ? 99 : randomUUID() });
      expectError(res, 422, 'VALIDATION_FAILED');
    });

    it('rejects a duplicate slug with 409, and lets a deleted community\'s slug be reused', async () => {
      const a = await registerUser();
      const b = await registerUser();
      const s = slug();
      const first = await post(a, '/communities', { slug: s, name: 'One' }).expect(201);
      expectError(await post(b, '/communities', { slug: s, name: 'Two' }), 409, 'DUPLICATE_ACTION');

      await del(a, `/communities/${first.body.data.id}`).expect(200);
      const reused = await post(b, '/communities', { slug: s, name: 'Two' }).expect(201);
      expect(reused.body.data.slug).toBe(s);
    });
  });

  // ================================================================ read

  describe('GET /communities/{idOrSlug}', () => {
    it('returns a public community by id and by slug (slug lookup is case-insensitive), to anonymous callers too', async () => {
      const owner = await registerUser();
      const c = await createCommunity(owner, { description: 'hello' });

      const byId = await get(null, `/communities/${c.id}`).expect(200);
      const bySlug = await get(null, `/communities/${c.slug}`).expect(200);
      const byUpper = await get(null, `/communities/${c.slug.toUpperCase()}`).expect(200);

      expect(bySlug.body.data).toEqual(byId.body.data);
      expect(byUpper.body.data.id).toBe(c.id);
      expect(byId.body.data.viewer).toEqual({ role: null, membershipStatus: null });
      expect(byId.body.data.isPreview).toBe(false);
    });

    it('answers 404 for an unknown id or slug, a deleted community, and a community that is not active', async () => {
      const owner = await registerUser();
      const c = await createCommunity(owner);
      const suspended = await createCommunity(owner);
      await prisma.community.update({ where: { id: suspended.id }, data: { status: 'suspended' } });

      expectError(await get(owner, `/communities/${randomUUID()}`), 404, 'RESOURCE_NOT_FOUND');
      expectError(await get(owner, '/communities/no-such-community'), 404, 'RESOURCE_NOT_FOUND');
      expectError(await get(owner, `/communities/${suspended.id}`), 404, 'RESOURCE_NOT_FOUND');

      await del(owner, `/communities/${c.id}`).expect(200);
      expectError(await get(owner, `/communities/${c.id}`), 404, 'RESOURCE_NOT_FOUND');
      expectError(await get(owner, `/communities/${c.slug}`), 404, 'RESOURCE_NOT_FOUND');
    });

    it('counts only active members plus the owner in memberCount', async () => {
      const owner = await registerUser();
      const c = await createCommunity(owner);
      for (const status of ['active', 'active', 'pending', 'left', 'removed', 'banned', 'rejected'] as const) {
        await seedMembership(c.id, (await registerUser()).userId, status);
      }
      const res = await get(owner, `/communities/${c.id}`).expect(200);
      expect(res.body.data.memberCount).toBe(3);
    });

    it("reports the caller's own role and membership status", async () => {
      const owner = await registerUser();
      const c = await createCommunity(owner);
      const member = await activeMember(c.id);
      const mod = await activeMember(c.id, 'moderator');
      const pending = await registerUser();
      await seedMembership(c.id, pending.userId, 'pending');

      expect((await get(owner, `/communities/${c.id}`)).body.data.viewer).toEqual({ role: 'owner', membershipStatus: 'active' });
      expect((await get(member, `/communities/${c.id}`)).body.data.viewer).toEqual({ role: 'member', membershipStatus: 'active' });
      expect((await get(mod, `/communities/${c.id}`)).body.data.viewer).toEqual({ role: 'moderator', membershipStatus: 'active' });
      expect((await get(pending, `/communities/${c.id}`)).body.data.viewer).toEqual({ role: null, membershipStatus: 'pending' });
    });

    describe('a private community', () => {
      it('is a 404 for anonymous callers, identical to a community that does not exist', async () => {
        const owner = await registerUser();
        const c = await createCommunity(owner, { visibility: 'private' });
        const real = await get(null, `/communities/${c.id}`);
        const fake = await get(null, `/communities/${randomUUID()}`);
        expect(real.status).toBe(404);
        expect(real.body.error.code).toBe(fake.body.error.code);
        expect(real.body.error.message).toBe(fake.body.error.message);
      });

      it('shows a signed-in non-member only a limited preview, so they can request to join', async () => {
        const owner = await registerUser();
        const c = await createCommunity(owner, { visibility: 'private', membershipPolicy: 'approval_required', description: 'd', rules: 'r' });
        const stranger = await registerUser();
        for (let i = 0; i < 2; i++) await seedMembership(c.id, (await registerUser()).userId, 'active');

        const res = await get(stranger, `/communities/${c.id}`).expect(200);
        expect(Object.keys(res.body.data).sort()).toEqual(FULL_KEYS); // same shape...
        expect(res.body.data).toMatchObject({
          isPreview: true,
          visibility: 'private',
          membershipPolicy: 'approval_required',
          description: 'd',
          rules: 'r',
          memberCount: null, // ...but nothing that reveals size, owner or timing
          owner: null,
          createdAt: null,
          updatedAt: null,
        });
      });

      it('shows the full view to the owner and to active members, and to a moderator', async () => {
        const owner = await registerUser();
        const c = await createCommunity(owner, { visibility: 'private' });
        const member = await activeMember(c.id);
        const mod = await activeMember(c.id, 'moderator');
        for (const u of [owner, member, mod]) {
          const res = await get(u, `/communities/${c.id}`).expect(200);
          expect(res.body.data.isPreview).toBe(false);
          expect(res.body.data.memberCount).toBe(3);
          expect(res.body.data.owner.userId).toBe(owner.userId);
        }
      });

      it.each(['left', 'removed', 'banned', 'rejected'] as const)('shows only the preview to someone whose membership is %s', async (status) => {
        const owner = await registerUser();
        const c = await createCommunity(owner, { visibility: 'private' });
        const u = await registerUser();
        await seedMembership(c.id, u.userId, status);
        const res = await get(u, `/communities/${c.id}`).expect(200);
        expect(res.body.data.isPreview).toBe(true);
      });
    });
  });

  // ================================================================ discovery

  describe('GET /communities (discovery)', () => {
    it('lists public, active communities newest first, to anonymous callers too', async () => {
      const owner = await registerUser();
      const first = await createCommunity(owner);
      const second = await createCommunity(owner);
      const third = await createCommunity(owner);

      const res = await get(null, '/communities?limit=50').expect(200);
      const ids: string[] = res.body.data.map((c: { id: string }) => c.id);
      expect(ids.indexOf(third.id)).toBeLessThan(ids.indexOf(second.id));
      expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
      expect(ids.indexOf(first.id)).toBeGreaterThanOrEqual(0);
      for (const c of res.body.data) {
        expect(c.visibility).toBe('public');
        expect(c.isPreview).toBe(false);
      }
    });

    it('never lists private, deleted or non-active communities', async () => {
      const owner = await registerUser();
      const priv = await createCommunity(owner, { visibility: 'private' });
      const gone = await createCommunity(owner);
      const suspended = await createCommunity(owner);
      const visible = await createCommunity(owner);
      await del(owner, `/communities/${gone.id}`).expect(200);
      await prisma.community.update({ where: { id: suspended.id }, data: { status: 'suspended' } });

      const ids = (await get(owner, '/communities?limit=50').expect(200)).body.data.map((c: { id: string }) => c.id);
      expect(ids).toContain(visible.id);
      for (const hidden of [priv.id, gone.id, suspended.id]) expect(ids).not.toContain(hidden);
    });

    it("includes the caller's own membership on each item", async () => {
      const owner = await registerUser();
      const c = await createCommunity(owner);
      const member = await activeMember(c.id);
      const res = await get(member, '/communities?limit=50').expect(200);
      const item = res.body.data.find((x: { id: string }) => x.id === c.id);
      expect(item.viewer).toEqual({ role: 'member', membershipStatus: 'active' });
      expect(item.memberCount).toBe(2);
    });

    it('rejects filters other than mine=true, and accepts only the literal true', async () => {
      const u = await registerUser();
      for (const q of ['mine=false', 'mine=yes', 'mine=1', 'visibility=private', 'q=lagos']) {
        expectError(await get(u, `/communities?${q}`), 422, 'VALIDATION_FAILED');
      }
    });

    it('clamps an oversized limit and rejects a malformed cursor', async () => {
      const u = await registerUser();
      expect((await get(u, '/communities?limit=500')).status).toBe(200);
      expectError(await get(u, '/communities?cursor=not-a-real-cursor!!'), 400, 'INVALID_CURSOR');
    });

    describe('mine=true', () => {
      it('requires authentication', async () => {
        expectError(await get(null, '/communities?mine=true'), 401, 'AUTHENTICATION_REQUIRED');
      });

      it('lists owned communities and communities where the caller is an active member, including private ones', async () => {
        const me = await registerUser();
        const other = await registerUser();
        const owned = await createCommunity(me, { visibility: 'private' });
        const joined = await createCommunity(other, { visibility: 'private' });
        const publicJoined = await createCommunity(other);
        await seedMembership(joined.id, me.userId, 'active');
        await seedMembership(publicJoined.id, me.userId, 'active');

        const ids = (await get(me, '/communities?mine=true').expect(200)).body.data.map((c: { id: string }) => c.id);
        expect(new Set(ids)).toEqual(new Set([owned.id, joined.id, publicJoined.id]));
      });

      it.each(['pending', 'left', 'removed', 'banned', 'rejected'] as const)('excludes a community where the membership is %s', async (status) => {
        const me = await registerUser();
        const other = await registerUser();
        const c = await createCommunity(other);
        await seedMembership(c.id, me.userId, status);
        expect((await get(me, '/communities?mine=true').expect(200)).body.data).toEqual([]);
      });

      // mine is answered in two steps (the caller's active memberships, then the communities): these pin
      // the edges of that split, including the empty membership list.
      it('an owner with no memberships lists only what they own; a member who owns nothing lists only what they joined', async () => {
        const ownerOnly = await registerUser();
        const memberOnly = await registerUser();
        const mineOwned = await createCommunity(ownerOnly, { visibility: 'private' });
        const someoneElses = await createCommunity(await registerUser());
        await seedMembership(someoneElses.id, memberOnly.userId, 'active');

        expect((await get(ownerOnly, '/communities?mine=true').expect(200)).body.data.map((c: { id: string }) => c.id)).toEqual([mineOwned.id]);
        expect((await get(memberOnly, '/communities?mine=true').expect(200)).body.data.map((c: { id: string }) => c.id)).toEqual([someoneElses.id]);
      });

      it('never lists another user\'s communities, and excludes a community that is no longer active even if owned or joined', async () => {
        const me = await registerUser();
        const other = await registerUser();
        const ownedSuspended = await createCommunity(me);
        const joinedSuspended = await createCommunity(other);
        const kept = await createCommunity(me);
        await seedMembership(joinedSuspended.id, me.userId, 'active');
        await createCommunity(other); // public, but nothing to do with me
        await prisma.community.updateMany({ where: { id: { in: [ownedSuspended.id, joinedSuspended.id] } }, data: { status: 'suspended' } });

        expect((await get(me, '/communities?mine=true').expect(200)).body.data.map((c: { id: string }) => c.id)).toEqual([kept.id]);
      });

      it('a community the caller both owns and has a stray active membership row for is listed once', async () => {
        const me = await registerUser();
        const c = await createCommunity(me);
        await seedMembership(c.id, me.userId, 'active');
        const ids = (await get(me, '/communities?mine=true').expect(200)).body.data.map((x: { id: string }) => x.id);
        expect(ids).toEqual([c.id]);
      });

      it('excludes deleted communities and paginates without skipping or duplicating', async () => {
        const me = await registerUser();
        const other = await registerUser();
        const made: string[] = [];
        for (let i = 0; i < 5; i++) made.push((await createCommunity(me)).id);
        const joined = await createCommunity(other);
        await seedMembership(joined.id, me.userId, 'active');
        const doomed = await createCommunity(me);
        await del(me, `/communities/${doomed.id}`).expect(200);

        const all = (await get(me, '/communities?mine=true').expect(200)).body.data.map((c: { id: string }) => c.id);
        expect(all).toHaveLength(6);
        expect(all).not.toContain(doomed.id);

        for (const size of [1, 2, 4]) {
          const seen: string[] = [];
          let cursor: string | null = null;
          for (let guard = 0; guard < 20; guard++) {
            const res: request.Response = await get(me, `/communities?mine=true&limit=${size}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`).expect(200);
            seen.push(...res.body.data.map((c: { id: string }) => c.id));
            if (!res.body.meta.page.hasMore) break;
            cursor = res.body.meta.page.nextCursor as string;
          }
          expect(seen).toEqual(all);
        }
      });
    });
  });

  // ================================================================ edit / delete

  describe('PATCH /communities/{id}', () => {
    it('lets the owner edit name, description, rules, visibility and policy; the slug never changes', async () => {
      const owner = await registerUser();
      const c = await createCommunity(owner, { description: 'old' });
      const res = await patch(owner, `/communities/${c.id}`, {
        name: 'New name',
        description: 'new',
        rules: 'new rules',
        visibility: 'private',
        membershipPolicy: 'approval_required',
      }).expect(200);
      expect(res.body.data).toMatchObject({ name: 'New name', description: 'new', rules: 'new rules', visibility: 'private', membershipPolicy: 'approval_required', slug: c.slug });
      expect(res.body.data.updatedAt).not.toBeNull();

      expectError(await patch(owner, `/communities/${c.id}`, { slug: 'other-slug' }), 422, 'VALIDATION_FAILED');
      expect((await get(owner, `/communities/${c.id}`)).body.data.slug).toBe(c.slug);
    });

    it('clears an optional field when it is set to null', async () => {
      const owner = await registerUser();
      const c = await createCommunity(owner, { description: 'something', rules: 'some rules' });
      const res = await patch(owner, `/communities/${c.id}`, { description: null, rules: null }).expect(200);
      expect(res.body.data.description).toBeNull();
      expect(res.body.data.rules).toBeNull();
    });

    it.each([
      ['a member', async (c: { id: string }) => activeMember(c.id)],
      ['a moderator', async (c: { id: string }) => activeMember(c.id, 'moderator')],
      ['a non-member of a public community', async () => registerUser()],
    ])('is 403 for %s, and changes nothing', async (_name, makeCaller) => {
      const owner = await registerUser();
      const c = await createCommunity(owner, { name: 'Original' });
      const caller = await makeCaller(c);
      expectError(await patch(caller, `/communities/${c.id}`, { name: 'Hijacked' }), 403, 'FORBIDDEN');
      expect((await get(owner, `/communities/${c.id}`)).body.data.name).toBe('Original');
    });

    it('is 401 without a session, 404 for an unknown or deleted community, 422 for invalid values, and rejects mass assignment', async () => {
      const owner = await registerUser();
      const c = await createCommunity(owner);
      await request(app.getHttpServer()).patch(`/api/v1/communities/${c.id}`).send({ name: 'x' }).expect(401);
      expectError(await patch(owner, `/communities/${randomUUID()}`, { name: 'x' }), 404, 'RESOURCE_NOT_FOUND');
      expectError(await patch(owner, `/communities/${c.id}`, { name: '' }), 422, 'VALIDATION_FAILED');
      expectError(await patch(owner, `/communities/${c.id}`, { membershipPolicy: 'nope' }), 422, 'VALIDATION_FAILED');
      expectError(await patch(owner, `/communities/${c.id}`, { ownerUserId: randomUUID() }), 422, 'VALIDATION_FAILED');
      await del(owner, `/communities/${c.id}`).expect(200);
      expectError(await patch(owner, `/communities/${c.id}`, { name: 'x' }), 404, 'RESOURCE_NOT_FOUND');
    });
  });

  describe('DELETE /communities/{id}', () => {
    it('lets the owner soft-delete it: gone from reads and discovery, row kept, second delete is 404', async () => {
      const owner = await registerUser();
      const c = await createCommunity(owner);
      expect((await del(owner, `/communities/${c.id}`).expect(200)).body).toEqual({ data: { deleted: true } });

      expectError(await get(owner, `/communities/${c.id}`), 404, 'RESOURCE_NOT_FOUND');
      expect((await get(owner, '/communities?limit=50')).body.data.map((x: { id: string }) => x.id)).not.toContain(c.id);
      const row = await prisma.community.findUniqueOrThrow({ where: { id: c.id } });
      expect(row.deletedAt).not.toBeNull(); // soft delete: the row stays
      expectError(await del(owner, `/communities/${c.id}`), 404, 'RESOURCE_NOT_FOUND');
    });

    it.each([
      ['a member', async (c: { id: string }) => activeMember(c.id)],
      ['a moderator', async (c: { id: string }) => activeMember(c.id, 'moderator')],
      ['a non-member', async () => registerUser()],
    ])('is 403 for %s, and the community survives', async (_name, makeCaller) => {
      const owner = await registerUser();
      const c = await createCommunity(owner);
      const caller = await makeCaller(c);
      expectError(await del(caller, `/communities/${c.id}`), 403, 'FORBIDDEN');
      await get(owner, `/communities/${c.id}`).expect(200);
    });

    it('requires a session and CSRF, and nobody can join a deleted community', async () => {
      const owner = await registerUser();
      const c = await createCommunity(owner);
      await request(app.getHttpServer()).delete(`/api/v1/communities/${c.id}`).expect(401);
      await request(app.getHttpServer())
        .delete(`/api/v1/communities/${c.id}`)
        .set('Cookie', `afrilink_at=${owner.cookies['afrilink_at']}; afrilink_csrf=${owner.cookies['afrilink_csrf']}`)
        .expect(403);
      await del(owner, `/communities/${c.id}`).expect(200);
      expectError(await put(await registerUser(), `/communities/${c.id}/membership`), 404, 'RESOURCE_NOT_FOUND');
    });
  });

  // ================================================================ join / leave

  describe('PUT /communities/{id}/membership (join or request)', () => {
    it('requires a session and CSRF', async () => {
      const owner = await registerUser();
      const c = await createCommunity(owner);
      await request(app.getHttpServer()).put(`/api/v1/communities/${c.id}/membership`).expect(401);
      const u = await registerUser();
      await request(app.getHttpServer())
        .put(`/api/v1/communities/${c.id}/membership`)
        .set('Cookie', `afrilink_at=${u.cookies['afrilink_at']}; afrilink_csrf=${u.cookies['afrilink_csrf']}`)
        .expect(403);
    });

    describe('membership policy', () => {
      it('open: joins immediately as an active member, and repeating it is a no-op with a single row', async () => {
        const owner = await registerUser();
        const c = await createCommunity(owner, { membershipPolicy: 'open' });
        const u = await registerUser();

        const first = await put(u, `/communities/${c.id}/membership`).expect(200);
        expect(first.body.data).toEqual({ communityId: c.id, status: 'active', role: 'member' });
        const second = await put(u, `/communities/${c.id}/membership`).expect(200);
        expect(second.body.data).toEqual(first.body.data);

        const r = await rows(c.id, u.userId);
        expect(r).toHaveLength(1);
        expect(r[0]).toMatchObject({ status: 'active', role: 'member', approvedBy: null });
        expect(r[0].approvedAt).not.toBeNull();
      });

      it('approval_required: creates a pending request, and repeating it does not create another', async () => {
        const owner = await registerUser();
        const c = await createCommunity(owner, { membershipPolicy: 'approval_required' });
        const u = await registerUser();

        expect((await put(u, `/communities/${c.id}/membership`).expect(200)).body.data).toEqual({ communityId: c.id, status: 'pending', role: 'member' });
        await put(u, `/communities/${c.id}/membership`).expect(200);
        const r = await rows(c.id, u.userId);
        expect(r).toHaveLength(1);
        expect(r[0].status).toBe('pending');
        expect(r[0].approvedAt).toBeNull();
      });

      it('invite_only: rejected with 422 POLICY_REJECTED and nothing is created (invitations are a later task)', async () => {
        const owner = await registerUser();
        const c = await createCommunity(owner, { membershipPolicy: 'invite_only' });
        const u = await registerUser();
        expectError(await put(u, `/communities/${c.id}/membership`), 422, 'POLICY_REJECTED');
        expect(await rows(c.id, u.userId)).toHaveLength(0);
      });

      it('an existing member or pending request is reported as is, whatever the policy is now', async () => {
        const owner = await registerUser();
        const c = await createCommunity(owner, { membershipPolicy: 'open' });
        const member = await activeMember(c.id);
        const pending = await registerUser();
        await seedMembership(c.id, pending.userId, 'pending');
        await patch(owner, `/communities/${c.id}`, { membershipPolicy: 'invite_only' }).expect(200);

        expect((await put(member, `/communities/${c.id}/membership`).expect(200)).body.data.status).toBe('active');
        expect((await put(pending, `/communities/${c.id}/membership`).expect(200)).body.data.status).toBe('pending');
      });
    });

    it('the owner is already a member: 200 with role owner, and no row is created', async () => {
      const owner = await registerUser();
      const c = await createCommunity(owner, { membershipPolicy: 'approval_required' });
      const res = await put(owner, `/communities/${c.id}/membership`).expect(200);
      expect(res.body.data).toEqual({ communityId: c.id, status: 'active', role: 'owner' });
      expect(await rows(c.id, owner.userId)).toHaveLength(0);
    });

    it.each(['open', 'approval_required'])('a banned user cannot join a %s community, and the ban is untouched', async (membershipPolicy) => {
      const owner = await registerUser();
      const c = await createCommunity(owner, { membershipPolicy });
      const u = await registerUser();
      await seedMembership(c.id, u.userId, 'banned');
      expectError(await put(u, `/communities/${c.id}/membership`), 403, 'FORBIDDEN');
      const r = await rows(c.id, u.userId);
      expect(r).toHaveLength(1);
      expect(r[0].status).toBe('banned');
    });

    it.each([
      ['left', 'open', 'active'],
      ['removed', 'open', 'active'],
      ['left', 'approval_required', 'pending'],
      ['rejected', 'approval_required', 'pending'],
      ['removed', 'approval_required', 'pending'],
    ] as const)('after a %s membership in a %s community, joining again starts a new %s row and keeps the history', async (previous, membershipPolicy, expected) => {
      const owner = await registerUser();
      const c = await createCommunity(owner, { membershipPolicy });
      const u = await registerUser();
      await seedMembership(c.id, u.userId, previous);

      expect((await put(u, `/communities/${c.id}/membership`).expect(200)).body.data.status).toBe(expected);
      const r = await rows(c.id, u.userId);
      expect(r.map((x) => x.status)).toEqual([previous, expected]);
    });

    it.each([
      ['the owner blocked the user', async (owner: U, u: U) => post(owner, `/users/${u.userId}/block`).expect(201)],
      ['the user blocked the owner', async (owner: U, u: U) => post(u, `/users/${owner.userId}/block`).expect(201)],
    ])('is 404, and creates nothing, when %s', async (_name, block) => {
      const owner = await registerUser();
      const c = await createCommunity(owner);
      const u = await registerUser();
      await block(owner, u);
      expectError(await put(u, `/communities/${c.id}/membership`), 404, 'RESOURCE_NOT_FOUND');
      expect(await rows(c.id, u.userId)).toHaveLength(0);
    });

    it('a signed-in stranger can request to join a private community they can preview', async () => {
      const owner = await registerUser();
      const c = await createCommunity(owner, { visibility: 'private', membershipPolicy: 'approval_required' });
      const u = await registerUser();
      expect((await put(u, `/communities/${c.id}/membership`).expect(200)).body.data.status).toBe('pending');
    });

    it('is 404 for an unknown community', async () => {
      expectError(await put(await registerUser(), `/communities/${randomUUID()}/membership`), 404, 'RESOURCE_NOT_FOUND');
    });

    it('serialises concurrent requests: five at once still produce exactly one row', async () => {
      const owner = await registerUser();
      const approval = await createCommunity(owner, { membershipPolicy: 'approval_required' });
      const open = await createCommunity(owner, { membershipPolicy: 'open' });
      const u = await registerUser();

      const [a, b] = await Promise.all([
        Promise.all(Array.from({ length: 5 }, () => put(u, `/communities/${approval.id}/membership`))),
        Promise.all(Array.from({ length: 5 }, () => put(u, `/communities/${open.id}/membership`))),
      ]);
      for (const res of [...a, ...b]) expect(res.status).toBe(200);
      expect(await rows(approval.id, u.userId)).toHaveLength(1);
      expect(await rows(open.id, u.userId)).toHaveLength(1);
    });
  });

  describe('DELETE /communities/{id}/membership (leave or withdraw)', () => {
    it('an active member leaves: status left, leftAt set, and repeating it is a 200 no-op', async () => {
      const owner = await registerUser();
      const c = await createCommunity(owner);
      const u = await activeMember(c.id);

      expect((await del(u, `/communities/${c.id}/membership`).expect(200)).body.data).toEqual({ communityId: c.id, status: 'left' });
      const r = await rows(c.id, u.userId);
      expect(r[0].status).toBe('left');
      expect(r[0].leftAt).not.toBeNull();
      await del(u, `/communities/${c.id}/membership`).expect(200);
      expect(await rows(c.id, u.userId)).toHaveLength(1);
    });

    it('a pending requester can withdraw the request', async () => {
      const owner = await registerUser();
      const c = await createCommunity(owner, { membershipPolicy: 'approval_required' });
      const u = await registerUser();
      await put(u, `/communities/${c.id}/membership`).expect(200);
      expect((await del(u, `/communities/${c.id}/membership`).expect(200)).body.data.status).toBe('left');
      expect((await rows(c.id, u.userId))[0].status).toBe('left');
    });

    it('the owner cannot leave (they must delete the community)', async () => {
      const owner = await registerUser();
      const c = await createCommunity(owner);
      expectError(await del(owner, `/communities/${c.id}/membership`), 422, 'POLICY_REJECTED');
      await get(owner, `/communities/${c.id}`).expect(200);
    });

    it.each(['rejected', 'removed', 'banned'] as const)('is 404 for a %s membership, and the status does not change', async (status) => {
      const owner = await registerUser();
      const c = await createCommunity(owner);
      const u = await registerUser();
      await seedMembership(c.id, u.userId, status);
      expectError(await del(u, `/communities/${c.id}/membership`), 404, 'RESOURCE_NOT_FOUND');
      expect((await rows(c.id, u.userId))[0].status).toBe(status);
    });

    it('is 404 for someone who never joined, and for an unknown community', async () => {
      const owner = await registerUser();
      const c = await createCommunity(owner);
      expectError(await del(await registerUser(), `/communities/${c.id}/membership`), 404, 'RESOURCE_NOT_FOUND');
      expectError(await del(await registerUser(), `/communities/${randomUUID()}/membership`), 404, 'RESOURCE_NOT_FOUND');
    });

    it('requires a session', async () => {
      const c = await createCommunity(await registerUser());
      await request(app.getHttpServer()).delete(`/api/v1/communities/${c.id}/membership`).expect(401);
    });
  });

  // ================================================================ approval flow

  describe('approve and reject', () => {
    async function pendingRequest(policy = 'approval_required') {
      const owner = await registerUser();
      const c = await createCommunity(owner, { membershipPolicy: policy });
      const requester = await registerUser();
      await put(requester, `/communities/${c.id}/membership`).expect(200);
      return { owner, c, requester };
    }

    it('the owner approves a pending request: active, with approvedAt and approvedBy recorded', async () => {
      const { owner, c, requester } = await pendingRequest();
      const res = await post(owner, `/communities/${c.id}/members/${requester.userId}/approve`).expect(200);
      expect(res.body.data).toEqual({ communityId: c.id, userId: requester.userId, status: 'active', role: 'member' });
      const r = (await rows(c.id, requester.userId))[0];
      expect(r).toMatchObject({ status: 'active', approvedBy: owner.userId });
      expect(r.approvedAt).not.toBeNull();
      expect((await get(requester, `/communities/${c.id}`)).body.data.viewer.role).toBe('member');
    });

    it('a moderator can approve and reject; a plain member and an outsider cannot', async () => {
      const { c, requester } = await pendingRequest();
      const mod = await activeMember(c.id, 'moderator');
      const member = await activeMember(c.id);
      const outsider = await registerUser();

      for (const caller of [member, outsider]) {
        expectError(await post(caller, `/communities/${c.id}/members/${requester.userId}/approve`), 403, 'FORBIDDEN');
        expectError(await post(caller, `/communities/${c.id}/members/${requester.userId}/reject`), 403, 'FORBIDDEN');
      }
      expect((await rows(c.id, requester.userId))[0].status).toBe('pending');

      await post(mod, `/communities/${c.id}/members/${requester.userId}/approve`).expect(200);
      expect((await rows(c.id, requester.userId))[0]).toMatchObject({ status: 'active', approvedBy: mod.userId });
    });

    it('approving is idempotent for an already-active member', async () => {
      const { owner, c, requester } = await pendingRequest();
      await post(owner, `/communities/${c.id}/members/${requester.userId}/approve`).expect(200);
      const again = await post(owner, `/communities/${c.id}/members/${requester.userId}/approve`).expect(200);
      expect(again.body.data.status).toBe('active');
      expect(await rows(c.id, requester.userId)).toHaveLength(1);
    });

    it.each(['left', 'rejected', 'removed', 'banned'] as const)('approving someone whose membership is %s is 404 (there is no pending request), and changes nothing', async (status) => {
      const owner = await registerUser();
      const c = await createCommunity(owner);
      const u = await registerUser();
      await seedMembership(c.id, u.userId, status);
      expectError(await post(owner, `/communities/${c.id}/members/${u.userId}/approve`), 404, 'RESOURCE_NOT_FOUND');
      expect((await rows(c.id, u.userId))[0].status).toBe(status);
    });

    it('approving a user who never asked is 404', async () => {
      const owner = await registerUser();
      const c = await createCommunity(owner);
      expectError(await post(owner, `/communities/${c.id}/members/${(await registerUser()).userId}/approve`), 404, 'RESOURCE_NOT_FOUND');
    });

    it('rejecting a pending request marks it rejected; repeating it is a no-op; the user can ask again', async () => {
      const { owner, c, requester } = await pendingRequest();
      const res = await post(owner, `/communities/${c.id}/members/${requester.userId}/reject`).expect(200);
      expect(res.body.data).toEqual({ communityId: c.id, userId: requester.userId, status: 'rejected', role: 'member' });
      await post(owner, `/communities/${c.id}/members/${requester.userId}/reject`).expect(200);
      expect((await rows(c.id, requester.userId)).map((r) => r.status)).toEqual(['rejected']);

      expect((await put(requester, `/communities/${c.id}/membership`).expect(200)).body.data.status).toBe('pending');
      expect((await rows(c.id, requester.userId)).map((r) => r.status)).toEqual(['rejected', 'pending']);
    });

    it('rejecting an active member is 404 (only a pending request can be rejected), and does not remove them', async () => {
      const owner = await registerUser();
      const c = await createCommunity(owner);
      const member = await activeMember(c.id);
      expectError(await post(owner, `/communities/${c.id}/members/${member.userId}/reject`), 404, 'RESOURCE_NOT_FOUND');
      expect((await rows(c.id, member.userId))[0].status).toBe('active');
    });

    it('requires a session and CSRF, and an unknown community is 404', async () => {
      const { c, requester } = await pendingRequest();
      await request(app.getHttpServer()).post(`/api/v1/communities/${c.id}/members/${requester.userId}/approve`).expect(401);
      const owner = await registerUser();
      expectError(await post(owner, `/communities/${randomUUID()}/members/${requester.userId}/approve`), 404, 'RESOURCE_NOT_FOUND');
    });
  });

  // ================================================================ remove / roles

  describe('DELETE /communities/{id}/members/{userId} (remove)', () => {
    it('the owner removes a member or a moderator: status removed, removedAt set; repeating is a no-op', async () => {
      const owner = await registerUser();
      const c = await createCommunity(owner);
      const member = await activeMember(c.id);
      const mod = await activeMember(c.id, 'moderator');

      const res = await del(owner, `/communities/${c.id}/members/${member.userId}`).expect(200);
      expect(res.body.data).toEqual({ communityId: c.id, userId: member.userId, status: 'removed' });
      const r = (await rows(c.id, member.userId))[0];
      expect(r.status).toBe('removed');
      expect(r.removedAt).not.toBeNull();
      await del(owner, `/communities/${c.id}/members/${member.userId}`).expect(200);

      await del(owner, `/communities/${c.id}/members/${mod.userId}`).expect(200);
      expect((await rows(c.id, mod.userId))[0].status).toBe('removed');
    });

    it('a moderator can remove a plain member, but never another moderator or the owner', async () => {
      const owner = await registerUser();
      const c = await createCommunity(owner);
      const mod = await activeMember(c.id, 'moderator');
      const otherMod = await activeMember(c.id, 'moderator');
      const member = await activeMember(c.id);

      await del(mod, `/communities/${c.id}/members/${member.userId}`).expect(200);
      expectError(await del(mod, `/communities/${c.id}/members/${otherMod.userId}`), 403, 'FORBIDDEN');
      expectError(await del(mod, `/communities/${c.id}/members/${owner.userId}`), 422, 'POLICY_REJECTED');
      expect((await rows(c.id, otherMod.userId))[0].status).toBe('active');
    });

    it('a plain member and an outsider cannot remove anyone', async () => {
      const owner = await registerUser();
      const c = await createCommunity(owner);
      const member = await activeMember(c.id);
      const target = await activeMember(c.id);
      expectError(await del(member, `/communities/${c.id}/members/${target.userId}`), 403, 'FORBIDDEN');
      expectError(await del(await registerUser(), `/communities/${c.id}/members/${target.userId}`), 403, 'FORBIDDEN');
      expect((await rows(c.id, target.userId))[0].status).toBe('active');
    });

    it('the owner cannot be removed, and nobody removes themselves through this route', async () => {
      const owner = await registerUser();
      const c = await createCommunity(owner);
      const mod = await activeMember(c.id, 'moderator');
      expectError(await del(owner, `/communities/${c.id}/members/${owner.userId}`), 422, 'POLICY_REJECTED');
      expectError(await del(mod, `/communities/${c.id}/members/${mod.userId}`), 422, 'POLICY_REJECTED');
      expect((await rows(c.id, mod.userId))[0].status).toBe('active');
    });

    it.each(['pending', 'left', 'rejected', 'banned'] as const)('is 404 for a target whose membership is %s (not an active member), and leaves it unchanged', async (status) => {
      const owner = await registerUser();
      const c = await createCommunity(owner);
      const u = await registerUser();
      await seedMembership(c.id, u.userId, status);
      expectError(await del(owner, `/communities/${c.id}/members/${u.userId}`), 404, 'RESOURCE_NOT_FOUND');
      expect((await rows(c.id, u.userId))[0].status).toBe(status);
    });

    it('a removed member loses access to a private community', async () => {
      const owner = await registerUser();
      const c = await createCommunity(owner, { visibility: 'private' });
      const member = await activeMember(c.id);
      await get(member, `/communities/${c.id}/members`).expect(200);
      await del(owner, `/communities/${c.id}/members/${member.userId}`).expect(200);
      expectError(await get(member, `/communities/${c.id}/members`), 403, 'FORBIDDEN');
      expect((await get(member, `/communities/${c.id}`)).body.data.isPreview).toBe(true);
    });
  });

  describe('PATCH /communities/{id}/members/{userId} (set role)', () => {
    it('the owner promotes a member to moderator and demotes them again; the promoted moderator gains the powers and loses them on demotion', async () => {
      const owner = await registerUser();
      const c = await createCommunity(owner, { membershipPolicy: 'approval_required' });
      const member = await activeMember(c.id);
      const requester = await registerUser();
      await put(requester, `/communities/${c.id}/membership`).expect(200);

      expectError(await post(member, `/communities/${c.id}/members/${requester.userId}/approve`), 403, 'FORBIDDEN');
      expect((await patch(owner, `/communities/${c.id}/members/${member.userId}`, { role: 'moderator' }).expect(200)).body.data).toEqual({ communityId: c.id, userId: member.userId, role: 'moderator' });
      expect((await get(member, `/communities/${c.id}`)).body.data.viewer.role).toBe('moderator');
      await post(member, `/communities/${c.id}/members/${requester.userId}/approve`).expect(200);

      await patch(owner, `/communities/${c.id}/members/${member.userId}`, { role: 'member' }).expect(200);
      expectError(await post(member, `/communities/${c.id}/members/${(await registerUser()).userId}/approve`), 403, 'FORBIDDEN');
    });

    it('setting the role a member already has is a 200 no-op', async () => {
      const owner = await registerUser();
      const c = await createCommunity(owner);
      const mod = await activeMember(c.id, 'moderator');
      await patch(owner, `/communities/${c.id}/members/${mod.userId}`, { role: 'moderator' }).expect(200);
      expect((await rows(c.id, mod.userId))[0].role).toBe('moderator');
    });

    it('a moderator, a member and an outsider cannot change roles', async () => {
      const owner = await registerUser();
      const c = await createCommunity(owner);
      const mod = await activeMember(c.id, 'moderator');
      const member = await activeMember(c.id);
      for (const caller of [mod, member, await registerUser()]) {
        expectError(await patch(caller, `/communities/${c.id}/members/${member.userId}`, { role: 'moderator' }), 403, 'FORBIDDEN');
      }
      expect((await rows(c.id, member.userId))[0].role).toBe('member');
    });

    it.each(['owner', 'admin', 'Moderator', ''])('rejects the role %j', async (role) => {
      const owner = await registerUser();
      const c = await createCommunity(owner);
      const member = await activeMember(c.id);
      expectError(await patch(owner, `/communities/${c.id}/members/${member.userId}`, { role }), 422, 'VALIDATION_FAILED');
    });

    it('is 404 unless the target is an active member, and 422 for the owner', async () => {
      const owner = await registerUser();
      const c = await createCommunity(owner);
      for (const status of ['pending', 'left', 'removed', 'banned', 'rejected'] as const) {
        const u = await registerUser();
        await seedMembership(c.id, u.userId, status);
        expectError(await patch(owner, `/communities/${c.id}/members/${u.userId}`, { role: 'moderator' }), 404, 'RESOURCE_NOT_FOUND');
      }
      expectError(await patch(owner, `/communities/${c.id}/members/${randomUUID()}`, { role: 'moderator' }), 404, 'RESOURCE_NOT_FOUND');
      expectError(await patch(owner, `/communities/${c.id}/members/${owner.userId}`, { role: 'member' }), 422, 'POLICY_REJECTED');
    });
  });

  // ================================================================ members list

  describe('GET /communities/{id}/members', () => {
    it('requires authentication, even for a public community', async () => {
      const c = await createCommunity(await registerUser());
      expectError(await get(null, `/communities/${c.id}/members`), 401, 'AUTHENTICATION_REQUIRED');
    });

    it('lists active members oldest first with exact fields; excludes the owner and every non-active state', async () => {
      const owner = await registerUser();
      const c = await createCommunity(owner);
      const base = Date.now() - 3_600_000;
      const a = await registerUser();
      const b = await registerUser();
      await seedMembership(c.id, a.userId, 'active', 'member', new Date(base));
      await seedMembership(c.id, b.userId, 'active', 'moderator', new Date(base + 60_000));
      for (const status of ['pending', 'left', 'removed', 'banned', 'rejected'] as const) {
        await seedMembership(c.id, (await registerUser()).userId, status);
      }

      const res = await get(owner, `/communities/${c.id}/members`).expect(200);
      expect(res.body.data.map((m: { userId: string }) => m.userId)).toEqual([a.userId, b.userId]);
      expect(Object.keys(res.body.data[0]).sort()).toEqual(['displayName', 'handle', 'joinedAt', 'requestedAt', 'role', 'status', 'userId']);
      expect(res.body.data[0]).toMatchObject({ role: 'member', status: 'active' });
      expect(res.body.data[0].joinedAt).not.toBeNull();
      expect(res.body.data[1].role).toBe('moderator');
    });

    it('paginates without skipping or duplicating, including members created at the same instant', async () => {
      const owner = await registerUser();
      const c = await createCommunity(owner);
      const same = new Date(Date.now() - 600_000);
      const ids: string[] = [];
      for (let i = 0; i < 6; i++) {
        const u = await registerUser();
        ids.push(u.userId);
        await seedMembership(c.id, u.userId, 'active', 'member', i < 4 ? same : new Date(same.getTime() + i * 1000));
      }
      const all = (await get(owner, `/communities/${c.id}/members`).expect(200)).body.data.map((m: { userId: string }) => m.userId);
      expect(all).toHaveLength(6);
      expect(new Set(all)).toEqual(new Set(ids));

      for (const size of [1, 2, 4]) {
        const seen: string[] = [];
        let cursor: string | null = null;
        for (let guard = 0; guard < 20; guard++) {
          const res: request.Response = await get(owner, `/communities/${c.id}/members?limit=${size}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`).expect(200);
          seen.push(...res.body.data.map((m: { userId: string }) => m.userId));
          if (!res.body.meta.page.hasMore) break;
          cursor = res.body.meta.page.nextCursor as string;
        }
        expect(seen).toEqual(all);
      }
    });

    it('rejects a malformed cursor and any status other than active or pending', async () => {
      const owner = await registerUser();
      const c = await createCommunity(owner);
      expectError(await get(owner, `/communities/${c.id}/members?cursor=not-a-real-cursor!!`), 400, 'INVALID_CURSOR');
      for (const status of ['banned', 'rejected', 'left', 'removed', 'all']) {
        expectError(await get(owner, `/communities/${c.id}/members?status=${status}`), 422, 'VALIDATION_FAILED');
      }
    });

    it('a public community: any signed-in user can list active members; pending requests are for the owner and moderators only', async () => {
      const owner = await registerUser();
      const c = await createCommunity(owner, { membershipPolicy: 'approval_required' });
      const mod = await activeMember(c.id, 'moderator');
      const member = await activeMember(c.id);
      const requester = await registerUser();
      await put(requester, `/communities/${c.id}/membership`).expect(200);
      const outsider = await registerUser();

      await get(outsider, `/communities/${c.id}/members`).expect(200);
      for (const caller of [member, outsider]) {
        expectError(await get(caller, `/communities/${c.id}/members?status=pending`), 403, 'FORBIDDEN');
      }
      for (const caller of [owner, mod]) {
        const res = await get(caller, `/communities/${c.id}/members?status=pending`).expect(200);
        expect(res.body.data.map((m: { userId: string }) => m.userId)).toEqual([requester.userId]);
        expect(res.body.data[0]).toMatchObject({ status: 'pending', joinedAt: null });
        expect(res.body.data[0].requestedAt).not.toBeNull();
      }
    });

    it('a private community: members and the owner can list; a non-member (even signed in) is refused', async () => {
      const owner = await registerUser();
      const c = await createCommunity(owner, { visibility: 'private' });
      const member = await activeMember(c.id);
      await get(owner, `/communities/${c.id}/members`).expect(200);
      await get(member, `/communities/${c.id}/members`).expect(200);
      expectError(await get(await registerUser(), `/communities/${c.id}/members`), 403, 'FORBIDDEN');
      const pending = await registerUser();
      await seedMembership(c.id, pending.userId, 'pending');
      expectError(await get(pending, `/communities/${c.id}/members`), 403, 'FORBIDDEN');
    });

    it('is 404 for an unknown or deleted community', async () => {
      const owner = await registerUser();
      const c = await createCommunity(owner);
      expectError(await get(owner, `/communities/${randomUUID()}/members`), 404, 'RESOURCE_NOT_FOUND');
      await del(owner, `/communities/${c.id}`).expect(200);
      expectError(await get(owner, `/communities/${c.id}/members`), 404, 'RESOURCE_NOT_FOUND');
    });

    it.each([
      ['the viewer blocked the member', async (viewer: U, m: U) => post(viewer, `/users/${m.userId}/block`).expect(201)],
      ['the member blocked the viewer', async (viewer: U, m: U) => post(m, `/users/${viewer.userId}/block`).expect(201)],
    ])('hides a member when %s', async (_name, block) => {
      const owner = await registerUser();
      const c = await createCommunity(owner);
      const viewer = await activeMember(c.id);
      const blocked = await activeMember(c.id);
      const fine = await activeMember(c.id);
      await block(viewer, blocked);

      const ids = (await get(viewer, `/communities/${c.id}/members`).expect(200)).body.data.map((m: { userId: string }) => m.userId);
      expect(ids).toContain(fine.userId);
      expect(ids).not.toContain(blocked.userId);
      // the block only affects the two people involved
      expect((await get(fine, `/communities/${c.id}/members`)).body.data.map((m: { userId: string }) => m.userId)).toContain(blocked.userId);
    });

    it('excludes members whose account is no longer active', async () => {
      const owner = await registerUser();
      const c = await createCommunity(owner);
      const gone = await activeMember(c.id);
      const suspended = await activeMember(c.id);
      const fine = await activeMember(c.id);
      await prisma.user.update({ where: { id: gone.userId }, data: { deletedAt: new Date() } });
      await prisma.user.update({ where: { id: suspended.userId }, data: { status: 'suspended' } });

      const ids = (await get(owner, `/communities/${c.id}/members`).expect(200)).body.data.map((m: { userId: string }) => m.userId);
      expect(ids).toEqual([fine.userId]);
    });

    it('shows displayName only for a public profile (the same rule as notification actors)', async () => {
      const owner = await registerUser();
      const c = await createCommunity(owner);
      const open = await activeMember(c.id);
      const hidden = await activeMember(c.id);
      await prisma.profile.upsert({ where: { userId: open.userId }, create: { userId: open.userId, displayName: 'Open Person', visibility: 'public' }, update: { displayName: 'Open Person', visibility: 'public' } });
      await prisma.profile.upsert({ where: { userId: hidden.userId }, create: { userId: hidden.userId, displayName: 'Hidden Person', visibility: 'private' }, update: { displayName: 'Hidden Person', visibility: 'private' } });

      const items = (await get(owner, `/communities/${c.id}/members`).expect(200)).body.data as Array<{ userId: string; displayName: string | null }>;
      expect(items.find((m) => m.userId === open.userId)?.displayName).toBe('Open Person');
      expect(items.find((m) => m.userId === hidden.userId)?.displayName).toBeNull();
    });
  });
});
