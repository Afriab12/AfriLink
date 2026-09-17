import { ApiException } from './api-exception';

export class RateLimitedException extends ApiException {
  constructor(public readonly retryAfterSeconds: number) {
    super(429, 'RATE_LIMITED', 'Too many requests. Please try again later.');
  }
}
