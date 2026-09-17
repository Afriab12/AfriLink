import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  AccountRestrictedException,
  ConflictException,
  ForbiddenActionException,
  PolicyRejectedException,
  ResourceNotFoundException,
  TokenInvalidException,
  ValidationFailedException,
} from '../common/errors/api-exception';
import { ACCESS_TOKEN_TTL_MS, REFRESH_TOKEN_TTL_MS } from './cookies.util';
import { generateOpaqueToken, generateVerificationCode, sha256 } from './token.util';
import type { RegisterDto } from './dto/register.dto';
import type { LoginDto } from './dto/login.dto';
import type { VerifyDto } from './dto/verify.dto';
import type { ForgotPasswordDto } from './dto/forgot-password.dto';
import type { ResetPasswordDto } from './dto/reset-password.dto';

export interface RequestContext {
  ipHash?: string;
  userAgentHash?: string;
  deviceId?: string;
  deviceLabel?: string;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
  sessionId: string;
}

const VERIFICATION_CODE_TTL_MS = 15 * 60 * 1000;
const MAX_VERIFICATION_ATTEMPTS = 5;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  private resolveIdentifier(input: { email?: string; phone?: string }): {
    kind: 'email' | 'phone';
    normalized: string;
  } {
    const provided = [input.email, input.phone].filter((v) => v !== undefined && v !== null && v !== '');
    if (provided.length !== 1) {
      throw new ValidationFailedException([
        { field: 'email', reason: 'exactly one of email or phone is required' },
        { field: 'phone', reason: 'exactly one of email or phone is required' },
      ]);
    }
    if (input.email) {
      return { kind: 'email', normalized: input.email.trim().toLowerCase() };
    }
    return { kind: 'phone', normalized: input.phone!.trim() };
  }

  private async issueSession(
    userId: string,
    context: RequestContext,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<IssuedTokens> {
    const refreshToken = generateOpaqueToken();
    const csrfToken = generateOpaqueToken();

    const session = await tx.session.create({
      data: {
        userId,
        refreshTokenHash: sha256(refreshToken),
        deviceId: context.deviceId,
        deviceLabel: context.deviceLabel,
        ipHash: context.ipHash,
        userAgentHash: context.userAgentHash,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      },
    });

    const accessToken = this.jwtService.sign(
      { sub: userId, sid: session.id },
      { expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000) },
    );

    return { accessToken, refreshToken, csrfToken, sessionId: session.id };
  }

  async register(dto: RegisterDto, context: RequestContext) {
    const { kind, normalized } = this.resolveIdentifier(dto);
    const passwordHash = await argon2.hash(dto.password, { type: argon2.argon2id });

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({ data: {} });
        await tx.credential.create({
          data: { userId: user.id, kind, identifierNormalized: normalized, secretHash: passwordHash },
        });

        const code = generateVerificationCode();
        const challenge = await tx.verificationChallenge.create({
          data: {
            userId: user.id,
            channel: kind,
            destinationHash: sha256(normalized),
            purpose: 'account_verification',
            challengeHash: sha256(code),
            expiresAt: new Date(Date.now() + VERIFICATION_CODE_TTL_MS),
          },
        });

        const tokens = await this.issueSession(user.id, context, tx);
        return { user, challengeId: challenge.id, code, tokens };
      });

      return {
        user: { id: result.user.id, status: result.user.status },
        verification: {
          challengeId: result.challengeId,
          channel: kind,
          // Dev/test-only convenience: no email/SMS provider exists yet
          // (architecture.md provider adapters are unimplemented). Never
          // returned in production — a real provider would deliver this
          // out-of-band instead.
          ...(process.env.NODE_ENV !== 'production' ? { devOnlyCode: result.code } : {}),
        },
        tokens: result.tokens,
      };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('DUPLICATE_ACTION', 'An account with this identifier already exists.');
      }
      throw error;
    }
  }

  async login(dto: LoginDto, context: RequestContext) {
    const { kind, normalized } = this.resolveIdentifier(dto);

    const credential = await this.prisma.credential.findFirst({
      where: { kind, identifierNormalized: normalized, revokedAt: null },
      include: { user: true },
    });

    // Deliberately generic failure for both "no such account" and "wrong
    // password" — api.md §6: never aid account enumeration via login.
    if (!credential) {
      throw new TokenInvalidException('Invalid credentials.');
    }

    const passwordValid = await argon2.verify(credential.secretHash, dto.password);
    if (!passwordValid) {
      throw new TokenInvalidException('Invalid credentials.');
    }

    if (credential.user.status !== 'active') {
      throw new AccountRestrictedException('This account cannot sign in.');
    }

    await this.prisma.credential.update({
      where: { id: credential.id },
      data: { lastUsedAt: new Date() },
    });

    const tokens = await this.issueSession(credential.userId, context);
    return { user: { id: credential.user.id, status: credential.user.status }, tokens };
  }

  async refresh(rawRefreshToken: string, context: RequestContext): Promise<IssuedTokens> {
    const hash = sha256(rawRefreshToken);
    const session = await this.prisma.session.findFirst({ where: { refreshTokenHash: hash } });

    if (!session) {
      throw new TokenInvalidException();
    }

    if (session.revokedAt) {
      // Reuse of an already-rotated refresh token — treat as theft
      // (ADR-004 §3) and revoke every session for this user immediately.
      await this.prisma.session.updateMany({
        where: { userId: session.userId, revokedAt: null },
        data: { revokedAt: new Date(), revokeReason: 'reuse_detected' },
      });
      throw new TokenInvalidException('This session has been revoked.');
    }

    if (session.expiresAt < new Date()) {
      throw new TokenInvalidException('Refresh token has expired.');
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.session.update({
        where: { id: session.id },
        data: { revokedAt: new Date(), revokeReason: 'rotated' },
      });
      return this.issueSession(session.userId, context, tx);
    });
  }

  async logout(sessionId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'logout' },
    });
  }

  async logoutAll(userId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'logout_all' },
    });
  }

  async listSessions(userId: string) {
    const sessions = await this.prisma.session.findMany({
      where: { userId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        deviceId: true,
        deviceLabel: true,
        createdAt: true,
        lastSeenAt: true,
        expiresAt: true,
      },
    });
    return sessions;
  }

  async revokeSession(userId: string, sessionId: string): Promise<void> {
    const session = await this.prisma.session.findUnique({ where: { id: sessionId } });
    if (!session || session.userId !== userId) {
      throw new ResourceNotFoundException();
    }
    await this.prisma.session.update({
      where: { id: sessionId },
      data: { revokedAt: new Date(), revokeReason: 'user_revoked' },
    });
  }

  async requestVerification(userId: string, channel: 'email' | 'phone') {
    const credential = await this.prisma.credential.findFirst({
      where: { userId, kind: channel, revokedAt: null },
    });
    if (!credential) {
      throw new ResourceNotFoundException(`No ${channel} credential exists for this account.`);
    }
    if (credential.verifiedAt) {
      throw new PolicyRejectedException(`This ${channel} is already verified.`);
    }

    const code = generateVerificationCode();
    const challenge = await this.prisma.verificationChallenge.create({
      data: {
        userId,
        channel,
        destinationHash: sha256(credential.identifierNormalized),
        purpose: 'account_verification',
        challengeHash: sha256(code),
        expiresAt: new Date(Date.now() + VERIFICATION_CODE_TTL_MS),
      },
    });

    return {
      challengeId: challenge.id,
      channel,
      ...(process.env.NODE_ENV !== 'production' ? { devOnlyCode: code } : {}),
    };
  }

  async verify(userId: string, dto: VerifyDto): Promise<void> {
    const challenge = await this.prisma.verificationChallenge.findUnique({ where: { id: dto.challengeId } });

    if (!challenge || challenge.userId !== userId || challenge.purpose !== 'account_verification') {
      throw new ResourceNotFoundException();
    }
    if (challenge.consumedAt) {
      throw new ConflictException('CONFLICT', 'This verification challenge has already been used.');
    }
    if (challenge.expiresAt < new Date()) {
      throw new TokenInvalidException('This verification code has expired.');
    }
    if (challenge.attemptCount >= MAX_VERIFICATION_ATTEMPTS) {
      throw new ForbiddenActionException('Too many attempts. Request a new code.');
    }

    if (sha256(dto.code) !== challenge.challengeHash) {
      await this.prisma.verificationChallenge.update({
        where: { id: challenge.id },
        data: { attemptCount: { increment: 1 } },
      });
      throw new TokenInvalidException('Invalid verification code.');
    }

    await this.prisma.$transaction([
      this.prisma.verificationChallenge.update({
        where: { id: challenge.id },
        data: { consumedAt: new Date() },
      }),
      this.prisma.credential.updateMany({
        where: { userId, kind: challenge.channel, revokedAt: null },
        data: { verifiedAt: new Date() },
      }),
    ]);
  }

  async forgotPassword(dto: ForgotPasswordDto): Promise<{ devOnlyCode?: string; devOnlyChallengeId?: string }> {
    const { kind, normalized } = this.resolveIdentifier(dto);
    const credential = await this.prisma.credential.findFirst({
      where: { kind, identifierNormalized: normalized, revokedAt: null },
    });

    // The HTTP-visible response is always identical whether or not the
    // account exists — api.md §6: never reveal account existence via this
    // endpoint. The dev-only fields below are for local/test convenience
    // only (see register()'s identical comment) and are never present in
    // production regardless of whether the account exists.
    if (!credential) {
      return {};
    }

    const code = generateVerificationCode();
    const challenge = await this.prisma.verificationChallenge.create({
      data: {
        userId: credential.userId,
        channel: kind,
        destinationHash: sha256(normalized),
        purpose: 'password_reset',
        challengeHash: sha256(code),
        expiresAt: new Date(Date.now() + VERIFICATION_CODE_TTL_MS),
      },
    });

    if (process.env.NODE_ENV !== 'production') {
      return { devOnlyCode: code, devOnlyChallengeId: challenge.id };
    }
    return {};
  }

  async resetPassword(dto: ResetPasswordDto): Promise<void> {
    const challenge = await this.prisma.verificationChallenge.findUnique({ where: { id: dto.challengeId } });

    if (!challenge || challenge.purpose !== 'password_reset') {
      throw new TokenInvalidException('Invalid or expired reset request.');
    }
    if (challenge.consumedAt || challenge.expiresAt < new Date()) {
      throw new TokenInvalidException('Invalid or expired reset request.');
    }
    if (challenge.attemptCount >= MAX_VERIFICATION_ATTEMPTS) {
      throw new ForbiddenActionException('Too many attempts. Request a new reset code.');
    }
    if (sha256(dto.code) !== challenge.challengeHash) {
      await this.prisma.verificationChallenge.update({
        where: { id: challenge.id },
        data: { attemptCount: { increment: 1 } },
      });
      throw new TokenInvalidException('Invalid or expired reset request.');
    }

    const passwordHash = await argon2.hash(dto.newPassword, { type: argon2.argon2id });

    await this.prisma.$transaction([
      this.prisma.verificationChallenge.update({
        where: { id: challenge.id },
        data: { consumedAt: new Date() },
      }),
      this.prisma.credential.updateMany({
        where: { userId: challenge.userId, kind: challenge.channel, revokedAt: null },
        data: { secretHash: passwordHash },
      }),
      // Security-sensitive credential change — revoke every existing
      // session (architecture.md §10 / ADR-004 §1).
      this.prisma.session.updateMany({
        where: { userId: challenge.userId, revokedAt: null },
        data: { revokedAt: new Date(), revokeReason: 'password_reset' },
      }),
    ]);
  }
}
