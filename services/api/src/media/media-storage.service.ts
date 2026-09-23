import { Injectable } from '@nestjs/common';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// Thin, vendor-neutral wrapper around the S3-compatible client (docs/05-api/media.md
// §2/§3): the only place `@aws-sdk/*` is imported. Every other Media file talks to
// this service, never to S3Client directly — swapping the eventual production
// provider is a config change here, not a code change anywhere else.
//
// Presigning is a local, offline HMAC computation — getSignedUrl() never contacts
// the endpoint (https://docs.aws.amazon.com/AmazonS3/latest/userguide/
// ShareObjectPreSignedURL.html and the SDK's own documented behavior), so
// createUploadUrl/createReadUrl work even if local MinIO isn't running. Only
// headObjectExists actually reaches the network, and it fails open (never throws)
// since it is an optional, non-authoritative check (media.md §5 decision 5).
@Injectable()
export class MediaStorageService {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor() {
    this.bucket = requireEnv('MEDIA_S3_BUCKET');
    this.client = new S3Client({
      endpoint: requireEnv('MEDIA_S3_ENDPOINT'),
      region: process.env.MEDIA_S3_REGION ?? 'us-east-1',
      forcePathStyle: (process.env.MEDIA_S3_FORCE_PATH_STYLE ?? 'true') !== 'false',
      credentials: {
        accessKeyId: requireEnv('MEDIA_S3_ACCESS_KEY_ID'),
        secretAccessKey: requireEnv('MEDIA_S3_SECRET_ACCESS_KEY'),
      },
    });
  }

  // Object key strategy (media.md §3): derived only from the asset id, never
  // from a client-supplied filename.
  originalKey(ownerUserId: string, assetId: string): string {
    return `media/${ownerUserId}/${assetId}/original`;
  }

  variantKey(ownerUserId: string, assetId: string, variantName: string): string {
    return `media/${ownerUserId}/${assetId}/variants/${variantName}`;
  }

  async createUploadUrl(key: string, contentType: string, expiresInSeconds: number): Promise<string> {
    const command = new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType });
    return getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
  }

  async createReadUrl(key: string, expiresInSeconds: number): Promise<string> {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
  }

  // Non-authoritative existence check (media.md §5 decision 5): "did
  // something land in storage," never compared against a checksum, never
  // gates any state transition. Fails open — storage being unreachable
  // (e.g. local MinIO not running) must never block completion.
  async headObjectExists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  // Not called by anything yet (no retention job exists, M-1) — present so
  // the eventual cleanup job has a single place to call, matching this
  // service's role as the only S3-aware file in the module.
  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set — see .env.example`);
  }
  return value;
}
