import { IsNotEmpty, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class CreateAccountAppealDto {
  @IsString()
  @IsNotEmpty()
  credential!: string;

  @IsUUID()
  actionId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  statement!: string;
}
