import { SetMetadata } from '@nestjs/common';

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
}

export const RATE_LIMIT_KEY = 'rateLimit';

// Under automated tests, many test cases legitimately call the same
// endpoint (e.g. register, used as setup in most auth e2e tests) far more
// than any real client would in the same window. Scaling the limit up in
// test env only avoids cascading 429s across an otherwise-unrelated test
// suite, with zero effect on the production/dev limits below. The guard
// mechanism itself is still verified for real — see
// rate-limit.guard.spec.ts — just not through this multiplier.
const TEST_LIMIT_MULTIPLIER = process.env.NODE_ENV === 'test' ? 1000 : 1;

// Per-route rate limit, checked by RateLimitGuard. Hand-written instead of
// @nestjs/throttler: the package's current release (6.5.0) doesn't yet
// support NestJS 12 (peer range tops out at ^11), and this need is small
// enough not to warrant downgrading the framework for it.
export const RateLimit = (limit: number, windowMs: number) =>
  SetMetadata(RATE_LIMIT_KEY, { limit: limit * TEST_LIMIT_MULTIPLIER, windowMs });
