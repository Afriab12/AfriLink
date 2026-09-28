import { ArrayMinSize, ArrayUnique, IsArray, IsIn, IsOptional, IsUUID } from 'class-validator';

const QUEUES = ['platform', 'community', 'content', 'messaging'] as const;
const PRIORITIES = ['low', 'normal', 'high', 'critical'] as const;
const SOURCES = ['user_report', 'automated_signal', 'escalation'] as const;

export class CreateCaseDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  reportIds!: string[];

  @IsIn(QUEUES)
  queue!: (typeof QUEUES)[number];

  @IsOptional()
  @IsIn(PRIORITIES)
  priority?: (typeof PRIORITIES)[number];

  @IsIn(SOURCES)
  source!: (typeof SOURCES)[number];
}
