import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { RATE_LIMIT_KEY, type RateLimitOptions } from './rate-limit.decorator';
import { RateLimitedException } from '../errors/rate-limited.exception';

interface Counter {
  count: number;
  resetAt: number;
}

// In-memory, per-process rate limiting. Known limitation: entries for a
// given key are only refreshed when that key is hit again, so it doesn't
// actively evict old entries — acceptable at MVP scale/single-instance
// local dev; revisit (e.g. a Redis-backed store, matching architecture.md
// §22) if this needs to survive restarts or work across multiple
// instances.
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly counters = new Map<string, Counter>();

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const options = this.reflector.get<RateLimitOptions | undefined>(RATE_LIMIT_KEY, context.getHandler());
    if (!options) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const key = `${context.getClass().name}.${context.getHandler().name}:${request.ip ?? 'unknown'}`;
    const now = Date.now();

    const existing = this.counters.get(key);
    if (!existing || existing.resetAt <= now) {
      this.counters.set(key, { count: 1, resetAt: now + options.windowMs });
      return true;
    }

    existing.count += 1;
    if (existing.count > options.limit) {
      throw new RateLimitedException(Math.ceil((existing.resetAt - now) / 1000));
    }
    return true;
  }
}
