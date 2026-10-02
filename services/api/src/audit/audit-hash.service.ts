import { Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';

// Dedicated to Audit C's Auth producers. HMAC-SHA256, keyed by its own
// AUDIT_HASH_SECRET — deliberately not sha256() (token.util.ts, the
// unsalted hash Session.ipHash/userAgentHash already use, which has the
// small-input-space weakness the Audit design review flagged) and
// deliberately not JWT_ACCESS_SECRET. Read once at construction via
// requireEnv, same fail-fast precedent as MediaStorageService.
@Injectable()
export class AuditHashService {
  private readonly secret: string;

  constructor() {
    this.secret = requireEnv('AUDIT_HASH_SECRET');
  }

  hash(value: string): string {
    return createHmac('sha256', this.secret).update(value).digest('hex');
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set — see .env.example`);
  }
  return value;
}
