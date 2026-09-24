import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { ACCESS_COOKIE } from '../../auth/cookies.util';
import { PrismaService } from '../prisma/prisma.service';
import type { AccessTokenPayload, AuthenticatedRequest } from './jwt-auth.guard';

// Unlike JwtAuthGuard, never rejects the request — it only populates
// request.user when a valid access-token cookie is present, so a single
// endpoint (GET /profiles/:id) can serve both anonymous and authenticated
// callers and apply different visibility rules accordingly. An absent or
// invalid token is treated as "anonymous viewer", not an error.
//
// Same request-time session/account-status re-check as JwtAuthGuard (a
// revoked session or a non-active account must not be recognized, even on
// an optional-auth route — e.g. a suspended user's still-valid token must
// not grant them "authenticated" treatment like seeing a followers-only
// profile), but the failure mode differs to match this guard's contract:
// it falls back to "anonymous viewer" instead of rejecting the request.
@Injectable()
export class OptionalJwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = (request.cookies as Record<string, string> | undefined)?.[ACCESS_COOKIE];

    if (token) {
      try {
        const payload = this.jwtService.verify<AccessTokenPayload>(token);
        const session = await this.prisma.session.findUnique({
          where: { id: payload.sid },
          select: { revokedAt: true, expiresAt: true, user: { select: { status: true } } },
        });
        const sessionValid = session && session.revokedAt === null && session.expiresAt.getTime() >= Date.now();
        if (sessionValid && session.user.status === 'active') {
          (request as AuthenticatedRequest).user = payload;
        }
        // Invalid/expired token, revoked session, or non-active account on
        // an optional-auth route: proceed as anonymous rather than reject —
        // this route never requires auth.
      } catch {
        // Malformed/expired JWT: same anonymous fallback.
      }
    }

    return true;
  }
}
