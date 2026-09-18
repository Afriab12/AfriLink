-- AfriLink Database Phase 2 migration — Messaging module only
-- Scope: messaging (docs/04-database/database.md §9)
-- Database implementation only — no WebSocket gateway, REST endpoints,
-- services, or DTOs are part of this change.
--
-- AUTO-GENERATED section below was produced by:
--   npx prisma migrate diff --from-migrations ./migrations --to-schema schema.prisma --script
-- against the Phase 1 + Communities migration history plus this
-- increment's schema.prisma changes, using a transient shadow database.
-- Reproduced verbatim from that command's output (statement order
-- included).
--
-- HAND-ADDED section (clearly marked, at the bottom) contains the CHECK
-- constraints, the partial unique index, and the two foreign keys on
-- `conversations.direct_participant_a_id`/`_b_id` that Prisma's schema
-- DSL cannot express (those two columns are deliberately not modeled as
-- Prisma relations — see schema.prisma's Conversation model comment).
-- Each is called out in a comment in schema.prisma next to the model it
-- belongs to. Anyone regenerating the auto-generated section from Prisma
-- must re-apply this hand-added block afterward.
--
-- Preserves all existing Phase 1 and Communities tables/data — every
-- statement below is CREATE SCHEMA/TABLE/INDEX/TYPE or an ADD
-- CONSTRAINT/FOREIGN KEY scoped entirely to the new `messaging` schema.
-- Nothing outside `messaging` is touched (unlike the Communities
-- increment, this one adds no foreign key on any pre-existing table).

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "messaging";

-- CreateEnum
CREATE TYPE "messaging"."MessageModerationState" AS ENUM ('active', 'hidden', 'removed');

-- CreateTable
CREATE TABLE "messaging"."conversations" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'direct',
    "created_by" UUID,
    "title" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "direct_participant_a_id" UUID,
    "direct_participant_b_id" UUID,
    "last_message_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messaging"."participants" (
    "conversation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "joined_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMPTZ,
    "muted_until" TIMESTAMPTZ,
    "last_read_message_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'active',

    CONSTRAINT "participants_pkey" PRIMARY KEY ("conversation_id","user_id")
);

-- CreateTable
CREATE TABLE "messaging"."messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "sender_id" UUID NOT NULL,
    "client_message_id" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'sent',
    "moderation_state" "messaging"."MessageModerationState" NOT NULL DEFAULT 'active',
    "reply_to_message_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "edited_at" TIMESTAMPTZ,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conversations_last_message_at_id_idx" ON "messaging"."conversations"("last_message_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "participants_user_id_status_last_read_message_id_idx" ON "messaging"."participants"("user_id", "status", "last_read_message_id");

-- CreateIndex
CREATE INDEX "messages_conversation_id_created_at_id_idx" ON "messaging"."messages"("conversation_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "messages_sender_id_created_at_idx" ON "messaging"."messages"("sender_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "messages_sender_id_client_message_id_key" ON "messaging"."messages"("sender_id", "client_message_id");

-- AddForeignKey
ALTER TABLE "messaging"."conversations" ADD CONSTRAINT "conversations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "identity"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messaging"."participants" ADD CONSTRAINT "participants_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "messaging"."conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messaging"."participants" ADD CONSTRAINT "participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messaging"."messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "messaging"."conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messaging"."messages" ADD CONSTRAINT "messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messaging"."messages" ADD CONSTRAINT "messages_reply_to_message_id_fkey" FOREIGN KEY ("reply_to_message_id") REFERENCES "messaging"."messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================
-- HAND-ADDED
-- (not expressible in Prisma's schema DSL — each is called out in a
-- comment in schema.prisma; these do not come from, and cannot be
-- regenerated by, `prisma migrate diff`)
-- ============================================================

-- messaging.conversations: MVP scope is one-to-one only (ADR-002 §7).
-- Widening this to allow 'group' later is a pure additive migration.
ALTER TABLE "messaging"."conversations"
    ADD CONSTRAINT "conversations_kind_check" CHECK ("kind" = 'direct');

-- messaging.conversations: foreign keys for the denormalized pair
-- columns (not modeled as Prisma relations — see schema.prisma). Restrict,
-- matching messages.sender_id's reasoning: a direct conversation's pairing
-- identity must not silently break via an unrelated user hard-delete.
ALTER TABLE "messaging"."conversations"
    ADD CONSTRAINT "conversations_direct_participant_a_id_fkey" FOREIGN KEY ("direct_participant_a_id") REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "messaging"."conversations"
    ADD CONSTRAINT "conversations_direct_participant_b_id_fkey" FOREIGN KEY ("direct_participant_b_id") REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- messaging.conversations: for a 'direct' conversation, both pair columns
-- must be set and refer to two different users (no self-conversation) —
-- matching the self-action CHECK pattern already used for
-- follows/friendships/blocks/community.invitations.
ALTER TABLE "messaging"."conversations"
    ADD CONSTRAINT "conversations_direct_pair_required_check"
    CHECK ("kind" <> 'direct' OR ("direct_participant_a_id" IS NOT NULL AND "direct_participant_b_id" IS NOT NULL AND "direct_participant_a_id" <> "direct_participant_b_id"));

-- messaging.conversations: at most one ACTIVE 'direct' conversation per
-- unordered pair — LEAST/GREATEST normalizes the pair regardless of
-- which column holds which user, exactly mirroring
-- social.friendships_active_unordered_pair_key. This is the database-
-- level guarantee this migration's review explicitly required, rather
-- than relying on application-level dedup logic.
CREATE UNIQUE INDEX "conversations_direct_pair_key"
    ON "messaging"."conversations"(LEAST("direct_participant_a_id", "direct_participant_b_id"), GREATEST("direct_participant_a_id", "direct_participant_b_id"))
    WHERE "kind" = 'direct' AND "deleted_at" IS NULL;
