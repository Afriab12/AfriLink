import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString } from 'class-validator';

export class ListNotificationsQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  // Deliberately no @Min/@Max: api.md §9 says the server clamps an
  // out-of-range limit and never errors, and clampLimit() does exactly that.
  // (Only a non-integer is rejected.)
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  limit?: number;

  // Only the literal `true` is accepted. It is unclear whether `false` would
  // mean "read only" or "everything", so `false`, `0`, `yes` and the empty
  // string are all rejected (422) instead of being guessed at.
  @IsOptional()
  @IsIn(['true'])
  unread?: 'true';
}
