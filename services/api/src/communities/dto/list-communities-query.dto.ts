import { IsIn, IsOptional } from 'class-validator';
import { CursorQueryDto } from '../../common/dto/cursor-query.dto';

export class ListCommunitiesQueryDto extends CursorQueryDto {
  // Only the literal `true` is accepted (same reasoning as notifications'
  // `unread`): `false`, `0` and `yes` are rejected rather than guessed at.
  // There is deliberately no other filter and no text search (Search module).
  @IsOptional()
  @IsIn(['true'])
  mine?: 'true';
}
