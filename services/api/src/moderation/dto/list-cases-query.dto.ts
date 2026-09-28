import { IsIn, IsOptional, IsString } from 'class-validator';
import { CursorQueryDto } from '../../common/dto/cursor-query.dto';

const QUEUES = ['platform', 'community', 'content', 'messaging'] as const;
const STATUSES = ['open', 'in_review', 'closed'] as const;
const PRIORITIES = ['low', 'normal', 'high', 'critical'] as const;

export class ListCasesQueryDto extends CursorQueryDto {
  @IsOptional()
  @IsIn(QUEUES)
  queue?: (typeof QUEUES)[number];

  @IsOptional()
  @IsIn(STATUSES)
  status?: (typeof STATUSES)[number];

  @IsOptional()
  @IsIn(PRIORITIES)
  priority?: (typeof PRIORITIES)[number];

  // Either a UUID or the literal 'me' — the service interprets 'me' as the
  // caller's own id and rejects anything else that isn't a UUID with the
  // same VALIDATION_FAILED shape ParseUuidPipe uses.
  @IsOptional()
  @IsString()
  assignedModeratorId?: string;
}
