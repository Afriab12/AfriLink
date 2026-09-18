-- AfriLink Database Phase 2 migration — Communities module only
-- Scope: community (docs/04-database/database.md §8)
--
-- AUTO-GENERATED section below was produced by:
--   npx prisma migrate diff --from-migrations ./migrations --to-schema schema.prisma --script
-- against the Phase 1 migration history plus this increment's schema.prisma
-- changes, using a transient shadow database. Reproduced verbatim from that
-- command's output (statement order included).
--
-- HAND-ADDED section (clearly marked, at the bottom) contains the CHECK
-- constraint and partial unique indexes Prisma's schema DSL cannot express
-- — each one is called out in a comment in schema.prisma next to the model
-- it belongs to. Anyone regenerating the auto-generated section from Prisma
-- must re-apply this hand-added block afterward.
--
-- Preserves all existing Phase 1 tables/data — every statement below is
-- CREATE SCHEMA/TABLE/INDEX/TYPE or an ADD CONSTRAINT/FOREIGN KEY that
-- targets only the new `community` schema plus one additive foreign key
-- on the pre-existing, already-nullable `content.posts.community_id`
-- column (no column type change, no data touched).

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "community";

-- CreateEnum
CREATE TYPE "community"."CommunityVisibility" AS ENUM ('public', 'private');

-- CreateEnum
CREATE TYPE "community"."CommunityMembershipStatus" AS ENUM ('pending', 'active', 'rejected', 'left', 'removed', 'banned');

-- CreateTable
CREATE TABLE "community"."communities" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "visibility" "community"."CommunityVisibility" NOT NULL DEFAULT 'public',
    "membership_policy" TEXT NOT NULL DEFAULT 'open',
    "avatar_media_id" UUID,
    "cover_media_id" UUID,
    "rules" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "communities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "community"."memberships" (
    "id" UUID NOT NULL,
    "community_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "community"."CommunityMembershipStatus" NOT NULL DEFAULT 'pending',
    "role" TEXT NOT NULL DEFAULT 'member',
    "requested_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_at" TIMESTAMPTZ,
    "approved_by" UUID,
    "left_at" TIMESTAMPTZ,
    "removed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "community"."invitations" (
    "id" UUID NOT NULL,
    "community_id" UUID NOT NULL,
    "inviter_id" UUID NOT NULL,
    "invitee_id" UUID,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "accepted_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "communities_status_visibility_created_at_id_idx" ON "community"."communities"("status", "visibility", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "communities_owner_user_id_idx" ON "community"."communities"("owner_user_id");

-- CreateIndex
CREATE INDEX "memberships_community_id_status_created_at_user_id_idx" ON "community"."memberships"("community_id", "status", "created_at", "user_id");

-- CreateIndex
CREATE INDEX "memberships_user_id_status_created_at_community_id_idx" ON "community"."memberships"("user_id", "status", "created_at", "community_id");

-- CreateIndex
CREATE INDEX "invitations_community_id_created_at_idx" ON "community"."invitations"("community_id", "created_at");

-- CreateIndex
CREATE INDEX "invitations_invitee_id_accepted_at_revoked_at_idx" ON "community"."invitations"("invitee_id", "accepted_at", "revoked_at");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "community"."invitations"("token_hash");

-- AddForeignKey
ALTER TABLE "content"."posts" ADD CONSTRAINT "posts_community_id_fkey" FOREIGN KEY ("community_id") REFERENCES "community"."communities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community"."communities" ADD CONSTRAINT "communities_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community"."memberships" ADD CONSTRAINT "memberships_community_id_fkey" FOREIGN KEY ("community_id") REFERENCES "community"."communities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community"."memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community"."invitations" ADD CONSTRAINT "invitations_community_id_fkey" FOREIGN KEY ("community_id") REFERENCES "community"."communities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community"."invitations" ADD CONSTRAINT "invitations_inviter_id_fkey" FOREIGN KEY ("inviter_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community"."invitations" ADD CONSTRAINT "invitations_invitee_id_fkey" FOREIGN KEY ("invitee_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- HAND-ADDED
-- (not expressible in Prisma's schema DSL — each is called out in a
-- comment in schema.prisma; these do not come from, and cannot be
-- regenerated by, `prisma migrate diff`)
-- ============================================================

-- community.communities: one active slug (WHERE deleted_at IS NULL) —
-- a hard-deleted community's slug becomes reusable.
CREATE UNIQUE INDEX "communities_active_slug_key"
    ON "community"."communities"("slug")
    WHERE "deleted_at" IS NULL;

-- community.memberships: one ACTIVE membership per (community_id, user_id)
-- — per database.md §8 "unique active (community_id, user_id)". A user may
-- have multiple historical rows (left/removed, then rejoined) but at most
-- one row with status = 'active' at a time.
CREATE UNIQUE INDEX "memberships_active_pair_key"
    ON "community"."memberships"("community_id", "user_id")
    WHERE "status" = 'active';

-- community.invitations: no self-invite (invitee_id is nullable for
-- open/link-based invites, so the check only applies when it's set)
ALTER TABLE "community"."invitations"
    ADD CONSTRAINT "invitations_no_self_invite_check" CHECK ("invitee_id" IS NULL OR "inviter_id" <> "invitee_id");
