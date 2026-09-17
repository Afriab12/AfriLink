import { IsString, Length, MaxLength, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @IsString()
  challengeId!: string;

  @IsString()
  @Length(6, 6)
  code!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  newPassword!: string;
}
