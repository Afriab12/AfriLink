import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { COMMUNITY_VISIBILITIES, MEMBERSHIP_POLICIES, SLUG_MAX, SLUG_MIN, SLUG_PATTERN } from '../communities.constants';

const trim = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);

export class CreateCommunityDto {
  @IsString()
  @MinLength(SLUG_MIN)
  @MaxLength(SLUG_MAX)
  @Matches(SLUG_PATTERN, { message: 'slug must be lower-case letters and digits separated by single hyphens, and not shaped like an id' })
  slug!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  rules?: string;

  @IsOptional()
  @IsIn(COMMUNITY_VISIBILITIES)
  visibility?: (typeof COMMUNITY_VISIBILITIES)[number];

  @IsOptional()
  @IsIn(MEMBERSHIP_POLICIES)
  membershipPolicy?: (typeof MEMBERSHIP_POLICIES)[number];
}
