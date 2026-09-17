import type { Response } from 'express';

// Concrete cookie parameters approved in ADR-004 §1 (docs/10-decisions/decisions.md).
export const ACCESS_COOKIE = 'afrilink_at';
export const REFRESH_COOKIE = 'afrilink_rt';
export const CSRF_COOKIE = 'afrilink_csrf';

export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const REFRESH_COOKIE_PATH = '/api/v1/auth/refresh';

const isProduction = process.env.NODE_ENV === 'production';

export function setAuthCookies(
  res: Response,
  tokens: { accessToken: string; refreshToken: string; csrfToken: string },
): void {
  res.cookie(ACCESS_COOKIE, tokens.accessToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: ACCESS_TOKEN_TTL_MS,
  });
  res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: REFRESH_COOKIE_PATH,
    maxAge: REFRESH_TOKEN_TTL_MS,
  });
  // Deliberately NOT httpOnly — the frontend must read this and echo it
  // back as X-CSRF-Token (double-submit pattern, ADR-004 §2).
  res.cookie(CSRF_COOKIE, tokens.csrfToken, {
    httpOnly: false,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: ACCESS_TOKEN_TTL_MS,
  });
}

export function clearAuthCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE, { path: '/' });
  res.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
  res.clearCookie(CSRF_COOKIE, { path: '/' });
}
