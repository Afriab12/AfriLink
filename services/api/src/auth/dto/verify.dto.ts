import { IsString, Length } from 'class-validator';

export class VerifyDto {
  @IsString()
  challengeId!: string;

  @IsString()
  @Length(6, 6)
  code!: string;
}
