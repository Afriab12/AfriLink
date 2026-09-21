import { IsUUID } from 'class-validator';

// A malformed id is a 422 VALIDATION_FAILED (field: "id"), not a 500 from
// Prisma failing to cast it. Every other module gets the same response from
// the shared ParseUuidPipe (common/pipes); this DTO predates it and could be
// switched over (api.md §18, tracked follow-up T-3).
export class NotificationIdParamDto {
  @IsUUID()
  id!: string;
}
