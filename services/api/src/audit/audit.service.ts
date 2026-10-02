import { Injectable } from '@nestjs/common';
import { isUUID, validateSync } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { ValidationFailedException, type ApiErrorDetail } from '../common/errors/api-exception';
import { AUDIT_METADATA_CLASSES, MANDATORY_AUDIT_EVENT_TYPES, type AuditEventInput } from './dto/audit-event.types';

const MAX_METADATA_BYTES = 8 * 1024;
const MAX_REASON_LENGTH = 2000;

// Writer-only (Audit A, docs/04-database/audit.md). No hashing, no Auth/
// Moderation wiring — those are separate, later-gated increments. This
// service's entire security contract is: validate the envelope, validate
// metadata against the one allowlisted shape for its eventType (rejecting
// anything undeclared — the redaction mechanism), and insert verbatim.
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: AuditEventInput, tx?: Prisma.TransactionClient): Promise<void> {
    if (MANDATORY_AUDIT_EVENT_TYPES.has(input.eventType) && !tx) {
      throw new Error(
        `AuditService.record: eventType "${input.eventType}" is mandatory and must be recorded inside the caller's transaction (pass tx).`,
      );
    }

    const details = this.validateEnvelope(input);
    details.push(...this.validateMetadata(input));
    if (details.length > 0) {
      throw new ValidationFailedException(details);
    }

    const client = tx ?? this.prisma;
    await client.auditEvent.create({
      data: {
        eventType: input.eventType,
        actorId: input.actorId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        metadata: input.metadata as object,
        reason: input.reason ?? null,
        requestId: input.requestId ?? null,
        traceId: input.traceId ?? null,
        ipHash: input.ipHash ?? null,
        userAgentHash: input.userAgentHash ?? null,
        occurredAt: input.occurredAt,
      },
    });
  }

  private validateEnvelope(input: AuditEventInput): ApiErrorDetail[] {
    const details: ApiErrorDetail[] = [];

    if (input.actorId !== null && !isUUID(input.actorId)) {
      details.push({ field: 'actorId', reason: 'actorId must be a UUID or null' });
    }
    if (typeof input.subjectType !== 'string' || input.subjectType.length === 0) {
      details.push({ field: 'subjectType', reason: 'subjectType is required' });
    }
    if (!isUUID(input.subjectId)) {
      details.push({ field: 'subjectId', reason: 'subjectId must be a UUID' });
    }
    if (input.reason !== undefined && input.reason.length > MAX_REASON_LENGTH) {
      details.push({ field: 'reason', reason: `reason must be at most ${MAX_REASON_LENGTH} characters` });
    }

    return details;
  }

  private validateMetadata(input: AuditEventInput): ApiErrorDetail[] {
    const details: ApiErrorDetail[] = [];

    // Manual object-shape guard, since `forbidUnknownValues` (on by default
    // in class-validator, and explicitly disabled below) misfires on
    // AuthAllSessionsRevokedMetadata, the one event type whose metadata
    // class has zero decorated properties — it flags a legitimately empty
    // `{}` as "unknownValue" because there's nothing to validate against.
    // This check covers the same intent (reject a non-object payload)
    // without that false positive.
    if (typeof input.metadata !== 'object' || input.metadata === null || Array.isArray(input.metadata)) {
      details.push({ field: 'metadata', reason: 'metadata must be an object' });
      return details;
    }

    const MetadataClass = AUDIT_METADATA_CLASSES[input.eventType];
    const instance = plainToInstance(MetadataClass, input.metadata, { excludeExtraneousValues: false });
    const errors = validateSync(instance, { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: false });
    for (const error of errors) {
      const reason = Object.values(error.constraints ?? {})[0] ?? 'is invalid';
      details.push({ field: `metadata.${error.property}`, reason });
    }

    const size = Buffer.byteLength(JSON.stringify(input.metadata));
    if (size > MAX_METADATA_BYTES) {
      details.push({ field: 'metadata', reason: `metadata must be at most ${MAX_METADATA_BYTES} bytes` });
    }

    return details;
  }
}
