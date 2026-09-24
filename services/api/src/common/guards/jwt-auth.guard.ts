import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { AuthenticationRequiredException, AccountRestrictedException, TokenExpiredException, TokenInvalidException } from '../errors/api-exception';
import { ACCESS_COOKIE } from '../../auth/cookies.util';
import { PrismaService } from '../prisma/prisma.service';
import { SKIP_ACCOUNT_STATUS_CHECK_KEY } from '../decorators/skip-account-status-check.decorator';

export interface AccessTokenPayload {
  sub: string; // user id
  sid: string; // session id
}

export interface AuthenticatedRequest extends Request {
  user: AccessTokenPayload;
}

// Beyond verifying the JWT's own signature/expiry, this guard re-checks
// the database on every request:
//   1. the session behind the token must still be un-revoked and
//      un-expired (a logout, logout-all, or theft-triggered mass
//      revocation must take effect immediately, not after the access
//      token's own up-to-15-minute life runs out);
//   2. the account must currently be `active` (a suspend_account/
//      ban_account moderation action, or any other status change, must
//      also take effect immediately) — unless the route is decorated
//      with @SkipAccountStatusCheck(), which a restricted/suspended/
//      banned account still needs for its own logout routes.
// Both checks are one indexed round trip (session PK joined to user PK).
// See the design proposal this implements for the performance/caching
// tradeoffs considered and deliberately deferred.
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = (request.cookies as Record<string, string> | undefined)?.[ACCESS_COOKIE];

    if (!token) {
      throw new AuthenticationRequiredException();
    }

    let payload: AccessTokenPayload;
    try {
      payload = this.jwtService.verify<AccessTokenPayload>(token);
    } catch (error) {
      if (error instanceof Error && error.name === 'TokenExpiredError') {
        throw new TokenExpiredException();
      }
      throw new TokenInvalidException();
    }

    const session = await this.prisma.session.findUnique({
      where: { id: payload.sid },
      select: { revokedAt: true, expiresAt: true, user: { select: { status: true } } },
    });
    if (!session || session.revokedAt !== null || session.expiresAt.getTime() < Date.now()) {
      throw new TokenInvalidException();
    }

    const skipAccountStatusCheck = this.reflector.get<boolean | undefined>(SKIP_ACCOUNT_STATUS_CHECK_KEY, context.getHandler());
    if (!skipAccountStatusCheck && session.user.status !== 'active') {
      throw new AccountRestrictedException();
    }

    (request as AuthenticatedRequest).user = payload;
    return true;
  }
}
