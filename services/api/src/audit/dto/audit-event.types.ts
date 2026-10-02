import { IsIn, IsInt, IsOptional, IsUUID, Min } from 'class-validator';
import type { AuditEventType } from '@prisma/client';

// One allowlisted metadata shape per event type (docs/04-database/audit.md
// §5 / the Audit service design review's decision #6) — this IS the
// redaction mechanism: `AuditService.record()` validates with
// `whitelist: true, forbidNonWhitelisted: true`, so a field that isn't
// declared on the matching class below (a password, a token, a raw
// verification code, anything not explicitly listed here) is rejected
// before insert, not merely discouraged by convention.
//
// reasonCode/rationale are deliberately NOT repeated in any metadata shape
// below — they live in the envelope's own `reason` field instead (see
// AuditService), so nothing here duplicates it.

const ACTION_TYPES = ['remove_content', 'restrict_content', 'warn_user', 'suspend_account', 'ban_account', 'restrict_community_participation'] as const;
const TARGET_TYPES = ['profile', 'post', 'comment', 'share', 'message', 'conversation', 'community'] as const;

export class AuthLoginSucceededMetadata {
  @IsUUID()
  sessionId!: string;
}

export class AuthAccountVerifiedMetadata {
  @IsIn(['email', 'phone'])
  channel!: 'email' | 'phone';
}

export class AuthPasswordResetRequestedMetadata {
  @IsUUID()
  challengeId!: string;
}

export class AuthPasswordResetCompletedMetadata {
  @IsUUID()
  challengeId!: string;
}

export class AuthSessionRevokedMetadata {
  @IsOptional()
  @IsUUID()
  sessionId?: string;
}

// Deliberately empty — this is the one event type whose contract requires
// no metadata fields at all ({} is valid here, and only here).
export class AuthAllSessionsRevokedMetadata {}

export class ModerationActionRecordedMetadata {
  @IsIn(ACTION_TYPES)
  actionType!: (typeof ACTION_TYPES)[number];

  @IsIn(TARGET_TYPES)
  targetType!: (typeof TARGET_TYPES)[number];

  @IsUUID()
  targetId!: string;

  @IsOptional()
  @IsUUID()
  sanctionId?: string;

  @IsOptional()
  @IsUUID()
  communityId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  durationSeconds?: number;
}

export class ModerationActionReversedMetadata {
  @IsIn(ACTION_TYPES)
  actionType!: (typeof ACTION_TYPES)[number];

  @IsUUID()
  originalActionId!: string;
}

export class ModerationAppealDecidedMetadata {
  @IsUUID()
  appealId!: string;

  @IsUUID()
  actionId!: string;

  @IsIn(['upheld', 'overturned'])
  decision!: 'upheld' | 'overturned';

  @IsOptional()
  @IsUUID()
  reversalActionId?: string;
}

// Maps each AuditEventType to its metadata validator class — the single
// place that connects "which event" to "which shape." AuditService reads
// this, never hardcodes a switch over all nine.
export const AUDIT_METADATA_CLASSES = {
  auth_login_succeeded: AuthLoginSucceededMetadata,
  auth_account_verified: AuthAccountVerifiedMetadata,
  auth_password_reset_requested: AuthPasswordResetRequestedMetadata,
  auth_password_reset_completed: AuthPasswordResetCompletedMetadata,
  auth_session_revoked: AuthSessionRevokedMetadata,
  auth_all_sessions_revoked: AuthAllSessionsRevokedMetadata,
  moderation_action_recorded: ModerationActionRecordedMetadata,
  moderation_action_reversed: ModerationActionReversedMetadata,
  moderation_appeal_decided: ModerationAppealDecidedMetadata,
} as const satisfies Record<AuditEventType, new () => object>;

// Mandatory (transactional) vs. best-effort (non-blocking) — approved
// classification, restated here as the one place AuditService consults it,
// not re-decided per call site.
export const MANDATORY_AUDIT_EVENT_TYPES = new Set<AuditEventType>([
  'auth_account_verified',
  'auth_password_reset_completed',
  'moderation_action_recorded',
  'moderation_action_reversed',
  'moderation_appeal_decided',
]);

interface AuditEventEnvelope<T extends AuditEventType, M> {
  eventType: T;
  // Null = no authenticated actor at the point of emission (system event,
  // or a recovery-credential-proved-but-not-session-authenticated event —
  // never fabricated to satisfy a NOT NULL that doesn't exist: the column
  // is nullable specifically for this reason).
  actorId: string | null;
  subjectType: string;
  subjectId: string;
  metadata: M;
  // Free text — moderation reasonCode or appeal rationale, or an existing
  // Session.revokeReason value, copied verbatim; never reconstructed.
  reason?: string;
  requestId?: string;
  // Reserved, unpopulated until OpenTelemetry exists — accepted here so a
  // future caller has somewhere to put it without a contract change.
  traceId?: string;
  // Already-hashed by the caller — Audit A performs no hashing itself
  // (approved decision #9/#11): the HMAC-SHA256/AUDIT_HASH_SECRET
  // mechanism is a producer-side (Audit C) concern, entirely out of scope
  // until that secret exists.
  ipHash?: string;
  userAgentHash?: string;
  // Caller-supplied — when the underlying event actually happened, not
  // defaulted, so a future backfill/replay never has to lie about it.
  occurredAt: Date;
}

export type AuditEventInput =
  | AuditEventEnvelope<'auth_login_succeeded', AuthLoginSucceededMetadata>
  | AuditEventEnvelope<'auth_account_verified', AuthAccountVerifiedMetadata>
  | AuditEventEnvelope<'auth_password_reset_requested', AuthPasswordResetRequestedMetadata>
  | AuditEventEnvelope<'auth_password_reset_completed', AuthPasswordResetCompletedMetadata>
  | AuditEventEnvelope<'auth_session_revoked', AuthSessionRevokedMetadata>
  | AuditEventEnvelope<'auth_all_sessions_revoked', AuthAllSessionsRevokedMetadata>
  | AuditEventEnvelope<'moderation_action_recorded', ModerationActionRecordedMetadata>
  | AuditEventEnvelope<'moderation_action_reversed', ModerationActionReversedMetadata>
  | AuditEventEnvelope<'moderation_appeal_decided', ModerationAppealDecidedMetadata>;
