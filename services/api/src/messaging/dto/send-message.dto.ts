import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class SendMessageDto {
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  body!: string;

  // Client-generated, paired with sender_id in a unique DB constraint
  // (database.md §9) so a retried send never creates a duplicate message.
  @IsUUID()
  clientMessageId!: string;
}
