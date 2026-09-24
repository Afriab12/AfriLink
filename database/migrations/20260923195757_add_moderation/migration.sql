-- AfriLink Database Phase 2 migration — Moderation module only
-- Scope: moderation (docs/04-database/database.md §12, design in
-- docs/04-database/moderation.md)
--
-- AUTO-GENERATED section below was produced by:
--   npx prisma migrate diff --from-migrations ./migrations --to-schema schema.prisma --script
-- against the existing migration history (Phase 1, Communities, Messaging,
-- Notifications, Media) plus this increment's schema.prisma changes, using
-- a transient shadow database (afrilink_shadow — never afrilink_dev or
-- afrilink_test). Reproduced verbatim from that command's output (statement
-- order included).
--
-- HAND-ADDED section (clearly marked, at the bottom) contains the CHECK
-- constraints and partial unique indexes Prisma's schema DSL cannot express
-- — each one is called out in a comment in schema.prisma next to the model
-- it belongs to. Anyone regenerating the auto-generated section from Prisma
-- must re-apply this hand-added block afterward.
--
-- Preserves all existing tables/data — every statement below is additive
-- (new schema, new enums, new tables, new indexes, new foreign keys into
-- existing `identity.users`). Nothing in `identity`, `reference`, `social`,
-- `content`, `community`, `messaging`, `notification`, `media`, or
-- `integration` is altered, and no existing migration file is modified.
-- `content.shares` (Share.status), `messaging.conversations`
-- (Conversation.moderationState), and `community.communities.status`
-- remain untouched — the first two are separate Content/Messaging change
-- requests (moderation.md §17a/§17b), not part of this migration; the third
-- needs no schema change at all (moderation.md §17c).

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "moderation";

-- CreateEnum
CREATE TYPE "moderation"."ReportTargetType" AS ENUM ('profile', 'post', 'comment', 'share', 'message', 'conversation', 'community');

-- CreateEnum
CREATE TYPE "moderation"."ReportReasonCode" AS ENUM ('spam', 'harassment', 'hate', 'impersonation', 'scam_fraud', 'violence', 'sexual_content', 'misinformation', 'other');

-- CreateEnum
CREATE TYPE "moderation"."ReportStatus" AS ENUM ('open', 'under_review', 'closed');

-- CreateEnum
CREATE TYPE "moderation"."ModerationScope" AS ENUM ('platform', 'community', 'content', 'messaging');

-- CreateEnum
CREATE TYPE "moderation"."CaseStatus" AS ENUM ('open', 'in_review', 'closed');

-- CreateEnum
CREATE TYPE "moderation"."CasePriority" AS ENUM ('low', 'normal', 'high', 'critical');

-- CreateEnum
CREATE TYPE "moderation"."CaseSource" AS ENUM ('user_report', 'automated_signal', 'escalation');

-- CreateEnum
CREATE TYPE "moderation"."ModerationActionType" AS ENUM ('remove_content', 'restrict_content', 'warn_user', 'suspend_account', 'ban_account', 'restrict_community_participation');

-- CreateEnum
CREATE TYPE "moderation"."AppealState" AS ENUM ('submitted', 'under_review', 'upheld', 'overturned');

-- CreateEnum
CREATE TYPE "moderation"."SanctionSubjectType" AS ENUM ('user', 'community');

-- CreateEnum
CREATE TYPE "moderation"."SanctionType" AS ENUM ('account_suspended', 'account_banned', 'community_restricted');

-- CreateEnum
CREATE TYPE "moderation"."SanctionState" AS ENUM ('active', 'expired', 'revoked', 'superseded');

-- CreateTable
CREATE TABLE "moderation"."reports" (
    "id" UUID NOT NULL,
    "reporter_user_id" UUID NOT NULL,
    "target_type" "moderation"."ReportTargetType" NOT NULL,
    "target_id" UUID NOT NULL,
    "reason_code" "moderation"."ReportReasonCode" NOT NULL,
    "description" TEXT,
    "status" "moderation"."ReportStatus" NOT NULL DEFAULT 'open',
    "dedup_key" TEXT,
    "priority" "moderation"."CasePriority",
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "resolved_at" TIMESTAMPTZ,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "moderation"."cases" (
    "id" UUID NOT NULL,
    "queue" "moderation"."ModerationScope" NOT NULL,
    "assigned_moderator_id" UUID,
    "status" "moderation"."CaseStatus" NOT NULL DEFAULT 'open',
    "priority" "moderation"."CasePriority" NOT NULL DEFAULT 'normal',
    "sla_due_at" TIMESTAMPTZ,
    "source" "moderation"."CaseSource" NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "closed_at" TIMESTAMPTZ,

    CONSTRAINT "cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "moderation"."case_reports" (
    "case_id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "case_reports_pkey" PRIMARY KEY ("case_id","report_id")
);

-- CreateTable
CREATE TABLE "moderation"."actions" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "actor_id" UUID,
    "target_type" "moderation"."ReportTargetType" NOT NULL,
    "target_id" UUID NOT NULL,
    "action_type" "moderation"."ModerationActionType" NOT NULL,
    "scope" "moderation"."ModerationScope" NOT NULL,
    "reason_code" "moderation"."ReportReasonCode" NOT NULL,
    "duration_seconds" INTEGER,
    "starts_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ends_at" TIMESTAMPTZ,
    "reversal_of_action_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "moderation"."appeals" (
    "id" UUID NOT NULL,
    "action_id" UUID NOT NULL,
    "action_type" "moderation"."ModerationActionType" NOT NULL,
    "appellant_user_id" UUID NOT NULL,
    "statement" TEXT NOT NULL,
    "state" "moderation"."AppealState" NOT NULL DEFAULT 'submitted',
    "reviewer_id" UUID,
    "decision" TEXT,
    "appeal_deadline" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "decided_at" TIMESTAMPTZ,

    CONSTRAINT "appeals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "moderation"."sanctions" (
    "id" UUID NOT NULL,
    "subject_type" "moderation"."SanctionSubjectType" NOT NULL,
    "subject_id" UUID NOT NULL,
    "scope" "moderation"."ModerationScope" NOT NULL,
    "sanction_type" "moderation"."SanctionType" NOT NULL,
    "reason_code" "moderation"."ReportReasonCode" NOT NULL,
    "source_action_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ends_at" TIMESTAMPTZ,
    "state" "moderation"."SanctionState" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "sanctions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reports_status_priority_created_at_id_idx" ON "moderation"."reports"("status", "priority", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "reports_target_type_target_id_idx" ON "moderation"."reports"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "reports_reporter_user_id_created_at_idx" ON "moderation"."reports"("reporter_user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "cases_status_priority_created_at_id_idx" ON "moderation"."cases"("status", "priority", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "cases_queue_status_priority_created_at_idx" ON "moderation"."cases"("queue", "status", "priority", "created_at" DESC);

-- CreateIndex
CREATE INDEX "cases_assigned_moderator_id_status_idx" ON "moderation"."cases"("assigned_moderator_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "case_reports_report_id_key" ON "moderation"."case_reports"("report_id");

-- CreateIndex
CREATE INDEX "actions_case_id_idx" ON "moderation"."actions"("case_id");

-- CreateIndex
CREATE INDEX "actions_target_type_target_id_created_at_idx" ON "moderation"."actions"("target_type", "target_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "actions_actor_id_created_at_idx" ON "moderation"."actions"("actor_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "actions_id_action_type_key" ON "moderation"."actions"("id", "action_type");

-- CreateIndex
CREATE INDEX "appeals_state_appeal_deadline_idx" ON "moderation"."appeals"("state", "appeal_deadline");

-- CreateIndex
CREATE INDEX "appeals_appellant_user_id_created_at_idx" ON "moderation"."appeals"("appellant_user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "sanctions_subject_type_subject_id_created_at_idx" ON "moderation"."sanctions"("subject_type", "subject_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "sanctions_source_action_id_idx" ON "moderation"."sanctions"("source_action_id");

-- AddForeignKey
ALTER TABLE "moderation"."reports" ADD CONSTRAINT "reports_reporter_user_id_fkey" FOREIGN KEY ("reporter_user_id") REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderation"."cases" ADD CONSTRAINT "cases_assigned_moderator_id_fkey" FOREIGN KEY ("assigned_moderator_id") REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderation"."case_reports" ADD CONSTRAINT "case_reports_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "moderation"."cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderation"."case_reports" ADD CONSTRAINT "case_reports_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "moderation"."reports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderation"."actions" ADD CONSTRAINT "actions_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "moderation"."cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderation"."actions" ADD CONSTRAINT "actions_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderation"."actions" ADD CONSTRAINT "actions_reversal_of_action_id_fkey" FOREIGN KEY ("reversal_of_action_id") REFERENCES "moderation"."actions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderation"."appeals" ADD CONSTRAINT "appeals_action_id_action_type_fkey" FOREIGN KEY ("action_id", "action_type") REFERENCES "moderation"."actions"("id", "action_type") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderation"."appeals" ADD CONSTRAINT "appeals_appellant_user_id_fkey" FOREIGN KEY ("appellant_user_id") REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderation"."appeals" ADD CONSTRAINT "appeals_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderation"."sanctions" ADD CONSTRAINT "sanctions_source_action_id_fkey" FOREIGN KEY ("source_action_id") REFERENCES "moderation"."actions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================
-- HAND-ADDED
-- (not expressible in Prisma's schema DSL — each is called out in a
-- comment in schema.prisma; these do not come from, and cannot be
-- regenerated by, `prisma migrate diff`)
-- ============================================================

-- moderation.reports: a user cannot report their own profile.
ALTER TABLE "moderation"."reports"
    ADD CONSTRAINT "reports_no_self_report_check" CHECK (NOT ("target_type" = 'profile' AND "target_id" = "reporter_user_id"));

-- moderation.reports: same-reporter duplicate protection only (WHERE
-- status IN active states) — deliberately NOT cross-reporter; independent
-- reporters reporting the same target consolidate via case_reports
-- instead (moderation.md §15 item 4). NULL dedup_key values never
-- collide (standard Postgres unique-index NULL handling), so reports
-- without a computed key are unaffected.
CREATE UNIQUE INDEX "reports_active_dedup_key"
    ON "moderation"."reports"("dedup_key")
    WHERE "status" IN ('open', 'under_review');

-- moderation.cases: closed_at is set if and only if status = 'closed'.
ALTER TABLE "moderation"."cases"
    ADD CONSTRAINT "cases_closed_at_consistency_check" CHECK (("status" = 'closed') = ("closed_at" IS NOT NULL));

-- moderation.cases: a case being actively reviewed must have an assignee.
ALTER TABLE "moderation"."cases"
    ADD CONSTRAINT "cases_in_review_requires_assignee_check" CHECK ("status" <> 'in_review' OR "assigned_moderator_id" IS NOT NULL);

-- moderation.actions: an end must come after its start.
ALTER TABLE "moderation"."actions"
    ADD CONSTRAINT "actions_ends_at_after_starts_at_check" CHECK ("ends_at" IS NULL OR "ends_at" > "starts_at");

-- moderation.actions: an action cannot reverse itself.
ALTER TABLE "moderation"."actions"
    ADD CONSTRAINT "actions_no_self_reversal_check" CHECK ("reversal_of_action_id" IS NULL OR "reversal_of_action_id" <> "id");

-- moderation.appeals: appeal eligibility, DB-enforced (approved: every
-- action type except warn_user is appealable — moderation.md §15 item 3).
-- Guaranteed consistent with the actual action's action_type by the
-- composite foreign key above (appeals_action_id_action_type_fkey), not
-- by application code alone.
ALTER TABLE "moderation"."appeals"
    ADD CONSTRAINT "appeals_action_type_not_warn_user_check" CHECK ("action_type" <> 'warn_user');

-- moderation.appeals: decided_at is set if and only if the appeal reached
-- a terminal state.
ALTER TABLE "moderation"."appeals"
    ADD CONSTRAINT "appeals_decided_at_consistency_check" CHECK (("state" IN ('upheld', 'overturned')) = ("decided_at" IS NOT NULL));

-- moderation.appeals: a terminal decision requires a reviewer to have
-- made it.
ALTER TABLE "moderation"."appeals"
    ADD CONSTRAINT "appeals_terminal_requires_reviewer_check" CHECK ("state" NOT IN ('upheld', 'overturned') OR "reviewer_id" IS NOT NULL);

-- moderation.appeals: one active (submitted/under_review) appeal per
-- action at a time — database.md §12 "Enforce one active appeal per
-- applicable action unless policy allows multiple levels"; no multi-level
-- policy is approved, so single-level only.
CREATE UNIQUE INDEX "appeals_active_per_action_key"
    ON "moderation"."appeals"("action_id")
    WHERE "state" IN ('submitted', 'under_review');

-- moderation.sanctions: an end must come after its start.
ALTER TABLE "moderation"."sanctions"
    ADD CONSTRAINT "sanctions_ends_at_after_starts_at_check" CHECK ("ends_at" IS NULL OR "ends_at" > "starts_at");

-- moderation.sanctions: action→sanction mapping enforced at the database
-- level (approved: account_suspended/account_banned only ever apply to a
-- user subject; community_restricted only ever applies to a community
-- subject) — no sanction_type can pair with the wrong subject kind,
-- regardless of application code.
ALTER TABLE "moderation"."sanctions"
    ADD CONSTRAINT "sanctions_subject_type_mapping_check" CHECK (
        ("sanction_type" IN ('account_suspended', 'account_banned') AND "subject_type" = 'user')
        OR ("sanction_type" = 'community_restricted' AND "subject_type" = 'community')
    );

-- moderation.sanctions: at most one ACTIVE sanction per (subject, scope)
-- at a time — escalating a suspension to a ban transitions the old row to
-- `superseded` and inserts a new one, never two simultaneously-active rows
-- for the same subject+scope.
CREATE UNIQUE INDEX "sanctions_active_subject_scope_key"
    ON "moderation"."sanctions"("subject_type", "subject_id", "scope")
    WHERE "state" = 'active';

-- moderation.sanctions: structural index only, for a future expiry sweep
-- job — no such job exists yet (same tracked-but-unbuilt treatment as
-- media.md's M-1).
CREATE INDEX "sanctions_active_ends_at_idx"
    ON "moderation"."sanctions"("ends_at")
    WHERE "state" = 'active';
