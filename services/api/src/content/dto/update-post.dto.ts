import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

// No communityId: a post cannot be moved into or out of a community.
export class UpdatePostDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  body?: string;

  @IsOptional()
  @IsIn(['public', 'followers', 'private', 'community_members'])
  visibility?: 'public' | 'followers' | 'private' | 'community_members';
}
