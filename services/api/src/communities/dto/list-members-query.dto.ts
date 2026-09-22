import { IsIn, IsOptional } from 'class-validator';
import { CursorQueryDto } from '../../common/dto/cursor-query.dto';

export class ListMembersQueryDto extends CursorQueryDto {
  // `pending` (join requests) is restricted to the owner and moderators;
  // banned/rejected/left/removed rows are never listable.
  @IsOptional()
  @IsIn(['active', 'pending'])
  status?: 'active' | 'pending';
}
