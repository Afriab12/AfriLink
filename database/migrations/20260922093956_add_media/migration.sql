-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "media";

-- CreateEnum
CREATE TYPE "media"."AssetKind" AS ENUM ('image', 'video');

-- CreateEnum
CREATE TYPE "media"."AssetState" AS ENUM ('pending', 'processing', 'ready', 'rejected');

-- CreateEnum
CREATE TYPE "media"."AssetScanState" AS ENUM ('pending', 'passed', 'failed', 'skipped');

-- CreateEnum
CREATE TYPE "media"."AssetModerationState" AS ENUM ('active', 'hidden', 'removed');

-- CreateEnum
CREATE TYPE "media"."VariantState" AS ENUM ('pending', 'ready', 'failed');

-- CreateEnum
CREATE TYPE "media"."UploadStatus" AS ENUM ('reserved', 'completed', 'expired', 'failed');

-- CreateTable
CREATE TABLE "content"."post_media" (
    "post_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "alt_text" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_media_pkey" PRIMARY KEY ("post_id","asset_id")
);

-- CreateTable
CREATE TABLE "messaging"."message_attachments" (
    "message_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_attachments_pkey" PRIMARY KEY ("message_id","asset_id")
);

-- CreateTable
CREATE TABLE "media"."assets" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "kind" "media"."AssetKind" NOT NULL,
    "purpose" TEXT NOT NULL,
    "state" "media"."AssetState" NOT NULL DEFAULT 'pending',
    "scan_state" "media"."AssetScanState" NOT NULL DEFAULT 'pending',
    "moderation_state" "media"."AssetModerationState" NOT NULL DEFAULT 'active',
    "declared_mime_type" TEXT NOT NULL,
    "verified_mime_type" TEXT,
    "byte_size" BIGINT,
    "checksum" TEXT,
    "width_px" INTEGER,
    "height_px" INTEGER,
    "duration_seconds" INTEGER,
    "storage_provider" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "ready_at" TIMESTAMPTZ,
    "rejected_at" TIMESTAMPTZ,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media"."variants" (
    "id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "variant_name" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "width_px" INTEGER,
    "height_px" INTEGER,
    "duration_seconds" INTEGER,
    "byte_size" BIGINT,
    "checksum" TEXT,
    "state" "media"."VariantState" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media"."uploads" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "provider_upload_id" TEXT,
    "expected_byte_size" BIGINT,
    "expected_checksum" TEXT,
    "status" "media"."UploadStatus" NOT NULL DEFAULT 'reserved',
    "expires_at" TIMESTAMPTZ NOT NULL,
    "completed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uploads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "post_media_post_id_display_order_idx" ON "content"."post_media"("post_id", "display_order");

-- CreateIndex
CREATE INDEX "post_media_asset_id_idx" ON "content"."post_media"("asset_id");

-- CreateIndex
CREATE INDEX "message_attachments_message_id_display_order_idx" ON "messaging"."message_attachments"("message_id", "display_order");

-- CreateIndex
CREATE INDEX "message_attachments_asset_id_idx" ON "messaging"."message_attachments"("asset_id");

-- CreateIndex
CREATE INDEX "assets_owner_user_id_purpose_state_created_at_id_idx" ON "media"."assets"("owner_user_id", "purpose", "state", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "assets_deleted_at_idx" ON "media"."assets"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "variants_asset_id_variant_name_key" ON "media"."variants"("asset_id", "variant_name");

-- CreateIndex
CREATE UNIQUE INDEX "uploads_asset_id_key" ON "media"."uploads"("asset_id");

-- CreateIndex
CREATE INDEX "uploads_status_expires_at_idx" ON "media"."uploads"("status", "expires_at");

-- AddForeignKey
ALTER TABLE "social"."profiles" ADD CONSTRAINT "profiles_avatar_media_id_fkey" FOREIGN KEY ("avatar_media_id") REFERENCES "media"."assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content"."post_media" ADD CONSTRAINT "post_media_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "content"."posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content"."post_media" ADD CONSTRAINT "post_media_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "media"."assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community"."communities" ADD CONSTRAINT "communities_avatar_media_id_fkey" FOREIGN KEY ("avatar_media_id") REFERENCES "media"."assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community"."communities" ADD CONSTRAINT "communities_cover_media_id_fkey" FOREIGN KEY ("cover_media_id") REFERENCES "media"."assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messaging"."message_attachments" ADD CONSTRAINT "message_attachments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messaging"."messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messaging"."message_attachments" ADD CONSTRAINT "message_attachments_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "media"."assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media"."assets" ADD CONSTRAINT "assets_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media"."variants" ADD CONSTRAINT "variants_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "media"."assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media"."uploads" ADD CONSTRAINT "uploads_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media"."uploads" ADD CONSTRAINT "uploads_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "media"."assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
