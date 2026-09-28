import { IsIn, IsOptional } from 'class-validator';
import { CursorQueryDto } from '../../common/dto/cursor-query.dto';

const STATUSES = ['open', 'under_review', 'closed'] as const;
const REASON_CODES = ['spam', 'harassment', 'hate', 'impersonation', 'scam_fraud', 'violence', 'sexual_content', 'misinformation', 'other'] as const;
const TARGET_TYPES = ['profile', 'post', 'comment', 'share', 'message', 'conversation', 'community'] as const;

// Allowlisted filters for the moderator queue (moderation.md §6). Omitting
// `status` returns every status, including `closed` — this is a filter, not
// an exclusion.
export class ListReportsQueryDto extends CursorQueryDto {
  @IsOptional()
  @IsIn(STATUSES)
  status?: (typeof STATUSES)[number];

  @IsOptional()
  @IsIn(['low', 'normal', 'high', 'critical'])
  priority?: 'low' | 'normal' | 'high' | 'critical';

  @IsOptional()
  @IsIn(TARGET_TYPES)
  targetType?: (typeof TARGET_TYPES)[number];

  @IsOptional()
  @IsIn(REASON_CODES)
  reasonCode?: (typeof REASON_CODES)[number];
}
