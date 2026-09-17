import { createHash, randomBytes, randomInt } from 'node:crypto';

// Refresh tokens and CSRF tokens are high-entropy random values — SHA-256 is
// sufficient for hashing them at rest (unlike passwords, there's no
// low-entropy brute-force risk a memory-hard hash needs to defend against).
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

// 6-digit numeric OTP for email/phone verification and password reset,
// matching architecture.md §10's "single-use, expiry-bound, rate-limited"
// challenge model.
export function generateVerificationCode(): string {
  return String(randomInt(100000, 1000000));
}
