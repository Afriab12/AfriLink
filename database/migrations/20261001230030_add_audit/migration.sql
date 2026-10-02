-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "audit";

-- CreateEnum
CREATE TYPE "audit"."AuditEventType" AS ENUM ('auth_login_succeeded', 'auth_account_verified', 'auth_password_reset_requested', 'auth_password_reset_completed', 'auth_session_revoked', 'auth_all_sessions_revoked', 'moderation_action_recorded', 'moderation_action_reversed', 'moderation_appeal_decided');

-- CreateTable
CREATE TABLE "audit"."events" (
    "id" UUID NOT NULL,
    "event_type" "audit"."AuditEventType" NOT NULL,
    "actor_id" UUID,
    "subject_type" TEXT,
    "subject_id" UUID,
    "request_id" TEXT,
    "trace_id" TEXT,
    "ip_hash" TEXT,
    "user_agent_hash" TEXT,
    "reason" TEXT,
    "metadata" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "events_event_type_occurred_at_idx" ON "audit"."events"("event_type", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "events_actor_id_occurred_at_idx" ON "audit"."events"("actor_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "events_subject_type_subject_id_occurred_at_idx" ON "audit"."events"("subject_type", "subject_id", "occurred_at" DESC);
