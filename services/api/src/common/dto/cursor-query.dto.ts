import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString } from 'class-validator';

// Cursor pagination query shared by the list endpoints that follow the
// clamping convention (api.md §9): deliberately no @Min/@Max, because the
// server clamps an out-of-range limit and never errors (clampLimit()).
// Only a non-integer is rejected.
export class CursorQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  limit?: number;
}
