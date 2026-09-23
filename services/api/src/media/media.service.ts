import { Injectable } from '@nestjs/common';
import type { Asset, Variant } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { MediaStorageService } from './media-storage.service';
import { MediaAccessService } from './media-access.service';
import { PolicyRejectedException, ResourceNotFoundException, ValidationFailedException } from '../common/errors/api-exception';
import {
  MAX_BYTES_BY_KIND,
  MAX_VIDEO_DURATION_SECONDS,
  MIME_TYPES_BY_KIND,
  PURPOSE_ALLOWED_KINDS,
  READ_URL_EXPIRY_SECONDS,
  UPLOAD_RESERVATION_EXPIRY_MS,
  UPLOAD_URL_EXPIRY_SECONDS,
} from './media.constants';
import type { CreateUploadDto } from './dto/create-upload.dto';

export interface UploadInitResponse {
  assetId: string;
  uploadId: string;
  uploadUrl: string;
  expiresAt: Date;
}

export interface UploadCompleteResponse {
  assetId: string;
  state: string;
}

export interface MediaVariantResponse {
  variantName: string;
  url: string;
  mimeType: string;
  widthPx: number | null;
  heightPx: number | null;
  durationSeconds: number | null;
  byteSize: number | null;
}

export interface MediaResponse {
  id: string;
  kind: string;
  purpose: string;
  state: string;
  scanState: string;
  moderationState: string;
  declaredMimeType: string;
  verifiedMimeType: string | null;
  byteSize: number | null;
  widthPx: number | null;
  heightPx: number | null;
  durationSeconds: number | null;
  createdAt: Date;
  updatedAt: Date;
  readyAt: Date | null;
  rejectedAt: Date | null;
  variants: MediaVariantResponse[];
}

@Injectable()
export class MediaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: MediaStorageService,
    private readonly access: MediaAccessService,
  ) {}

  // avatarMediaId/storageKey/storageProvider/checksum are never accepted or
  // serialized — private storage details never reach the client (media.md
  // §11). declaredByteSize/declaredDurationSeconds/declaredChecksum are
  // client claims only, never trusted (architecture.md §16, PRD §31).
  private toResponse(asset: Asset, variants: MediaVariantResponse[]): MediaResponse {
    return {
      id: asset.id,
      kind: asset.kind,
      purpose: asset.purpose,
      state: asset.state,
      scanState: asset.scanState,
      moderationState: asset.moderationState,
      declaredMimeType: asset.declaredMimeType,
      verifiedMimeType: asset.verifiedMimeType,
      byteSize: asset.byteSize === null ? null : Number(asset.byteSize),
      widthPx: asset.widthPx,
      heightPx: asset.heightPx,
      durationSeconds: asset.durationSeconds,
      createdAt: asset.createdAt,
      updatedAt: asset.updatedAt,
      readyAt: asset.readyAt,
      rejectedAt: asset.rejectedAt,
      variants,
    };
  }

  // Cross-field checks the DTO's decorators can't express alone — same
  // pattern as PostsService.assertVisibilityFits.
  private assertUploadPolicy(dto: CreateUploadDto): void {
    if (!PURPOSE_ALLOWED_KINDS[dto.purpose].includes(dto.kind)) {
      throw new PolicyRejectedException(`purpose '${dto.purpose}' does not accept kind '${dto.kind}'.`);
    }
    if (!MIME_TYPES_BY_KIND[dto.kind].includes(dto.declaredMimeType)) {
      throw new ValidationFailedException([
        { field: 'declaredMimeType', reason: `declaredMimeType must be one of: ${MIME_TYPES_BY_KIND[dto.kind].join(', ')}` },
      ]);
    }
    if (dto.declaredByteSize !== undefined && dto.declaredByteSize > MAX_BYTES_BY_KIND[dto.kind]) {
      throw new ValidationFailedException([
        { field: 'declaredByteSize', reason: `declaredByteSize must not exceed ${MAX_BYTES_BY_KIND[dto.kind]} bytes for kind '${dto.kind}'.` },
      ]);
    }
    if (dto.declaredDurationSeconds !== undefined) {
      if (dto.kind !== 'video') {
        throw new ValidationFailedException([{ field: 'declaredDurationSeconds', reason: 'declaredDurationSeconds is only meaningful for kind=video.' }]);
      }
      if (dto.declaredDurationSeconds > MAX_VIDEO_DURATION_SECONDS) {
        throw new ValidationFailedException([
          { field: 'declaredDurationSeconds', reason: `declaredDurationSeconds must not exceed ${MAX_VIDEO_DURATION_SECONDS} seconds.` },
        ]);
      }
    }
  }

  async initUpload(userId: string, dto: CreateUploadDto): Promise<UploadInitResponse> {
    this.assertUploadPolicy(dto);

    const expiresAt = new Date(Date.now() + UPLOAD_RESERVATION_EXPIRY_MS);

    const { asset, upload } = await this.prisma.$transaction(async (tx) => {
      const created = await tx.asset.create({
        data: {
          ownerUserId: userId,
          kind: dto.kind,
          purpose: dto.purpose,
          declaredMimeType: dto.declaredMimeType,
          storageProvider: 's3_compatible',
          storageKey: '', // set immediately below — the key strategy depends on the generated id
        },
      });
      const storageKey = this.storage.originalKey(userId, created.id);
      const asset = await tx.asset.update({ where: { id: created.id }, data: { storageKey } });
      const upload = await tx.upload.create({
        data: {
          ownerUserId: userId,
          assetId: asset.id,
          expectedByteSize: dto.declaredByteSize ?? null,
          expectedChecksum: dto.declaredChecksum ?? null,
          expiresAt,
        },
      });
      return { asset, upload };
    });

    const uploadUrl = await this.storage.createUploadUrl(asset.storageKey, dto.declaredMimeType, UPLOAD_URL_EXPIRY_SECONDS);

    return { assetId: asset.id, uploadId: upload.id, uploadUrl, expiresAt: upload.expiresAt };
  }

  async completeUpload(userId: string, uploadId: string): Promise<UploadCompleteResponse> {
    const upload = await this.prisma.upload.findFirst({ where: { id: uploadId, ownerUserId: userId } });
    if (!upload) {
      throw new ResourceNotFoundException();
    }

    // Idempotent: repeating a completed call is a 200 no-op, not an error —
    // matches the repeat-action-is-a-no-op convention used throughout
    // Communities (join/approve/leave).
    if (upload.status === 'completed') {
      const asset = await this.prisma.asset.findUniqueOrThrow({ where: { id: upload.assetId } });
      return { assetId: asset.id, state: asset.state };
    }

    if (upload.status === 'expired' || upload.status === 'failed') {
      throw new PolicyRejectedException('This upload can no longer be completed.');
    }

    // status === 'reserved' here. Lazy expiry: no cleanup job exists yet
    // (M-1, media.md §14) — checked on access instead of by a sweep.
    if (upload.expiresAt.getTime() < Date.now()) {
      await this.prisma.$transaction([
        this.prisma.upload.update({ where: { id: upload.id }, data: { status: 'expired' } }),
        this.prisma.asset.update({ where: { id: upload.assetId }, data: { state: 'rejected', rejectedAt: new Date() } }),
      ]);
      throw new PolicyRejectedException('This upload has expired.');
    }

    const asset = await this.prisma.asset.findUniqueOrThrow({ where: { id: upload.assetId } });
    // Non-authoritative existence check only (media.md §5 decision 5) — the
    // result is deliberately unused: it must never block completion (fails
    // open), and it is never compared against a checksum.
    await this.storage.headObjectExists(asset.storageKey);

    const [, updatedAsset] = await this.prisma.$transaction([
      this.prisma.upload.update({ where: { id: upload.id }, data: { status: 'completed', completedAt: new Date() } }),
      this.prisma.asset.update({ where: { id: upload.assetId }, data: { state: 'processing' } }),
    ]);

    // Processing itself (worker: validate/scan/generate variants) is not
    // built this phase (media.md §6) — enqueuing the async signal via the
    // existing integration.outbox_events mechanism is future work.

    return { assetId: updatedAsset.id, state: updatedAsset.state };
  }

  async getMedia(userId: string, assetId: string): Promise<MediaResponse> {
    const asset = await this.access.findOwnedAsset(userId, assetId);
    const variantRows = await this.prisma.variant.findMany({ where: { assetId, state: 'ready' } });
    const variants = await Promise.all(variantRows.map((v) => this.toVariantResponse(v)));
    return this.toResponse(asset, variants);
  }

  private async toVariantResponse(variant: Variant): Promise<MediaVariantResponse> {
    return {
      variantName: variant.variantName,
      url: await this.storage.createReadUrl(variant.storageKey, READ_URL_EXPIRY_SECONDS),
      mimeType: variant.mimeType,
      widthPx: variant.widthPx,
      heightPx: variant.heightPx,
      durationSeconds: variant.durationSeconds,
      byteSize: variant.byteSize === null ? null : Number(variant.byteSize),
    };
  }

  async deleteMedia(userId: string, assetId: string): Promise<void> {
    const asset = await this.access.findOwnedAsset(userId, assetId);
    await this.prisma.asset.update({ where: { id: asset.id }, data: { deletedAt: new Date() } });
  }
}

