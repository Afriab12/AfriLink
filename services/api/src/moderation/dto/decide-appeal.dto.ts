import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

// moderation.md §5's documented contract is { decision, notes? } — no
// reasonCode field. This increment adds one, approved explicitly: the
// reversal `decision:'overturned'` triggers requires Action.reasonCode
// (NOT NULL), and defaulting it silently (e.g. always 'other') would
// discard real audit signal the same way Action Reversal's own
// unresolved reasonCode gap already does. reasonCode is optional at the
// DTO layer — only actually required for 'overturned', checked in the
// service (same split CreateActionDto/communityId already uses).
const DECISIONS = ['upheld', 'overturned'] as const;
const REASON_CODES = ['spam', 'harassment', 'hate', 'impersonation', 'scam_fraud', 'violence', 'sexual_content', 'misinformation', 'other'] as const;

export class DecideAppealDto {
  @IsIn(DECISIONS)
  decision!: (typeof DECISIONS)[number];

  @IsOptional()
  @IsIn(REASON_CODES)
  reasonCode?: (typeof REASON_CODES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
