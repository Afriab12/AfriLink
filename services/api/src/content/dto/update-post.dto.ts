import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class UpdatePostDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  body?: string;

  @IsOptional()
  @IsIn(['public', 'followers', 'private'])
  visibility?: 'public' | 'followers' | 'private';
}
