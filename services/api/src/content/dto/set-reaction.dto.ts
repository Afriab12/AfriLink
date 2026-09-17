import { IsIn } from 'class-validator';

// Fixed five-value taxonomy, ADR-003 §8 — not free text.
export class SetReactionDto {
  @IsIn(['like', 'love', 'laugh', 'support', 'insightful'])
  type!: 'like' | 'love' | 'laugh' | 'support' | 'insightful';
}
