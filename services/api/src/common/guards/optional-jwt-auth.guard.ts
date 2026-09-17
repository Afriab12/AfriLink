import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { ACCESS_COOKIE } from '../../auth/cookies.util';
import type { AccessTokenPayload, AuthenticatedRequest } from './jwt-auth.guard';

// Unlike JwtAuthGuard, never rejects the request — it only populates
// request.user when a valid access-token cookie is present, so a single
// endpoint (GET /profiles/:id) can serve both anonymous and authenticated
// callers and apply different visibility rules accordingly. An absent or
// invalid token is treated as "anonymous viewer", not an error.
@Injectable()
export class OptionalJwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const token = (request.cookies as Record<string, string> | undefined)?.[ACCESS_COOKIE];

    if (token) {
      try {
        const payload = this.jwtService.verify<AccessTokenPayload>(token);
        (request as AuthenticatedRequest).user = payload;
      } catch {
        // Invalid/expired token on an optional-auth route: proceed as
        // anonymous rather than reject — this route never requires auth.
      }
    }

    return true;
  }
}
