import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AccessTokenPayload, AuthenticatedRequest } from '../guards/jwt-auth.guard';

// Pairs with OptionalJwtAuthGuard — unlike CurrentUser, correctly types the
// result as possibly absent (anonymous viewer), rather than asserting a
// user is always present.
export const OptionalCurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AccessTokenPayload | undefined => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    return request.user;
  },
);
