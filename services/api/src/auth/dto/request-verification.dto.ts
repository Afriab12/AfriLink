import { IsIn } from 'class-validator';

export class RequestVerificationDto {
  @IsIn(['email', 'phone'])
  channel!: 'email' | 'phone';
}
