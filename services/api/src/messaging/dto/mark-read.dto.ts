import { IsUUID } from 'class-validator';

export class MarkReadDto {
  // Marks read up to and including this message.
  @IsUUID()
  messageId!: string;
}
