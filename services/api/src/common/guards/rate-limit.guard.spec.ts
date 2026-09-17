import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { RateLimitGuard } from './rate-limit.guard';
import { RateLimitedException } from '../errors/rate-limited.exception';
import type { RateLimitOptions } from './rate-limit.decorator';

function makeContext(ip: string, handlerName = 'testHandler'): ExecutionContext {
  const handler = { name: handlerName } as unknown as () => void;
  return {
    getHandler: () => handler,
    getClass: () => ({ name: 'TestController' }) as unknown as new (...args: unknown[]) => unknown,
    switchToHttp: () => ({
      getRequest: () => ({ ip }),
    }),
  } as unknown as ExecutionContext;
}

function makeReflector(options: RateLimitOptions | undefined): Reflector {
  return { get: vi.fn().mockReturnValue(options) } as unknown as Reflector;
}

describe('RateLimitGuard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows every request when the route has no @RateLimit metadata', () => {
    const guard = new RateLimitGuard(makeReflector(undefined));
    const ctx = makeContext('1.1.1.1');
    for (let i = 0; i < 50; i += 1) {
      expect(guard.canActivate(ctx)).toBe(true);
    }
  });

  it('allows exactly `limit` requests within the window, then rejects the next one', () => {
    const guard = new RateLimitGuard(makeReflector({ limit: 3, windowMs: 60_000 }));
    const ctx = makeContext('2.2.2.2');

    expect(guard.canActivate(ctx)).toBe(true);
    expect(guard.canActivate(ctx)).toBe(true);
    expect(guard.canActivate(ctx)).toBe(true);

    expect(() => guard.canActivate(ctx)).toThrow(RateLimitedException);
    try {
      guard.canActivate(ctx);
      expect.fail('expected RateLimitedException');
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitedException);
      const rateLimitError = error as RateLimitedException;
      expect(rateLimitError.getStatus()).toBe(429);
      expect(rateLimitError.retryAfterSeconds).toBeGreaterThan(0);
      expect(rateLimitError.retryAfterSeconds).toBeLessThanOrEqual(60);
    }
  });

  it('tracks separate IPs independently under the same route', () => {
    const guard = new RateLimitGuard(makeReflector({ limit: 1, windowMs: 60_000 }));
    const ctxA = makeContext('3.3.3.3');
    const ctxB = makeContext('4.4.4.4');

    expect(guard.canActivate(ctxA)).toBe(true);
    expect(() => guard.canActivate(ctxA)).toThrow(RateLimitedException);
    // A different IP hitting the same route is a separate counter.
    expect(guard.canActivate(ctxB)).toBe(true);
  });

  it('tracks separate routes independently for the same IP', () => {
    const guard = new RateLimitGuard(makeReflector({ limit: 1, windowMs: 60_000 }));
    const ctxRoute1 = makeContext('5.5.5.5', 'routeOne');
    const ctxRoute2 = makeContext('5.5.5.5', 'routeTwo');

    expect(guard.canActivate(ctxRoute1)).toBe(true);
    expect(() => guard.canActivate(ctxRoute1)).toThrow(RateLimitedException);
    // Same IP, different route handler — independent counter.
    expect(guard.canActivate(ctxRoute2)).toBe(true);
  });

  it('resets the counter once the window has elapsed', () => {
    const guard = new RateLimitGuard(makeReflector({ limit: 1, windowMs: 60_000 }));
    const ctx = makeContext('6.6.6.6');

    expect(guard.canActivate(ctx)).toBe(true);
    expect(() => guard.canActivate(ctx)).toThrow(RateLimitedException);

    vi.advanceTimersByTime(60_001);

    expect(guard.canActivate(ctx)).toBe(true);
  });
});
