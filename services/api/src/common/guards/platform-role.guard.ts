import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ForbiddenActionException } from '../errors/api-exception';
import { PrismaService } from '../prisma/prisma.service';
import { REQUIRE_ROLE_KEY } from '../decorators/require-role.decorator';
import type { AuthenticatedRequest } from './jwt-auth.guard';

// Platform-role authorization — a separate, additive layer composed
// *after* JwtAuthGuard (reads request.user.sub, which JwtAuthGuard sets)
// and typically before CsrfGuard: authenticate -> account/session
// enforcement (JwtAuthGuard) -> platform-role authorization (this guard)
// -> resource-level checks (each module's own AccessService).
//
// No JWT role claim, no cache: a fresh, indexed database lookup on every
// request to a @RequireRole()-decorated route, mirroring JwtAuthGuard's
// own session-check pattern exactly — so revocation takes effect on the
// very next request, not bound by any token's remaining lifetime.
// docs/05-api/platform-role-authorization.md has the full design.
@Injectable()
export class PlatformRoleGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRole = this.reflector.get<string | undefined>(REQUIRE_ROLE_KEY, context.getHandler());
    if (!requiredRole) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const grant = await this.prisma.userRole.findFirst({
      where: {
        userId: request.user.sub,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        role: { key: requiredRole },
      },
      select: { id: true },
    });

    if (!grant) {
      throw new ForbiddenActionException();
    }
    return true;
  }
}
