import { IsOptional, IsUUID } from 'class-validator';

// Omitted moderatorId means self-assignment (moderation.md, case
// assignment §11).
export class AssignCaseDto {
  @IsOptional()
  @IsUUID()
  moderatorId?: string;
}
