import { IsIn } from 'class-validator';

// Only `priority` is mutable through PATCH /moderation/cases/{id} — status,
// queue and assignedModeratorId each have their own dedicated endpoint/rule.
export class UpdateCasePriorityDto {
  @IsIn(['low', 'normal', 'high', 'critical'])
  priority!: 'low' | 'normal' | 'high' | 'critical';
}
