import { HttpException } from '@nestjs/common';

export interface ApiErrorDetail {
  field: string;
  reason: string;
}

// Carries the canonical error envelope shape from docs/05-api/api.md §6.
// The filter (http-exception.filter.ts) reads `code`/`details` back off
// the HttpException response body — never construct HttpException directly
// for a domain error, use this instead.
export class ApiException extends HttpException {
  constructor(status: number, code: string, message: string, details?: ApiErrorDetail[]) {
    super({ code, message, details }, status);
  }
}

export class ValidationFailedException extends ApiException {
  constructor(details: ApiErrorDetail[], message = 'The request could not be accepted.') {
    super(422, 'VALIDATION_FAILED', message, details);
  }
}

export class AuthenticationRequiredException extends ApiException {
  constructor(message = 'Authentication is required.') {
    super(401, 'AUTHENTICATION_REQUIRED', message);
  }
}

export class TokenInvalidException extends ApiException {
  constructor(message = 'The provided credential is invalid.') {
    super(401, 'TOKEN_INVALID', message);
  }
}

export class TokenExpiredException extends ApiException {
  constructor(message = 'The provided credential has expired.') {
    super(401, 'TOKEN_EXPIRED', message);
  }
}

export class ForbiddenActionException extends ApiException {
  constructor(message = 'You are not permitted to perform this action.') {
    super(403, 'FORBIDDEN', message);
  }
}

export class AccountRestrictedException extends ApiException {
  constructor(message = 'This account cannot perform this action.') {
    super(403, 'ACCOUNT_RESTRICTED', message);
  }
}

export class ResourceNotFoundException extends ApiException {
  constructor(message = 'The requested resource was not found.') {
    super(404, 'RESOURCE_NOT_FOUND', message);
  }
}

export class ConflictException extends ApiException {
  constructor(code = 'CONFLICT', message = 'The current state conflicts with this request.') {
    super(409, code, message);
  }
}

export class PolicyRejectedException extends ApiException {
  constructor(message: string) {
    super(422, 'POLICY_REJECTED', message);
  }
}

export class InvalidCursorException extends ApiException {
  constructor(message = 'The provided cursor is invalid or expired.') {
    super(400, 'INVALID_CURSOR', message);
  }
}
