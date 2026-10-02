import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuditEventInput } from '../audit/dto/audit-event.types';
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
  // Session-table hashes (unchanged, plain sha256() — never touched by
  // Audit C; a distinct mechanism from the fields below).
  ipHash?: string;
  userAgentHash?: string;
  deviceId?: string;
  deviceLabel?: string;
  // Audit C additions — computed in AuthController.buildContext() via
  // AuditHashService (HMAC-SHA256 + AUDIT_HASH_SECRET), forwarded here
  // verbatim. AuthService never hashes anything itself.
  requestId?: string;
  auditIpHash?: string;
  auditUserAgentHash?: string;
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
    private readonly audit: AuditService,
  ) {}

  // Best-effort events must never fail the authentication operation they
  // accompany (Audit C, decision #10). The log line names only the event
  // type — never AUDIT_HASH_SECRET, raw IP/UA, a password, a code, or any
  // token/credential, since none of those are ever interpolated here.
  private async recordBestEffortAudit(input: AuditEventInput): Promise<void> {
    try {
      await this.audit.record(input);
    } catch {
      console.warn(`[audit] best-effort event "${input.eventType}" failed to record`);
    }
  }

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

    await this.recordBestEffortAudit({
      eventType: 'auth_login_succeeded',
      actorId: credential.userId,
      subjectType: 'profile',
      subjectId: credential.userId,
      requestId: context.requestId,
      ipHash: context.auditIpHash,
      userAgentHash: context.auditUserAgentHash,
      metadata: { sessionId: tokens.sessionId },
      occurredAt: new Date(),
    });

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
      // actorId null — system-detected, not a user-initiated action.
      await this.recordBestEffortAudit({
        eventType: 'auth_all_sessions_revoked',
        actorId: null,
        subjectType: 'profile',
        subjectId: session.userId,
        requestId: context.requestId,
        ipHash: context.auditIpHash,
        userAgentHash: context.auditUserAgentHash,
        reason: 'reuse_detected',
        metadata: {},
        occurredAt: new Date(),
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

  async logout(userId: string, sessionId: string, context: RequestContext): Promise<void> {
    const result = await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'logout' },
    });
    // Only audit a revocation that actually happened — preserves the
    // existing no-op-is-still-200 behavior above unchanged.
    if (result.count > 0) {
      await this.recordBestEffortAudit({
        eventType: 'auth_session_revoked',
        actorId: userId,
        subjectType: 'profile',
        subjectId: userId,
        requestId: context.requestId,
        ipHash: context.auditIpHash,
        userAgentHash: context.auditUserAgentHash,
        reason: 'logout',
        metadata: { sessionId },
        occurredAt: new Date(),
      });
    }
  }

  async logoutAll(userId: string, context: RequestContext): Promise<void> {
    await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'logout_all' },
    });
    await this.recordBestEffortAudit({
      eventType: 'auth_all_sessions_revoked',
      actorId: userId,
      subjectType: 'profile',
      subjectId: userId,
      requestId: context.requestId,
      ipHash: context.auditIpHash,
      userAgentHash: context.auditUserAgentHash,
      reason: 'logout_all',
      metadata: {},
      occurredAt: new Date(),
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

  async revokeSession(userId: string, sessionId: string, context: RequestContext): Promise<void> {
    const session = await this.prisma.session.findUnique({ where: { id: sessionId } });
    if (!session || session.userId !== userId) {
      throw new ResourceNotFoundException();
    }
    await this.prisma.session.update({
      where: { id: sessionId },
      data: { revokedAt: new Date(), revokeReason: 'user_revoked' },
    });
    await this.recordBestEffortAudit({
      eventType: 'auth_session_revoked',
      actorId: userId,
      subjectType: 'profile',
      subjectId: userId,
      requestId: context.requestId,
      ipHash: context.auditIpHash,
      userAgentHash: context.auditUserAgentHash,
      reason: 'user_revoked',
      metadata: { sessionId },
      occurredAt: new Date(),
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

  async verify(userId: string, dto: VerifyDto, context: RequestContext): Promise<void> {
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

    // Callback form (converted from array form) so the mandatory
    // auth_account_verified write can share this same transaction's `tx`
    // client — array-form $transaction cannot host an interactive,
    // tx-consuming call (Audit C, decision #9/#18).
    const occurredAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.verificationChallenge.update({
        where: { id: challenge.id },
        data: { consumedAt: occurredAt },
      });
      await tx.credential.updateMany({
        where: { userId, kind: challenge.channel, revokedAt: null },
        data: { verifiedAt: occurredAt },
      });
      await this.audit.record(
        {
          eventType: 'auth_account_verified',
          actorId: userId,
          subjectType: 'profile',
          subjectId: userId,
          requestId: context.requestId,
          ipHash: context.auditIpHash,
          userAgentHash: context.auditUserAgentHash,
          metadata: { channel: challenge.channel as 'email' | 'phone' },
          occurredAt,
        },
        tx,
      );
    });
  }

  async forgotPassword(dto: ForgotPasswordDto, context: RequestContext): Promise<{ devOnlyCode?: string; devOnlyChallengeId?: string }> {
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

    // Best-effort, and only on this resolved-account branch — never on the
    // `if (!credential) return {}` path above. The event's own absence is
    // part of the enumeration defense (Audit C, decision #6/#16), not an
    // oversight: an existence-conditional audit row would itself be an
    // oracle the identical HTTP response is designed to prevent.
    await this.recordBestEffortAudit({
      eventType: 'auth_password_reset_requested',
      actorId: null,
      subjectType: 'profile',
      subjectId: credential.userId,
      requestId: context.requestId,
      ipHash: context.auditIpHash,
      userAgentHash: context.auditUserAgentHash,
      metadata: { challengeId: challenge.id },
      occurredAt: new Date(),
    });

    if (process.env.NODE_ENV !== 'production') {
      return { devOnlyCode: code, devOnlyChallengeId: challenge.id };
    }
    return {};
  }

  async resetPassword(dto: ResetPasswordDto, context: RequestContext): Promise<void> {
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

    // Callback form (converted from array form) so both mandatory audit
    // writes below can share this transaction's `tx` client (Audit C,
    // decision #9/#18). occurredAt captured once and reused for the DB
    // writes and both audit events (decision #11).
    const occurredAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.verificationChallenge.update({
        where: { id: challenge.id },
        data: { consumedAt: occurredAt },
      });
      await tx.credential.updateMany({
        where: { userId: challenge.userId, kind: challenge.channel, revokedAt: null },
        data: { secretHash: passwordHash },
      });
      // Security-sensitive credential change — revoke every existing
      // session (architecture.md §10 / ADR-004 §1).
      await tx.session.updateMany({
        where: { userId: challenge.userId, revokedAt: null },
        data: { revokedAt: occurredAt, revokeReason: 'password_reset' },
      });

      await this.audit.record(
        {
          eventType: 'auth_password_reset_completed',
          actorId: null,
          subjectType: 'profile',
          subjectId: challenge.userId,
          requestId: context.requestId,
          ipHash: context.auditIpHash,
          userAgentHash: context.auditUserAgentHash,
          metadata: { challengeId: challenge.id },
          occurredAt,
        },
        tx,
      );
      await this.audit.record(
        {
          eventType: 'auth_all_sessions_revoked',
          actorId: null,
          subjectType: 'profile',
          subjectId: challenge.userId,
          requestId: context.requestId,
          ipHash: context.auditIpHash,
          userAgentHash: context.auditUserAgentHash,
          reason: 'password_reset',
          metadata: {},
          occurredAt,
        },
        tx,
      );
    });
  }
}
