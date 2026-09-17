import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateShareDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;
}
