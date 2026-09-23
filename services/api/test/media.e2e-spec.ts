import 'reflect-metadata';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { PrismaService } from '../src/common/prisma/prisma.service';

type U = { userId: string; cookies: Record<string, string> };

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

describe('Media (e2e)', () => {
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

  function post(u: U | null, path: string, body?: object) {
    const req = request(app.getHttpServer()).post(`/api/v1${path}`);
    return u ? req.set(auth(u)).send(body ?? {}) : req.send(body ?? {});
  }
  function get(u: U | null, path: string) {
    const req = request(app.getHttpServer()).get(`/api/v1${path}`);
    return u ? req.set(auth(u)) : req;
  }
  function del(u: U | null, path: string) {
    const req = request(app.getHttpServer()).delete(`/api/v1${path}`);
    return u ? req.set(auth(u)) : req;
  }

  function expectError(res: request.Response, status: number, code: string) {
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
  }

  const validBody = (overrides: Record<string, unknown> = {}) => ({
    kind: 'image',
    purpose: 'post',
    declaredMimeType: 'image/png',
    declaredByteSize: 1000,
    ...overrides,
  });

  async function initUpload(u: U, overrides: Record<string, unknown> = {}) {
    const res = await post(u, '/media/uploads', validBody(overrides)).expect(201);
    return res.body.data as { assetId: string; uploadId: string; uploadUrl: string; expiresAt: string };
  }

  // ================================================================ init

  describe('POST /media/uploads', () => {
    it('requires authentication and CSRF', async () => {
      await request(app.getHttpServer()).post('/api/v1/media/uploads').send(validBody()).expect(401);
      const u = await registerUser();
      await request(app.getHttpServer())
        .post('/api/v1/media/uploads')
        .set('Cookie', `afrilink_at=${u.cookies['afrilink_at']}; afrilink_csrf=${u.cookies['afrilink_csrf']}`)
        .send(validBody())
        .expect(403);
    });

    it('creates a pending asset and an upload reservation owned by the caller, and returns a signed upload URL', async () => {
      const u = await registerUser();
      const res = await post(u, '/media/uploads', validBody()).expect(201);
      expect(Object.keys(res.body.data).sort()).toEqual(['assetId', 'expiresAt', 'uploadId', 'uploadUrl'].sort());
      expect(res.body.data.uploadUrl).toMatch(/^https?:\/\//);

      const asset = await prisma.asset.findUniqueOrThrow({ where: { id: res.body.data.assetId } });
      expect(asset).toMatchObject({ ownerUserId: u.userId, kind: 'image', purpose: 'post', state: 'pending', scanState: 'pending', moderationState: 'active' });
      expect(asset.storageKey).toContain(asset.id);
      expect(asset.storageKey).toContain(u.userId);

      const upload = await prisma.upload.findUniqueOrThrow({ where: { id: res.body.data.uploadId } });
      expect(upload).toMatchObject({ ownerUserId: u.userId, assetId: asset.id, status: 'reserved', expectedByteSize: 1000n });
      expect(upload.expiresAt.getTime()).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
      expect(upload.expiresAt.getTime()).toBeLessThan(Date.now() + 25 * 60 * 60 * 1000);
    });

    it.each(['avatar', 'cover', 'message_attachment'] as const)('accepts kind=image for purpose=%s', async (purpose) => {
      const u = await registerUser();
      await post(u, '/media/uploads', validBody({ purpose })).expect(201);
    });

    it('accepts kind=video only for purpose=post', async () => {
      const u = await registerUser();
      const res = await post(u, '/media/uploads', validBody({ kind: 'video', purpose: 'post', declaredMimeType: 'video/mp4', declaredByteSize: 5000 })).expect(201);
      const asset = await prisma.asset.findUniqueOrThrow({ where: { id: res.body.data.assetId } });
      expect(asset.kind).toBe('video');
    });

    it.each(['avatar', 'cover', 'message_attachment'] as const)('rejects kind=video for purpose=%s with 422 POLICY_REJECTED, and creates nothing', async (purpose) => {
      const u = await registerUser();
      const before = await prisma.asset.count({ where: { ownerUserId: u.userId } });
      expectError(await post(u, '/media/uploads', validBody({ kind: 'video', purpose, declaredMimeType: 'video/mp4' })), 422, 'POLICY_REJECTED');
      expect(await prisma.asset.count({ where: { ownerUserId: u.userId } })).toBe(before);
    });

    it.each(['image/gif', 'image/svg+xml', 'application/pdf', 'text/html', ''])('rejects declaredMimeType %j with 422 VALIDATION_FAILED', async (mime) => {
      const u = await registerUser();
      expectError(await post(u, '/media/uploads', validBody({ declaredMimeType: mime })), 422, 'VALIDATION_FAILED');
    });

    it('rejects a video MIME type when kind=image, and an image MIME type when kind=video', async () => {
      const u = await registerUser();
      expectError(await post(u, '/media/uploads', validBody({ kind: 'image', declaredMimeType: 'video/mp4' })), 422, 'VALIDATION_FAILED');
      expectError(await post(u, '/media/uploads', validBody({ kind: 'video', purpose: 'post', declaredMimeType: 'image/png' })), 422, 'VALIDATION_FAILED');
    });

    it('rejects an unknown kind or purpose with 422', async () => {
      const u = await registerUser();
      expectError(await post(u, '/media/uploads', validBody({ kind: 'audio' })), 422, 'VALIDATION_FAILED');
      expectError(await post(u, '/media/uploads', validBody({ purpose: 'banner' })), 422, 'VALIDATION_FAILED');
    });

    it('rejects an image declaredByteSize over 10 MB with 422 VALIDATION_FAILED, and accepts exactly 10 MB', async () => {
      const u = await registerUser();
      const res = await post(u, '/media/uploads', validBody({ declaredByteSize: 10 * 1024 * 1024 + 1 }));
      expectError(res, 422, 'VALIDATION_FAILED');
      expect(res.body.error.details.map((d: { field: string }) => d.field)).toContain('declaredByteSize');
      await post(u, '/media/uploads', validBody({ declaredByteSize: 10 * 1024 * 1024 })).expect(201);
    });

    it('rejects a video declaredByteSize over 100 MB with 422, and accepts exactly 100 MB', async () => {
      const u = await registerUser();
      const over = validBody({ kind: 'video', purpose: 'post', declaredMimeType: 'video/mp4', declaredByteSize: 100 * 1024 * 1024 + 1 });
      expectError(await post(u, '/media/uploads', over), 422, 'VALIDATION_FAILED');
      await post(u, '/media/uploads', validBody({ kind: 'video', purpose: 'post', declaredMimeType: 'video/mp4', declaredByteSize: 100 * 1024 * 1024 })).expect(201);
    });

    it('rejects a declared video duration over 120 seconds with 422, and accepts exactly 120', async () => {
      const u = await registerUser();
      const over = validBody({ kind: 'video', purpose: 'post', declaredMimeType: 'video/mp4', declaredDurationSeconds: 121 });
      expectError(await post(u, '/media/uploads', over), 422, 'VALIDATION_FAILED');
      await post(u, '/media/uploads', validBody({ kind: 'video', purpose: 'post', declaredMimeType: 'video/mp4', declaredDurationSeconds: 120 })).expect(201);
    });

    it('rejects declaredDurationSeconds for kind=image', async () => {
      const u = await registerUser();
      expectError(await post(u, '/media/uploads', validBody({ declaredDurationSeconds: 10 })), 422, 'VALIDATION_FAILED');
    });

    it.each(['ownerUserId', 'state', 'scanState', 'moderationState', 'storageKey', 'storageProvider', 'id', 'verifiedMimeType', 'filename', 'checksum'])('rejects the mass-assigned field %s', async (field) => {
      const u = await registerUser();
      expectError(await post(u, '/media/uploads', validBody({ [field]: randomUUID() })), 422, 'VALIDATION_FAILED');
    });

    it('the object key is always server-derived from the owner and asset id — never client-influenced, never a client filename', async () => {
      const u = await registerUser();
      const { assetId } = await initUpload(u);
      const asset = await prisma.asset.findUniqueOrThrow({ where: { id: assetId } });
      expect(asset.storageKey).toBe(`media/${u.userId}/${assetId}/original`);
    });

    it('the signed upload URL carries a short-lived expiry (~60 minutes), never a permanent or unsigned link', async () => {
      const u = await registerUser();
      const { uploadUrl } = await initUpload(u);
      const url = new URL(uploadUrl);
      const expiresParam = url.searchParams.get('X-Amz-Expires');
      expect(expiresParam).not.toBeNull();
      expect(Number(expiresParam)).toBe(60 * 60);
      expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
    });

    it('declaredByteSize and declaredChecksum are optional', async () => {
      const u = await registerUser();
      await post(u, '/media/uploads', { kind: 'image', purpose: 'post', declaredMimeType: 'image/png' }).expect(201);
    });
  });

  // ================================================================ complete

  describe('POST /media/uploads/{id}/complete', () => {
    it('requires authentication and CSRF', async () => {
      const u = await registerUser();
      const { uploadId } = await initUpload(u);
      await request(app.getHttpServer()).post(`/api/v1/media/uploads/${uploadId}/complete`).expect(401);
      await request(app.getHttpServer())
        .post(`/api/v1/media/uploads/${uploadId}/complete`)
        .set('Cookie', `afrilink_at=${u.cookies['afrilink_at']}; afrilink_csrf=${u.cookies['afrilink_csrf']}`)
        .expect(403);
    });

    it('transitions the upload to completed and the asset to processing', async () => {
      const u = await registerUser();
      const { assetId, uploadId } = await initUpload(u);
      const res = await post(u, `/media/uploads/${uploadId}/complete`).expect(200);
      expect(res.body.data).toEqual({ assetId, state: 'processing' });

      const upload = await prisma.upload.findUniqueOrThrow({ where: { id: uploadId } });
      expect(upload.status).toBe('completed');
      expect(upload.completedAt).not.toBeNull();
      const asset = await prisma.asset.findUniqueOrThrow({ where: { id: assetId } });
      expect(asset.state).toBe('processing');
    });

    it('is idempotent: completing an already-completed upload is a 200 no-op, not an error', async () => {
      const u = await registerUser();
      const { uploadId, assetId } = await initUpload(u);
      await post(u, `/media/uploads/${uploadId}/complete`).expect(200);
      const second = await post(u, `/media/uploads/${uploadId}/complete`).expect(200);
      expect(second.body.data).toEqual({ assetId, state: 'processing' });
      expect((await prisma.upload.findMany({ where: { id: uploadId } })).length).toBe(1);
    });

    it('is 404 for a nonexistent upload', async () => {
      const u = await registerUser();
      expectError(await post(u, `/media/uploads/${randomUUID()}/complete`), 404, 'RESOURCE_NOT_FOUND');
    });

    it("is 404 for another user's upload, and changes nothing", async () => {
      const owner = await registerUser();
      const stranger = await registerUser();
      const { uploadId, assetId } = await initUpload(owner);
      expectError(await post(stranger, `/media/uploads/${uploadId}/complete`), 404, 'RESOURCE_NOT_FOUND');
      expect((await prisma.asset.findUniqueOrThrow({ where: { id: assetId } })).state).toBe('pending');
    });

    it('is 422 POLICY_REJECTED for an expired reservation, and moves the upload to expired and the asset to rejected', async () => {
      const u = await registerUser();
      const { uploadId, assetId } = await initUpload(u);
      await prisma.upload.update({ where: { id: uploadId }, data: { expiresAt: new Date(Date.now() - 1000) } });

      expectError(await post(u, `/media/uploads/${uploadId}/complete`), 422, 'POLICY_REJECTED');

      const upload = await prisma.upload.findUniqueOrThrow({ where: { id: uploadId } });
      expect(upload.status).toBe('expired');
      const asset = await prisma.asset.findUniqueOrThrow({ where: { id: assetId } });
      expect(asset.state).toBe('rejected');
      expect(asset.rejectedAt).not.toBeNull();

      // repeating it afterward stays 422, does not re-transition or throw differently
      expectError(await post(u, `/media/uploads/${uploadId}/complete`), 422, 'POLICY_REJECTED');
    });

    it('is 422 POLICY_REJECTED for an already-failed upload', async () => {
      const u = await registerUser();
      const { uploadId } = await initUpload(u);
      await prisma.upload.update({ where: { id: uploadId }, data: { status: 'failed' } });
      expectError(await post(u, `/media/uploads/${uploadId}/complete`), 422, 'POLICY_REJECTED');
    });
  });

  // ================================================================ get

  describe('GET /media/{id}', () => {
    it('requires authentication', async () => {
      const u = await registerUser();
      const { assetId } = await initUpload(u);
      await request(app.getHttpServer()).get(`/api/v1/media/${assetId}`).expect(401);
    });

    it("returns the owner's asset metadata with an empty variants array (no worker yet)", async () => {
      const u = await registerUser();
      const { assetId } = await initUpload(u);
      const res = await get(u, `/media/${assetId}`).expect(200);
      expect(Object.keys(res.body.data).sort()).toEqual(
        ['createdAt', 'declaredMimeType', 'durationSeconds', 'heightPx', 'id', 'kind', 'moderationState', 'purpose', 'readyAt', 'rejectedAt', 'scanState', 'state', 'updatedAt', 'variants', 'verifiedMimeType', 'widthPx', 'byteSize'].sort(),
      );
      expect(res.body.data).toMatchObject({ id: assetId, kind: 'image', purpose: 'post', state: 'pending', variants: [] });
      expect(res.body.data.verifiedMimeType).toBeNull();
      // private storage details are never exposed
      expect(res.body.data.storageKey).toBeUndefined();
      expect(res.body.data.storageProvider).toBeUndefined();
      expect(res.body.data.checksum).toBeUndefined();
    });

    it("is 404 for another user's asset (never disambiguated from not-found)", async () => {
      const owner = await registerUser();
      const stranger = await registerUser();
      const { assetId } = await initUpload(owner);
      const real = await get(stranger, `/media/${assetId}`);
      const fake = await get(stranger, `/media/${randomUUID()}`);
      expectError(real, 404, 'RESOURCE_NOT_FOUND');
      expect(real.body.error.message).toBe(fake.body.error.message);
    });

    it('is 404 for an unknown asset', async () => {
      const u = await registerUser();
      expectError(await get(u, `/media/${randomUUID()}`), 404, 'RESOURCE_NOT_FOUND');
    });
  });

  // ================================================================ delete

  describe('DELETE /media/{id}', () => {
    it('requires authentication and CSRF', async () => {
      const u = await registerUser();
      const { assetId } = await initUpload(u);
      await request(app.getHttpServer()).delete(`/api/v1/media/${assetId}`).expect(401);
      await request(app.getHttpServer())
        .delete(`/api/v1/media/${assetId}`)
        .set('Cookie', `afrilink_at=${u.cookies['afrilink_at']}; afrilink_csrf=${u.cookies['afrilink_csrf']}`)
        .expect(403);
    });

    it('soft-deletes the owner\'s asset: gone from reads, row kept, second delete is 404', async () => {
      const u = await registerUser();
      const { assetId } = await initUpload(u);
      expect((await del(u, `/media/${assetId}`).expect(200)).body).toEqual({ data: { deleted: true } });

      const row = await prisma.asset.findUniqueOrThrow({ where: { id: assetId } });
      expect(row.deletedAt).not.toBeNull();
      expectError(await get(u, `/media/${assetId}`), 404, 'RESOURCE_NOT_FOUND');
      expectError(await del(u, `/media/${assetId}`), 404, 'RESOURCE_NOT_FOUND');
    });

    it("is 404 for another user's asset, and it survives", async () => {
      const owner = await registerUser();
      const stranger = await registerUser();
      const { assetId } = await initUpload(owner);
      expectError(await del(stranger, `/media/${assetId}`), 404, 'RESOURCE_NOT_FOUND');
      const row = await prisma.asset.findUniqueOrThrow({ where: { id: assetId } });
      expect(row.deletedAt).toBeNull();
    });

    it('is 404 for an unknown asset', async () => {
      const u = await registerUser();
      expectError(await del(u, `/media/${randomUUID()}`), 404, 'RESOURCE_NOT_FOUND');
    });
  });
});
