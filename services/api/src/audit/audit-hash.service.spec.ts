import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AuditHashService } from './audit-hash.service';

describe('AuditHashService', () => {
  const ORIGINAL_SECRET = process.env.AUDIT_HASH_SECRET;

  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) {
      delete process.env.AUDIT_HASH_SECRET;
    } else {
      process.env.AUDIT_HASH_SECRET = ORIGINAL_SECRET;
    }
  });

  it('throws at construction when AUDIT_HASH_SECRET is unset', () => {
    delete process.env.AUDIT_HASH_SECRET;
    expect(() => new AuditHashService()).toThrow(/AUDIT_HASH_SECRET/);
  });

  it('throws at construction when AUDIT_HASH_SECRET is an empty string', () => {
    process.env.AUDIT_HASH_SECRET = '';
    expect(() => new AuditHashService()).toThrow(/AUDIT_HASH_SECRET/);
  });

  describe('with a secret set', () => {
    beforeEach(() => {
      process.env.AUDIT_HASH_SECRET = 'test-only-secret-do-not-use-in-any-real-environment';
    });

    it('returns a hex-encoded digest', () => {
      const service = new AuditHashService();
      const result = service.hash('203.0.113.7');
      expect(result).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is deterministic: same input + same secret produces the same output', () => {
      const service = new AuditHashService();
      expect(service.hash('203.0.113.7')).toBe(service.hash('203.0.113.7'));
    });

    it('produces different output for different input', () => {
      const service = new AuditHashService();
      expect(service.hash('203.0.113.7')).not.toBe(service.hash('203.0.113.8'));
    });

    it('produces different output for a different secret (proves it is keyed, not plain SHA-256)', () => {
      const a = new AuditHashService();
      const aResult = a.hash('203.0.113.7');

      process.env.AUDIT_HASH_SECRET = 'a-completely-different-secret-value';
      const b = new AuditHashService();
      const bResult = b.hash('203.0.113.7');

      expect(aResult).not.toBe(bResult);
    });

    it('does not match plain, unkeyed SHA-256 of the same input (not reusing the Session-hash mechanism)', async () => {
      const { createHash } = await import('node:crypto');
      const service = new AuditHashService();
      const plainSha256 = createHash('sha256').update('203.0.113.7').digest('hex');
      expect(service.hash('203.0.113.7')).not.toBe(plainSha256);
    });
  });
});
