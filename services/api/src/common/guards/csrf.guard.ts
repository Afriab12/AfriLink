import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { ForbiddenActionException } from '../errors/api-exception';
import { CSRF_COOKIE } from '../../auth/cookies.util';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Double-submit CSRF check (ADR-004 §2): every state-changing, cookie-
// authenticated request must echo the afrilink_csrf cookie value back as
// X-CSRF-Token. A cross-site attacker can trigger the request but cannot
// read the cookie to put its value in the header.
@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    if (SAFE_METHODS.has(request.method)) {
      return true;
    }

    const cookieToken = (request.cookies as Record<string, string> | undefined)?.[CSRF_COOKIE];
    const headerToken = request.header('X-CSRF-Token');

    if (!cookieToken || !headerToken || cookieToken !== headerToken) {
      throw new ForbiddenActionException('CSRF token missing or invalid.');
    }

    return true;
  }
}
