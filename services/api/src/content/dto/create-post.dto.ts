import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

// No mediaIds, no communityId — content.post_media/comment_media don't
// exist in Phase 1, and content.posts.community_id has no FK to validate
// against (no `community` schema yet). Posts are text-only for now — see
// api.md §16 finding 3 (this was already established during API
// architecture design, not a new decision here).
export class CreatePostDto {
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  body!: string;

  @IsOptional()
  @IsIn(['public', 'followers', 'private'])
  visibility?: 'public' | 'followers' | 'private';

  @IsOptional()
  @IsIn(['en']) // English-only for MVP, ADR-003 §7
  language?: string;
}
