import { ArrayMaxSize, ArrayUnique, IsArray, IsUUID } from 'class-validator';

export class SetInterestsDto {
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  interestIds!: string[];
}
