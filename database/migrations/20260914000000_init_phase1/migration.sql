-- AfriLink Phase 1 migration
-- Scope: identity, reference, social, content, integration
-- (docs/04-database/database.md §25 step 2)
--
-- AUTO-GENERATED section below was produced by:
--   npx prisma migrate diff --from-empty --to-schema schema.prisma --script
-- against database/schema.prisma, with no database connection. It is
-- reproduced verbatim from that command's output (statement order included).
--
-- HAND-ADDED section (clearly marked, at the bottom) contains the CHECK
-- constraints and partial/functional unique indexes Prisma's schema DSL
-- cannot express — each one is called out in a comment in schema.prisma
-- next to the model it belongs to. Anyone regenerating the auto-generated
-- section from Prisma must re-apply this hand-added block afterward.
--
-- NOT APPLIED to any database. Written for review only — no
-- `prisma migrate dev`/`deploy`/`db push`/`db execute` has been run.

-- ============================================================
-- AUTO-GENERATED
-- ============================================================

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "content";
CREATE SCHEMA IF NOT EXISTS "identity";
CREATE SCHEMA IF NOT EXISTS "integration";
CREATE SCHEMA IF NOT EXISTS "reference";
CREATE SCHEMA IF NOT EXISTS "social";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "citext";

-- CreateEnum
CREATE TYPE "identity"."UserStatus" AS ENUM ('active', 'restricted', 'suspended', 'banned', 'pending_deletion', 'deleted');
CREATE TYPE "identity"."AccountType" AS ENUM ('individual', 'creator', 'business', 'organization');
CREATE TYPE "social"."ProfileVisibility" AS ENUM ('public', 'followers', 'private');
CREATE TYPE "social"."FollowStatus" AS ENUM ('active');
CREATE TYPE "social"."FriendshipStatus" AS ENUM ('pending', 'accepted', 'declined', 'removed');
CREATE TYPE "content"."ContentStatus" AS ENUM ('published', 'hidden', 'removed');
CREATE TYPE "content"."ReactionType" AS ENUM ('like', 'love', 'laugh', 'support', 'insightful');

-- CreateTable
CREATE TABLE "identity"."users" (
    "id" UUID NOT NULL,
    "handle" CITEXT,
    "status" "identity"."UserStatus" NOT NULL DEFAULT 'active',
    "account_type" "identity"."AccountType" NOT NULL DEFAULT 'individual',
    "locale" TEXT NOT NULL DEFAULT 'en',
    "timezone" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."credentials" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "identifier_normalized" TEXT NOT NULL,
    "secret_hash" TEXT NOT NULL,
    "verified_at" TIMESTAMPTZ,
    "last_used_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ,

    CONSTRAINT "credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "device_id" TEXT,
    "device_label" TEXT,
    "ip_hash" TEXT,
    "user_agent_hash" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "revoked_at" TIMESTAMPTZ,
    "revoke_reason" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."verification_challenges" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "destination_hash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "challenge_hash" TEXT NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "consumed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."roles" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."permissions" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."role_permissions" (
    "role_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateTable
CREATE TABLE "identity"."user_roles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "scope_type" TEXT,
    "scope_id" UUID,
    "granted_by" UUID,
    "granted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reference"."countries" (
    "code" CHAR(2) NOT NULL,
    "name" TEXT NOT NULL,
    "name_local" TEXT,
    "region" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "countries_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "reference"."interests" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "category" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "interests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social"."profiles" (
    "user_id" UUID NOT NULL,
    "display_name" TEXT,
    "bio" TEXT,
    "avatar_media_id" UUID,
    "country_code" CHAR(2),
    "region" TEXT,
    "website_url" TEXT,
    "visibility" "social"."ProfileVisibility" NOT NULL DEFAULT 'public',
    "primary_language" TEXT NOT NULL DEFAULT 'en',
    "profile_metadata" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "social"."user_interests" (
    "user_id" UUID NOT NULL,
    "interest_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_interests_pkey" PRIMARY KEY ("user_id","interest_id")
);

-- CreateTable
CREATE TABLE "social"."follows" (
    "id" UUID NOT NULL,
    "follower_id" UUID NOT NULL,
    "followee_id" UUID NOT NULL,
    "status" "social"."FollowStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "follows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social"."friendships" (
    "id" UUID NOT NULL,
    "requester_id" UUID NOT NULL,
    "addressee_id" UUID NOT NULL,
    "status" "social"."FriendshipStatus" NOT NULL DEFAULT 'pending',
    "requested_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "responded_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "friendships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social"."blocks" (
    "id" UUID NOT NULL,
    "blocker_id" UUID NOT NULL,
    "blocked_id" UUID NOT NULL,
    "reason_code" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social"."user_preferences" (
    "user_id" UUID NOT NULL,
    "profile_visibility" "social"."ProfileVisibility" NOT NULL DEFAULT 'public',
    "friend_list_visible" BOOLEAN NOT NULL DEFAULT false,
    "discoverable" BOOLEAN NOT NULL DEFAULT true,
    "quiet_hours_start" TEXT,
    "quiet_hours_end" TEXT,
    "notification_defaults" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "content"."posts" (
    "id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "community_id" UUID,
    "body" TEXT NOT NULL,
    "status" "content"."ContentStatus" NOT NULL DEFAULT 'published',
    "visibility" TEXT NOT NULL DEFAULT 'public',
    "language_code" TEXT NOT NULL DEFAULT 'en',
    "published_at" TIMESTAMPTZ,
    "edited_at" TIMESTAMPTZ,
    "deleted_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content"."comments" (
    "id" UUID NOT NULL,
    "post_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "parent_comment_id" UUID,
    "body" TEXT NOT NULL,
    "status" "content"."ContentStatus" NOT NULL DEFAULT 'published',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content"."post_reactions" (
    "user_id" UUID NOT NULL,
    "post_id" UUID NOT NULL,
    "reaction_type" "content"."ReactionType" NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "post_reactions_pkey" PRIMARY KEY ("user_id","post_id")
);

-- CreateTable
CREATE TABLE "content"."comment_reactions" (
    "user_id" UUID NOT NULL,
    "comment_id" UUID NOT NULL,
    "reaction_type" "content"."ReactionType" NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "comment_reactions_pkey" PRIMARY KEY ("user_id","comment_id")
);

-- CreateTable
CREATE TABLE "content"."shares" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "post_id" UUID NOT NULL,
    "comment" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "shares_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration"."outbox_events" (
    "id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "event_version" INTEGER NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "available_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "locked_until" TIMESTAMPTZ,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration"."idempotency_keys" (
    "owner_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "command_type" TEXT NOT NULL,
    "request_fingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "response_payload" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("owner_id","key","command_type")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_handle_key" ON "identity"."users"("handle");
CREATE INDEX "users_status_created_at_idx" ON "identity"."users"("status", "created_at");
CREATE INDEX "users_deleted_at_idx" ON "identity"."users"("deleted_at");
CREATE INDEX "credentials_user_id_idx" ON "identity"."credentials"("user_id");
CREATE UNIQUE INDEX "sessions_refresh_token_hash_key" ON "identity"."sessions"("refresh_token_hash");
CREATE INDEX "sessions_user_id_revoked_at_expires_at_idx" ON "identity"."sessions"("user_id", "revoked_at", "expires_at");
CREATE INDEX "verification_challenges_destination_hash_purpose_expires_at_idx" ON "identity"."verification_challenges"("destination_hash", "purpose", "expires_at");
CREATE UNIQUE INDEX "roles_key_key" ON "identity"."roles"("key");
CREATE UNIQUE INDEX "permissions_key_key" ON "identity"."permissions"("key");
CREATE INDEX "user_roles_user_id_idx" ON "identity"."user_roles"("user_id");
CREATE UNIQUE INDEX "interests_slug_key" ON "reference"."interests"("slug");
CREATE INDEX "profiles_country_code_idx" ON "social"."profiles"("country_code");
CREATE INDEX "user_interests_interest_id_user_id_idx" ON "social"."user_interests"("interest_id", "user_id");
CREATE INDEX "follows_followee_id_created_at_follower_id_idx" ON "social"."follows"("followee_id", "created_at", "follower_id");
CREATE INDEX "follows_follower_id_created_at_followee_id_idx" ON "social"."follows"("follower_id", "created_at", "followee_id");
CREATE INDEX "friendships_requester_id_status_created_at_idx" ON "social"."friendships"("requester_id", "status", "created_at");
CREATE INDEX "friendships_addressee_id_status_created_at_idx" ON "social"."friendships"("addressee_id", "status", "created_at");
CREATE INDEX "blocks_blocker_id_deleted_at_idx" ON "social"."blocks"("blocker_id", "deleted_at");
CREATE INDEX "blocks_blocked_id_deleted_at_idx" ON "social"."blocks"("blocked_id", "deleted_at");
CREATE INDEX "posts_author_id_created_at_id_idx" ON "content"."posts"("author_id", "created_at" DESC, "id" DESC);
CREATE INDEX "posts_community_id_created_at_id_idx" ON "content"."posts"("community_id", "created_at" DESC, "id" DESC);
CREATE INDEX "posts_status_published_at_id_idx" ON "content"."posts"("status", "published_at" DESC, "id" DESC);
CREATE INDEX "comments_post_id_created_at_id_idx" ON "content"."comments"("post_id", "created_at", "id");
CREATE INDEX "comments_parent_comment_id_created_at_id_idx" ON "content"."comments"("parent_comment_id", "created_at", "id");
CREATE INDEX "shares_user_id_created_at_id_idx" ON "content"."shares"("user_id", "created_at" DESC, "id" DESC);
CREATE INDEX "shares_post_id_created_at_id_idx" ON "content"."shares"("post_id", "created_at" DESC, "id" DESC);
CREATE INDEX "outbox_events_published_at_available_at_occurred_at_idx" ON "integration"."outbox_events"("published_at", "available_at", "occurred_at");

-- AddForeignKey
ALTER TABLE "identity"."credentials" ADD CONSTRAINT "credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "identity"."sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "identity"."verification_challenges" ADD CONSTRAINT "verification_challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "identity"."role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "identity"."roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "identity"."role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "identity"."permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "identity"."user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "identity"."user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "identity"."roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "social"."profiles" ADD CONSTRAINT "profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "social"."profiles" ADD CONSTRAINT "profiles_country_code_fkey" FOREIGN KEY ("country_code") REFERENCES "reference"."countries"("code") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "social"."user_interests" ADD CONSTRAINT "user_interests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "social"."user_interests" ADD CONSTRAINT "user_interests_interest_id_fkey" FOREIGN KEY ("interest_id") REFERENCES "reference"."interests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "social"."follows" ADD CONSTRAINT "follows_follower_id_fkey" FOREIGN KEY ("follower_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "social"."follows" ADD CONSTRAINT "follows_followee_id_fkey" FOREIGN KEY ("followee_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "social"."friendships" ADD CONSTRAINT "friendships_requester_id_fkey" FOREIGN KEY ("requester_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "social"."friendships" ADD CONSTRAINT "friendships_addressee_id_fkey" FOREIGN KEY ("addressee_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "social"."blocks" ADD CONSTRAINT "blocks_blocker_id_fkey" FOREIGN KEY ("blocker_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "social"."blocks" ADD CONSTRAINT "blocks_blocked_id_fkey" FOREIGN KEY ("blocked_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "social"."user_preferences" ADD CONSTRAINT "user_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "content"."posts" ADD CONSTRAINT "posts_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "content"."comments" ADD CONSTRAINT "comments_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "content"."posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "content"."comments" ADD CONSTRAINT "comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "content"."comments" ADD CONSTRAINT "comments_parent_comment_id_fkey" FOREIGN KEY ("parent_comment_id") REFERENCES "content"."comments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "content"."post_reactions" ADD CONSTRAINT "post_reactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "content"."post_reactions" ADD CONSTRAINT "post_reactions_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "content"."posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "content"."comment_reactions" ADD CONSTRAINT "comment_reactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "content"."comment_reactions" ADD CONSTRAINT "comment_reactions_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "content"."comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "content"."shares" ADD CONSTRAINT "shares_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "content"."shares" ADD CONSTRAINT "shares_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "content"."posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- HAND-ADDED
-- (not expressible in Prisma's schema DSL — approved item 3; these do not
-- come from, and cannot be regenerated by, `prisma migrate diff`)
-- ============================================================

-- content.posts: constrain visibility to the documented value set
ALTER TABLE "content"."posts"
    ADD CONSTRAINT "posts_visibility_check" CHECK ("visibility" IN ('public', 'followers', 'community_members', 'mentioned_users', 'private'));

-- identity.credentials: one active credential per (kind, identifier_normalized)
CREATE UNIQUE INDEX "credentials_active_kind_identifier_key"
    ON "identity"."credentials"("kind", "identifier_normalized")
    WHERE "revoked_at" IS NULL;

-- identity.user_roles: one active assignment per (user_id, role_id, scope_type, scope_id)
CREATE UNIQUE INDEX "user_roles_active_assignment_key"
    ON "identity"."user_roles"("user_id", "role_id", "scope_type", "scope_id")
    WHERE "revoked_at" IS NULL;

-- social.follows: no self-follow; one active pair
ALTER TABLE "social"."follows"
    ADD CONSTRAINT "follows_no_self_follow_check" CHECK ("follower_id" <> "followee_id");
CREATE UNIQUE INDEX "follows_active_pair_key"
    ON "social"."follows"("follower_id", "followee_id")
    WHERE "deleted_at" IS NULL;

-- social.friendships: no self-request; one active relationship per unordered
-- pair regardless of who initiated (least/greatest avoids (A,B) and (B,A)
-- both existing — a plain column-order unique constraint would allow that)
ALTER TABLE "social"."friendships"
    ADD CONSTRAINT "friendships_no_self_request_check" CHECK ("requester_id" <> "addressee_id");
CREATE UNIQUE INDEX "friendships_active_unordered_pair_key"
    ON "social"."friendships"(LEAST("requester_id", "addressee_id"), GREATEST("requester_id", "addressee_id"))
    WHERE "status" IN ('pending', 'accepted');

-- social.blocks: no self-block; one active pair
ALTER TABLE "social"."blocks"
    ADD CONSTRAINT "blocks_no_self_block_check" CHECK ("blocker_id" <> "blocked_id");
CREATE UNIQUE INDEX "blocks_active_pair_key"
    ON "social"."blocks"("blocker_id", "blocked_id")
    WHERE "deleted_at" IS NULL;
