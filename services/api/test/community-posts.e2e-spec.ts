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

// Wiring content.posts.community_id into the Content API. Rules under test (approved):
//  - posting in a community requires active membership (or being the owner);
//  - inside a community a post is `community_members` (default) or, in a PUBLIC community, `public`;
//  - the audience is the MORE RESTRICTIVE of the post's visibility and the community's, checked at
//    read time, so a community that turns private (or a post made for members) never leaks;
//  - commenting, reacting and sharing on a community post require active membership;
//  - community posts never appear on an author's profile listing.
describe('Community posts (e2e)', () => {
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
  const api = (path: string) => `/api/v1${path}`;

  function get(u: U | null, path: string) {
    const req = request(app.getHttpServer()).get(api(path));
    return u ? req.set(auth(u)) : req;
  }
  function post(u: U, path: string, body: object = {}) {
    return request(app.getHttpServer()).post(api(path)).set(auth(u)).send(body);
  }
  function put(u: U, path: string, body: object = {}) {
    return request(app.getHttpServer()).put(api(path)).set(auth(u)).send(body);
  }
  function patch(u: U, path: string, body: object) {
    return request(app.getHttpServer()).patch(api(path)).set(auth(u)).send(body);
  }
  function del(u: U, path: string) {
    return request(app.getHttpServer()).delete(api(path)).set(auth(u));
  }

  async function createCommunity(owner: U, body: Record<string, unknown> = {}) {
    const res = await post(owner, '/communities', { slug: slug(), name: 'Test Community', ...body }).expect(201);
    return res.body.data as { id: string };
  }

  async function seedMembership(communityId: string, userId: string, status: MembershipStatus, role = 'member') {
    await prisma.communityMembership.create({ data: { communityId, userId, status, role, approvedAt: status === 'active' ? new Date() : null } });
  }

  async function member(communityId: string, role = 'member'): Promise<U> {
    const u = await registerUser();
    await seedMembership(communityId, u.userId, 'active', role);
    return u;
  }

  // a community with an owner and an active member who authored nothing yet
  async function setup(body: Record<string, unknown> = {}) {
    const owner = await registerUser();
    const c = await createCommunity(owner, body);
    return { owner, c };
  }

  async function communityPost(author: U, communityId: string, visibility?: string, text = 'hello community') {
    const res = await post(author, '/posts', { body: text, communityId, ...(visibility && { visibility }) }).expect(201);
    return res.body.data as { id: string; visibility: string; communityId: string };
  }

  function expectError(res: request.Response, status: number, code: string) {
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
  }

  // ================================================================ creating

  describe('POST /posts with communityId', () => {
    it('a member, a moderator and the owner can post; the post is community_members by default and carries communityId', async () => {
      const { owner, c } = await setup();
      const m = await member(c.id);
      const mod = await member(c.id, 'moderator');
      for (const author of [owner, m, mod]) {
        const p = await communityPost(author, c.id);
        expect(p).toMatchObject({ communityId: c.id, visibility: 'community_members' });
      }
    });

    it('a post without a community still has communityId null (existing behavior unchanged)', async () => {
      const u = await registerUser();
      const res = await post(u, '/posts', { body: 'plain post' }).expect(201);
      expect(res.body.data).toMatchObject({ communityId: null, visibility: 'public' });
    });

    it.each(['pending', 'left', 'removed', 'banned', 'rejected'] as const)('a %s member cannot post (403), and no post is created', async (status) => {
      const { c } = await setup();
      const u = await registerUser();
      await seedMembership(c.id, u.userId, status);
      expectError(await post(u, '/posts', { body: 'nope', communityId: c.id }), 403, 'FORBIDDEN');
      expect(await prisma.post.count({ where: { authorId: u.userId } })).toBe(0);
    });

    it('a non-member cannot post, even in a public open community', async () => {
      const { c } = await setup();
      expectError(await post(await registerUser(), '/posts', { body: 'nope', communityId: c.id }), 403, 'FORBIDDEN');
    });

    it('an unknown, deleted or non-active community is 404, and a malformed communityId is 422', async () => {
      const { owner, c } = await setup();
      const gone = await createCommunity(owner);
      const suspended = await createCommunity(owner);
      await del(owner, `/communities/${gone.id}`).expect(200);
      await prisma.community.update({ where: { id: suspended.id }, data: { status: 'suspended' } });
      expectError(await post(owner, '/posts', { body: 'x', communityId: randomUUID() }), 404, 'RESOURCE_NOT_FOUND');
      expectError(await post(owner, '/posts', { body: 'x', communityId: gone.id }), 404, 'RESOURCE_NOT_FOUND');
      expectError(await post(owner, '/posts', { body: 'x', communityId: suspended.id }), 404, 'RESOURCE_NOT_FOUND');
      const res = await post(owner, '/posts', { body: 'x', communityId: 'not-a-uuid' });
      expectError(res, 422, 'VALIDATION_FAILED');
      expect(res.body.error.details.map((d: { field: string }) => d.field)).toContain('communityId');
      await post(owner, '/posts', { body: 'x', communityId: c.id }).expect(201);
    });

    describe('visibility inside a community', () => {
      it('a public community allows public and community_members', async () => {
        const { owner, c } = await setup({ visibility: 'public' });
        expect((await communityPost(owner, c.id, 'public')).visibility).toBe('public');
        expect((await communityPost(owner, c.id, 'community_members')).visibility).toBe('community_members');
      });

      it('a private community allows only community_members: public is refused with 422 POLICY_REJECTED', async () => {
        const { owner, c } = await setup({ visibility: 'private' });
        expectError(await post(owner, '/posts', { body: 'x', communityId: c.id, visibility: 'public' }), 422, 'POLICY_REJECTED');
        expect((await communityPost(owner, c.id, 'community_members')).visibility).toBe('community_members');
      });

      it.each(['followers', 'private'])('%s is not a valid audience for a community post', async (visibility) => {
        const { owner, c } = await setup();
        const res = await post(owner, '/posts', { body: 'x', communityId: c.id, visibility });
        expectError(res, 422, 'VALIDATION_FAILED');
        expect(res.body.error.details.map((d: { field: string }) => d.field)).toContain('visibility');
      });

      it('community_members without a communityId is refused', async () => {
        const res = await post(await registerUser(), '/posts', { body: 'x', visibility: 'community_members' });
        expectError(res, 422, 'VALIDATION_FAILED');
        expect(res.body.error.details.map((d: { field: string }) => d.field)).toContain('visibility');
      });
    });
  });

  // ================================================================ reading one post

  describe('GET /posts/{id} for a community post', () => {
    it('a community_members post is readable by the owner and active members only, even in a public community', async () => {
      const { owner, c } = await setup({ visibility: 'public' });
      const author = await member(c.id);
      const p = await communityPost(author, c.id, 'community_members');
      const other = await member(c.id);
      const mod = await member(c.id, 'moderator');

      for (const viewer of [author, owner, other, mod]) await get(viewer, `/posts/${p.id}`).expect(200);

      const outsider = await registerUser();
      expectError(await get(outsider, `/posts/${p.id}`), 404, 'RESOURCE_NOT_FOUND');
      expectError(await get(null, `/posts/${p.id}`), 404, 'RESOURCE_NOT_FOUND');
      for (const status of ['pending', 'left', 'removed', 'banned', 'rejected'] as const) {
        const u = await registerUser();
        await seedMembership(c.id, u.userId, status);
        expectError(await get(u, `/posts/${p.id}`), 404, 'RESOURCE_NOT_FOUND');
      }
    });

    it('a public post in a public community is readable by anyone, anonymous included', async () => {
      const { owner, c } = await setup({ visibility: 'public' });
      const p = await communityPost(owner, c.id, 'public');
      await get(null, `/posts/${p.id}`).expect(200);
      await get(await registerUser(), `/posts/${p.id}`).expect(200);
    });

    it('when a community turns private, its formerly public posts become members-only', async () => {
      const { owner, c } = await setup({ visibility: 'public' });
      const p = await communityPost(owner, c.id, 'public');
      const m = await member(c.id);
      const outsider = await registerUser();
      await get(outsider, `/posts/${p.id}`).expect(200);

      await patch(owner, `/communities/${c.id}`, { visibility: 'private' }).expect(200);
      expectError(await get(outsider, `/posts/${p.id}`), 404, 'RESOURCE_NOT_FOUND');
      expectError(await get(null, `/posts/${p.id}`), 404, 'RESOURCE_NOT_FOUND');
      await get(m, `/posts/${p.id}`).expect(200);
    });

    it('when a private community turns public, its members-only posts stay members-only', async () => {
      const { owner, c } = await setup({ visibility: 'private' });
      const p = await communityPost(owner, c.id, 'community_members');
      await patch(owner, `/communities/${c.id}`, { visibility: 'public' }).expect(200);
      expectError(await get(await registerUser(), `/posts/${p.id}`), 404, 'RESOURCE_NOT_FOUND');
      expectError(await get(null, `/posts/${p.id}`), 404, 'RESOURCE_NOT_FOUND');
      await get(owner, `/posts/${p.id}`).expect(200);
    });

    it('a member who leaves loses access to members-only posts', async () => {
      const { c } = await setup();
      const m = await member(c.id);
      const author = await member(c.id);
      const p = await communityPost(author, c.id);
      await get(m, `/posts/${p.id}`).expect(200);
      await del(m, `/communities/${c.id}/membership`).expect(200);
      expectError(await get(m, `/posts/${p.id}`), 404, 'RESOURCE_NOT_FOUND');
    });

    it('a deleted community hides its posts from everyone, but the author can still delete their own post', async () => {
      const { owner, c } = await setup({ visibility: 'public' });
      const author = await member(c.id);
      const p = await communityPost(author, c.id, 'public');
      await del(owner, `/communities/${c.id}`).expect(200);
      for (const viewer of [author, owner, null]) expectError(await get(viewer, `/posts/${p.id}`), 404, 'RESOURCE_NOT_FOUND');
      await del(author, `/posts/${p.id}`).expect(200);
    });

    it('a community that is not active hides its posts', async () => {
      const { owner, c } = await setup({ visibility: 'public' });
      const p = await communityPost(owner, c.id, 'public');
      await prisma.community.update({ where: { id: c.id }, data: { status: 'suspended' } });
      expectError(await get(owner, `/posts/${p.id}`), 404, 'RESOURCE_NOT_FOUND');
    });

    it.each([
      ['the author blocked the viewer', async (author: U, viewer: U) => post(author, `/users/${viewer.userId}/block`).expect(201)],
      ['the viewer blocked the author', async (author: U, viewer: U) => post(viewer, `/users/${author.userId}/block`).expect(201)],
    ])('the existing block rule still applies inside a community when %s', async (_name, block) => {
      const { c } = await setup();
      const author = await member(c.id);
      const viewer = await member(c.id);
      const p = await communityPost(author, c.id);
      await get(viewer, `/posts/${p.id}`).expect(200);
      await block(author, viewer);
      expectError(await get(viewer, `/posts/${p.id}`), 404, 'RESOURCE_NOT_FOUND');
    });

    it('a post by an author who is no longer active is hidden (existing rule)', async () => {
      const { c } = await setup();
      const author = await member(c.id);
      const viewer = await member(c.id);
      const p = await communityPost(author, c.id);
      await prisma.user.update({ where: { id: author.userId }, data: { status: 'suspended' } });
      expectError(await get(viewer, `/posts/${p.id}`), 404, 'RESOURCE_NOT_FOUND');
    });
  });

  // ================================================================ participating

  describe('commenting, reacting and sharing on a community post require membership', () => {
    async function publicPost() {
      const { owner, c } = await setup({ visibility: 'public' });
      const author = await member(c.id);
      const p = await communityPost(author, c.id, 'public'); // visible to everyone...
      return { owner, c, author, p };
    }

    it('a member comments, reacts and shares; the owner too', async () => {
      const { owner, c, p } = await publicPost();
      const m = await member(c.id);
      for (const u of [m, owner]) {
        await post(u, `/posts/${p.id}/comments`, { body: 'nice' }).expect(201);
        await put(u, `/posts/${p.id}/reaction`, { type: 'like' }).expect(200);
        await post(u, `/posts/${p.id}/shares`, {}).expect(201);
      }
    });

    it('...but a non-member who can SEE the public post cannot participate (403), while reading its comments is fine', async () => {
      const { p } = await publicPost();
      const outsider = await registerUser();
      await get(outsider, `/posts/${p.id}`).expect(200);
      await get(outsider, `/posts/${p.id}/comments`).expect(200);
      expectError(await post(outsider, `/posts/${p.id}/comments`, { body: 'hi' }), 403, 'FORBIDDEN');
      expectError(await put(outsider, `/posts/${p.id}/reaction`, { type: 'like' }), 403, 'FORBIDDEN');
      expectError(await post(outsider, `/posts/${p.id}/shares`, {}), 403, 'FORBIDDEN');
    });

    it.each(['pending', 'left', 'removed', 'banned', 'rejected'] as const)('a %s member cannot comment, react or share (a ban cannot be bypassed through visibility)', async (status) => {
      const { c, p } = await publicPost();
      const u = await registerUser();
      await seedMembership(c.id, u.userId, status);
      expectError(await post(u, `/posts/${p.id}/comments`, { body: 'hi' }), 403, 'FORBIDDEN');
      expectError(await put(u, `/posts/${p.id}/reaction`, { type: 'like' }), 403, 'FORBIDDEN');
      expectError(await post(u, `/posts/${p.id}/shares`, {}), 403, 'FORBIDDEN');
    });

    it('replies and comment reactions are gated the same way', async () => {
      const { c, p } = await publicPost();
      const m = await member(c.id);
      const outsider = await registerUser();
      const comment = (await post(m, `/posts/${p.id}/comments`, { body: 'top' }).expect(201)).body.data;
      expectError(await post(outsider, `/posts/${p.id}/comments`, { body: 'reply', parentCommentId: comment.id }), 403, 'FORBIDDEN');
      expectError(await put(outsider, `/comments/${comment.id}/reaction`, { type: 'like' }), 403, 'FORBIDDEN');
      await post(m, `/posts/${p.id}/comments`, { body: 'reply', parentCommentId: comment.id }).expect(201);
      await put(m, `/comments/${comment.id}/reaction`, { type: 'like' }).expect(200);
    });

    it('a former member can still withdraw a reaction they made (removal is not gated)', async () => {
      const { c, p } = await publicPost();
      const m = await member(c.id);
      await put(m, `/posts/${p.id}/reaction`, { type: 'like' }).expect(200);
      await del(m, `/communities/${c.id}/membership`).expect(200);
      await del(m, `/posts/${p.id}/reaction`).expect(200);
    });

    it('ordinary posts are unaffected: anyone who can see them can still interact', async () => {
      const author = await registerUser();
      const p = (await post(author, '/posts', { body: 'plain' }).expect(201)).body.data;
      const other = await registerUser();
      await post(other, `/posts/${p.id}/comments`, { body: 'hi' }).expect(201);
      await put(other, `/posts/${p.id}/reaction`, { type: 'like' }).expect(200);
    });
  });

  // ================================================================ shares listing

  describe("GET /users/{id}/shares of community posts", () => {
    it("shows a share of a community post only to viewers who may read that post, re-evaluated at read time", async () => {
      const { owner, c } = await setup({ visibility: 'public' });
      const sharer = await member(c.id);
      const publicPost = await communityPost(owner, c.id, 'public');
      const membersPost = await communityPost(owner, c.id, 'community_members');
      const sharePublic = (await post(sharer, `/posts/${publicPost.id}/shares`, {}).expect(201)).body.data;
      const shareMembers = (await post(sharer, `/posts/${membersPost.id}/shares`, {}).expect(201)).body.data;

      const listed = async (viewer: U | null) =>
        (await get(viewer, `/users/${sharer.userId}/shares`).expect(200)).body.data.map((s: { id: string }) => s.id).sort();

      const outsider = await registerUser();
      expect(await listed(outsider)).toEqual([sharePublic.id]);
      expect(await listed(null)).toEqual([sharePublic.id]);
      expect(await listed(await member(c.id))).toEqual([sharePublic.id, shareMembers.id].sort());

      // when the community turns private, even the share of the formerly public post disappears for outsiders
      await patch(owner, `/communities/${c.id}`, { visibility: 'private' }).expect(200);
      expect(await listed(outsider)).toEqual([]);
      expect(await listed(sharer)).toEqual([sharePublic.id, shareMembers.id].sort());
    });
  });

  // ================================================================ profile listing

  describe('GET /users/{id}/posts', () => {
    it('never lists community posts, not even to the author, but still lists ordinary posts', async () => {
      const { c } = await setup({ visibility: 'public' });
      const author = await member(c.id);
      await communityPost(author, c.id, 'public');
      await communityPost(author, c.id, 'community_members');
      const plain = (await post(author, '/posts', { body: 'plain' }).expect(201)).body.data;

      for (const viewer of [author, await registerUser(), await member(c.id)]) {
        const res = await get(viewer, `/users/${author.userId}/posts`).expect(200);
        expect(res.body.data.map((x: { id: string }) => x.id)).toEqual([plain.id]);
      }
    });
  });

  // ================================================================ community post list

  describe('GET /communities/{id}/posts', () => {
    it('a member sees public and members-only posts, newest first; a non-member and an anonymous caller see only the public ones', async () => {
      const { owner, c } = await setup({ visibility: 'public' });
      const m = await member(c.id);
      const a = await communityPost(m, c.id, 'community_members', 'first');
      const b = await communityPost(m, c.id, 'public', 'second');
      const d = await communityPost(owner, c.id, 'community_members', 'third');

      const asMember = await get(m, `/communities/${c.id}/posts`).expect(200);
      expect(asMember.body.data.map((x: { id: string }) => x.id)).toEqual([d.id, b.id, a.id]);
      for (const x of asMember.body.data) expect(x.communityId).toBe(c.id);

      for (const viewer of [await registerUser(), null]) {
        const res = await get(viewer, `/communities/${c.id}/posts`).expect(200);
        expect(res.body.data.map((x: { id: string }) => x.id)).toEqual([b.id]);
      }
    });

    it('a private community: anonymous is 404, a signed-in non-member (or pending requester) is 403, members are fine', async () => {
      const { owner, c } = await setup({ visibility: 'private' });
      const m = await member(c.id);
      await communityPost(m, c.id);
      expectError(await get(null, `/communities/${c.id}/posts`), 404, 'RESOURCE_NOT_FOUND');
      expectError(await get(await registerUser(), `/communities/${c.id}/posts`), 403, 'FORBIDDEN');
      const pending = await registerUser();
      await seedMembership(c.id, pending.userId, 'pending');
      expectError(await get(pending, `/communities/${c.id}/posts`), 403, 'FORBIDDEN');
      await get(m, `/communities/${c.id}/posts`).expect(200);
      await get(owner, `/communities/${c.id}/posts`).expect(200);
    });

    it('is 404 for an unknown, deleted or non-active community', async () => {
      const { owner, c } = await setup();
      const suspended = await createCommunity(owner);
      await prisma.community.update({ where: { id: suspended.id }, data: { status: 'suspended' } });
      expectError(await get(owner, `/communities/${randomUUID()}/posts`), 404, 'RESOURCE_NOT_FOUND');
      expectError(await get(owner, `/communities/${suspended.id}/posts`), 404, 'RESOURCE_NOT_FOUND');
      await del(owner, `/communities/${c.id}`).expect(200);
      expectError(await get(owner, `/communities/${c.id}/posts`), 404, 'RESOURCE_NOT_FOUND');
    });

    it('excludes deleted and non-published posts, and posts by authors who are no longer active', async () => {
      const { owner, c } = await setup();
      const author = await member(c.id);
      const gone = await member(c.id);
      const kept = await communityPost(author, c.id);
      const deleted = await communityPost(author, c.id);
      const hidden = await communityPost(author, c.id);
      await communityPost(gone, c.id);
      await del(author, `/posts/${deleted.id}`).expect(200);
      await prisma.post.update({ where: { id: hidden.id }, data: { status: 'hidden' } });
      await prisma.user.update({ where: { id: gone.userId }, data: { status: 'suspended' } });

      const ids = (await get(owner, `/communities/${c.id}/posts`).expect(200)).body.data.map((x: { id: string }) => x.id);
      expect(ids).toEqual([kept.id]);
    });

    it.each([
      ['the viewer blocked the author', async (author: U, viewer: U) => post(viewer, `/users/${author.userId}/block`).expect(201)],
      ['the author blocked the viewer', async (author: U, viewer: U) => post(author, `/users/${viewer.userId}/block`).expect(201)],
    ])("hides a blocked author's posts when %s (only for the two involved)", async (_name, block) => {
      const { c } = await setup();
      const viewer = await member(c.id);
      const author = await member(c.id);
      const bystander = await member(c.id);
      const p = await communityPost(author, c.id);
      await block(author, viewer);
      expect((await get(viewer, `/communities/${c.id}/posts`).expect(200)).body.data).toEqual([]);
      expect((await get(bystander, `/communities/${c.id}/posts`).expect(200)).body.data.map((x: { id: string }) => x.id)).toEqual([p.id]);
    });

    it('paginates without skipping or duplicating, and clamps the limit', async () => {
      const { owner, c } = await setup();
      const ids: string[] = [];
      for (let i = 0; i < 7; i++) ids.push((await communityPost(owner, c.id, undefined, `post ${i}`)).id);
      const all = (await get(owner, `/communities/${c.id}/posts`).expect(200)).body.data.map((x: { id: string }) => x.id);
      expect(all).toEqual([...ids].reverse());

      for (const size of [1, 3]) {
        const seen: string[] = [];
        let cursor: string | null = null;
        for (let guard = 0; guard < 20; guard++) {
          const res: request.Response = await get(owner, `/communities/${c.id}/posts?limit=${size}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`).expect(200);
          seen.push(...res.body.data.map((x: { id: string }) => x.id));
          if (!res.body.meta.page.hasMore) break;
          cursor = res.body.meta.page.nextCursor as string;
        }
        expect(seen).toEqual(all);
      }
      expect((await get(owner, `/communities/${c.id}/posts?limit=500`)).status).toBe(200);
      expectError(await get(owner, `/communities/${c.id}/posts?cursor=not-a-real-cursor!!`), 400, 'INVALID_CURSOR');
    });

    it('posts stay in the community after their author leaves or is removed', async () => {
      const { owner, c } = await setup();
      const author = await member(c.id);
      const p = await communityPost(author, c.id);
      await del(owner, `/communities/${c.id}/members/${author.userId}`).expect(200);
      expect((await get(owner, `/communities/${c.id}/posts`).expect(200)).body.data.map((x: { id: string }) => x.id)).toEqual([p.id]);
    });
  });

  // ================================================================ editing

  describe('PATCH /posts/{id} on a community post', () => {
    it('the body can be edited; visibility can move between public (public community only) and community_members', async () => {
      const { owner, c } = await setup({ visibility: 'public' });
      const p = await communityPost(owner, c.id, 'community_members');
      expect((await patch(owner, `/posts/${p.id}`, { body: 'edited' }).expect(200)).body.data.body).toBe('edited');
      expect((await patch(owner, `/posts/${p.id}`, { visibility: 'public' }).expect(200)).body.data.visibility).toBe('public');
      expect((await patch(owner, `/posts/${p.id}`, { visibility: 'community_members' }).expect(200)).body.data.visibility).toBe('community_members');
    });

    it.each(['followers', 'private'])('%s is refused for a community post', async (visibility) => {
      const { owner, c } = await setup();
      const p = await communityPost(owner, c.id);
      expectError(await patch(owner, `/posts/${p.id}`, { visibility }), 422, 'VALIDATION_FAILED');
    });

    it('public is refused for a post in a private community', async () => {
      const { owner, c } = await setup({ visibility: 'private' });
      const p = await communityPost(owner, c.id);
      expectError(await patch(owner, `/posts/${p.id}`, { visibility: 'public' }), 422, 'POLICY_REJECTED');
    });

    it('community_members is refused for an ordinary post, and a post cannot be moved into a community', async () => {
      const u = await registerUser();
      const c = await createCommunity(u);
      const plain = (await post(u, '/posts', { body: 'plain' }).expect(201)).body.data;
      expectError(await patch(u, `/posts/${plain.id}`, { visibility: 'community_members' }), 422, 'VALIDATION_FAILED');
      expectError(await patch(u, `/posts/${plain.id}`, { communityId: c.id }), 422, 'VALIDATION_FAILED');
      expect((await get(u, `/posts/${plain.id}`)).body.data.communityId).toBeNull();
    });
  });
});
