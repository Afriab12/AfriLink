import { IsIn } from 'class-validator';

// Same taxonomy as CreateActionDto/CreateReportDto — no separate reversal
// vocabulary exists (approved decision: keep reasonCode as-is despite the
// semantic mismatch; 'other' absorbs most reversal reasons; a dedicated
// vocabulary is tracked as a follow-up, not built here). No `notes` field
// — dropped from the contract for this increment (Action has no column to
// store it; silently accepting and discarding it would be worse than not
// accepting it at all).
const REASON_CODES = ['spam', 'harassment', 'hate', 'impersonation', 'scam_fraud', 'violence', 'sexual_content', 'misinformation', 'other'] as const;

export class ReverseActionDto {
  @IsIn(REASON_CODES)
  reasonCode!: (typeof REASON_CODES)[number];
}
