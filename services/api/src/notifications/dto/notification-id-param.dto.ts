import { IsUUID } from 'class-validator';

// A malformed id is a 422 VALIDATION_FAILED (field: "id"), not a 500 from
// Prisma failing to cast it — see api.md §18, tracked follow-up T-1, for the
// existing routes that still have that problem.
export class NotificationIdParamDto {
  @IsUUID()
  id!: string;
}
