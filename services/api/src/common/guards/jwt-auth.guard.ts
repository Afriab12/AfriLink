import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { AuthenticationRequiredException, TokenExpiredException, TokenInvalidException } from '../errors/api-exception';
import { ACCESS_COOKIE } from '../../auth/cookies.util';

export interface AccessTokenPayload {
  sub: string; // user id
  sid: string; // session id
}

export interface AuthenticatedRequest extends Request {
  user: AccessTokenPayload;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const token = (request.cookies as Record<string, string> | undefined)?.[ACCESS_COOKIE];

    if (!token) {
      throw new AuthenticationRequiredException();
    }

    try {
      const payload = this.jwtService.verify<AccessTokenPayload>(token);
      (request as AuthenticatedRequest).user = payload;
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === 'TokenExpiredError') {
        throw new TokenExpiredException();
      }
      throw new TokenInvalidException();
    }
  }
}
