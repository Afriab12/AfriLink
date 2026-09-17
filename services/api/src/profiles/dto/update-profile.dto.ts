import { IsIn, IsOptional, IsString, IsUrl, Length, MaxLength } from 'class-validator';

// avatarMediaId and profileMetadata are deliberately not accepted here —
// see docs/05-api/api.md §16 finding 1 (no media module exists yet to
// validate avatarMediaId against) and database.md §5 ("do not use
// free-form profile metadata for authorization or moderation decisions").
export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  bio?: string;

  @IsOptional()
  @IsString()
  @Length(2, 2)
  countryCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  region?: string;

  @IsOptional()
  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  websiteUrl?: string;

  @IsOptional()
  @IsIn(['public', 'followers', 'private'])
  visibility?: 'public' | 'followers' | 'private';

  @IsOptional()
  @IsString()
  @IsIn(['en']) // English-only for MVP, ADR-003 §7 — no reference.languages table yet
  primaryLanguage?: string;
}
