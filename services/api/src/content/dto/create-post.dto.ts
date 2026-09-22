import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

// No mediaIds — content.post_media/comment_media don't exist yet, so posts
// are text-only (api.md §16 finding 3).
//
// `community_members` is only valid together with a communityId, and inside
// a community only `public` and `community_members` are (PostsService checks
// the pairing, since it depends on the community).
export class CreatePostDto {
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  body!: string;

  @IsOptional()
  @IsIn(['public', 'followers', 'private', 'community_members'])
  visibility?: 'public' | 'followers' | 'private' | 'community_members';

  @IsOptional()
  @IsUUID()
  communityId?: string;

  @IsOptional()
  @IsIn(['en']) // English-only for MVP, ADR-003 §7
  language?: string;
}
