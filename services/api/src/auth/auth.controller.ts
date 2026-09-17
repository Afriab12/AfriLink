import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService, type RequestContext } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { VerifyDto } from './dto/verify.dto';
import { RequestVerificationDto } from './dto/request-verification.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { clearAuthCookies, REFRESH_COOKIE, setAuthCookies } from './cookies.util';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { TokenInvalidException } from '../common/errors/api-exception';
import { RateLimit } from '../common/guards/rate-limit.decorator';
import { sha256 } from './token.util';

function buildContext(req: Request): RequestContext {
  return {
    ipHash: req.ip ? sha256(req.ip) : undefined,
    userAgentHash: req.header('user-agent') ? sha256(req.header('user-agent')!) : undefined,
    deviceId: req.header('X-Device-Id'),
    deviceLabel: req.header('X-Device-Label'),
  };
}

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @RateLimit(5, 3_600_000)
  async register(@Body() dto: RegisterDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.authService.register(dto, buildContext(req));
    setAuthCookies(res, result.tokens);
    return { data: { user: result.user, verification: result.verification } };
  }

  @Post('login')
  @HttpCode(200)
  @RateLimit(10, 900_000)
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.authService.login(dto, buildContext(req));
    setAuthCookies(res, result.tokens);
    return { data: { user: result.user } };
  }

  @Post('refresh')
  @HttpCode(200)
  @RateLimit(30, 900_000)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const raw = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    if (!raw) {
      throw new TokenInvalidException('No refresh token presented.');
    }
    const tokens = await this.authService.refresh(raw, buildContext(req));
    setAuthCookies(res, tokens);
    return { data: { rotated: true } };
  }

  @Post('logout')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async logout(@CurrentUser() user: { sid: string }, @Res({ passthrough: true }) res: Response) {
    await this.authService.logout(user.sid);
    clearAuthCookies(res);
    return { data: { loggedOut: true } };
  }

  @Post('logout-all')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async logoutAll(@CurrentUser() user: { sub: string }, @Res({ passthrough: true }) res: Response) {
    await this.authService.logoutAll(user.sub);
    clearAuthCookies(res);
    return { data: { loggedOut: true } };
  }

  @Post('verify')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async verify(@CurrentUser() user: { sub: string }, @Body() dto: VerifyDto) {
    await this.authService.verify(user.sub, dto);
    return { data: { verified: true } };
  }

  @Post('verification-challenges')
  @UseGuards(JwtAuthGuard, CsrfGuard)
  @RateLimit(5, 3_600_000)
  async requestVerification(@CurrentUser() user: { sub: string }, @Body() dto: RequestVerificationDto) {
    const result = await this.authService.requestVerification(user.sub, dto.channel);
    return { data: result };
  }

  @Post('password/forgot')
  @HttpCode(200)
  @RateLimit(3, 3_600_000)
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    const result = await this.authService.forgotPassword(dto);
    // `requested: true` is always identical regardless of whether the
    // account exists; devOnly* fields are dev/test-only and only present
    // (never in production) when a matching account was actually found.
    return { data: { requested: true, ...result } };
  }

  @Post('password/reset')
  @HttpCode(200)
  @RateLimit(5, 3_600_000)
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.authService.resetPassword(dto);
    return { data: { reset: true } };
  }

  @Get('sessions')
  @UseGuards(JwtAuthGuard)
  async listSessions(@CurrentUser() user: { sub: string }) {
    const sessions = await this.authService.listSessions(user.sub);
    return { data: sessions };
  }

  @Delete('sessions/:sessionId')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async revokeSession(@CurrentUser() user: { sub: string }, @Param('sessionId') sessionId: string) {
    await this.authService.revokeSession(user.sub, sessionId);
    return { data: { revoked: true } };
  }
}
