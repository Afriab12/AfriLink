import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

// Fixed taxonomies, moderation.md §2/§3 — not free text. Kept as literal
// arrays inline, same convention as SetReactionDto/CreateCommunityDto,
// rather than importing the Prisma-generated enum at runtime.
const TARGET_TYPES = ['profile', 'post', 'comment', 'share', 'message', 'conversation', 'community'] as const;
const REASON_CODES = ['spam', 'harassment', 'hate', 'impersonation', 'scam_fraud', 'violence', 'sexual_content', 'misinformation', 'other'] as const;

export class CreateReportDto {
  @IsIn(TARGET_TYPES)
  targetType!: (typeof TARGET_TYPES)[number];

  @IsUUID()
  targetId!: string;

  @IsIn(REASON_CODES)
  reasonCode!: (typeof REASON_CODES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;
}
