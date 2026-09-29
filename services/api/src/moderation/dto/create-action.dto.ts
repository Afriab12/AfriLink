import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, ValidateNested } from 'class-validator';

// Fixed taxonomies — same inline-literal-array convention as
// CreateReportDto/SetReactionDto, not the Prisma-generated runtime enum.
const ACTION_TYPES = ['remove_content', 'restrict_content', 'warn_user', 'suspend_account', 'ban_account', 'restrict_community_participation'] as const;
const TARGET_TYPES = ['profile', 'post', 'comment', 'share', 'message', 'conversation', 'community'] as const;
const REASON_CODES = ['spam', 'harassment', 'hate', 'impersonation', 'scam_fraud', 'violence', 'sexual_content', 'misinformation', 'other'] as const;

// Every field here is independently optional at the DTO layer — which of
// them is actually required/meaningful depends on `actionType`
// (communityId for restrict_community_participation, durationSeconds only
// meaningful for suspend_account, message only for warn_user). No
// per-actionType conditional validator exists elsewhere in this codebase,
// so that cross-field requirement is enforced in ActionsService instead,
// the same split CreateReportDto/ActionsService already uses between
// syntactic (DTO) and semantic (service) validation.
class ActionDetailsDto {
  @IsOptional()
  @IsUUID()
  communityId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  durationSeconds?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  message?: string;
}

// `scope` is deliberately NOT a field here — moderation.md §4 states it is
// always server-derived from `actionType`, never client-supplied (the
// document's own request-body example still shows a client `scope` field,
// which contradicts that same paragraph; treated as stale, not followed).
export class CreateActionDto {
  @IsIn(ACTION_TYPES)
  actionType!: (typeof ACTION_TYPES)[number];

  @IsIn(TARGET_TYPES)
  targetType!: (typeof TARGET_TYPES)[number];

  @IsUUID()
  targetId!: string;

  @IsIn(REASON_CODES)
  reasonCode!: (typeof REASON_CODES)[number];

  @IsOptional()
  @ValidateNested()
  @Type(() => ActionDetailsDto)
  details?: ActionDetailsDto;
}
