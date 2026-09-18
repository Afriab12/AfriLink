import { IsUUID } from 'class-validator';

export class CreateConversationDto {
  @IsUUID()
  recipientUserId!: string;
}
