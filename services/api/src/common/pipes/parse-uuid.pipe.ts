import { ArgumentMetadata, Injectable, PipeTransform } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { ValidationFailedException } from '../errors/api-exception';

// Rejects a malformed UUID path parameter at the request boundary, as the canonical
// 422 VALIDATION_FAILED (api.md section 6) with the parameter's own name as the field, e.g.
//   { "field": "postId", "reason": "postId must be a UUID" }
// Without it the raw string reaches Prisma, which cannot cast it to a uuid column and throws,
// and the client gets a 500 INTERNAL_ERROR (tracked follow-up T-1, api.md section 18).
//
// Use it on every route parameter that is a database id:
//   @Param('postId', ParseUuidPipe) postId: string
//
// Deliberately the same rule as the @IsUUID() used by the body DTOs: any UUID version, either
// letter case. It is not narrowed to UUIDv7 (ADR-003), so nothing that resolves today stops
// resolving. Guards run before pipes, so authentication and CSRF answers are unchanged, and the
// offending value is never echoed back in the response.
@Injectable()
export class ParseUuidPipe implements PipeTransform<string, string> {
  transform(value: string, metadata: ArgumentMetadata): string {
    if (typeof value === 'string' && isUUID(value)) {
      return value;
    }
    const field = metadata.data ?? 'id';
    throw new ValidationFailedException([{ field, reason: `${field} must be a UUID` }]);
  }
}
