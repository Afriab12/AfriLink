import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AccessTokenPayload, AuthenticatedRequest } from '../guards/jwt-auth.guard';

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AccessTokenPayload => {
  const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
  return request.user;
});
