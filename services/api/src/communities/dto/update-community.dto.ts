import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { COMMUNITY_VISIBILITIES, MEMBERSHIP_POLICIES } from '../communities.constants';

const trim = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);

// The slug is immutable (links and lookups depend on it), and ownership,
// status and counters are never client-writable: forbidNonWhitelisted turns
// any of them into a 422.
export class UpdateCommunityDto {
  // Optional, but never null: a community always has a name.
  @ValidateIf((o: UpdateCommunityDto) => o.name !== undefined)
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  // null clears the field.
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  rules?: string | null;

  @IsOptional()
  @IsIn(COMMUNITY_VISIBILITIES)
  visibility?: (typeof COMMUNITY_VISIBILITIES)[number];

  @IsOptional()
  @IsIn(MEMBERSHIP_POLICIES)
  membershipPolicy?: (typeof MEMBERSHIP_POLICIES)[number];
}
