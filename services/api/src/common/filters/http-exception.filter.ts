import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ApiErrorDetail } from '../errors/api-exception';
import { RateLimitedException } from '../errors/rate-limited.exception';

interface NestValidationBody {
  message: string | string[];
  error?: string;
}

// Converts every thrown exception — ApiException, NestJS's own
// ValidationPipe BadRequestException, or an unexpected error — into the one
// canonical envelope from docs/05-api/api.md §6. Nothing else in the app
// should format an error response directly.
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = (request as Request & { requestId?: string }).requestId ?? 'unknown';

    if (exception instanceof RateLimitedException) {
      response.setHeader('Retry-After', String(exception.retryAfterSeconds));
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();

      if (typeof body === 'object' && body !== null && 'code' in body) {
        const typed = body as { code: string; message: string; details?: ApiErrorDetail[] };
        response.status(status).json({
          error: { code: typed.code, message: typed.message, details: typed.details, requestId },
        });
        return;
      }

      // NestJS's built-in ValidationPipe throws a plain BadRequestException
      // with { message: string[] } — normalize it to our shape instead of
      // leaking class-validator's raw constraint messages as-is.
      if (status === HttpStatus.BAD_REQUEST && typeof body === 'object' && body !== null) {
        const validationBody = body as NestValidationBody;
        const details = normalizeValidationMessages(validationBody.message);
        response.status(422).json({
          error: {
            code: 'VALIDATION_FAILED',
            message: 'The request could not be accepted.',
            details,
            requestId,
          },
        });
        return;
      }

      response.status(status).json({
        error: {
          code: httpStatusToGenericCode(status),
          message: typeof body === 'string' ? body : 'The request could not be completed.',
          requestId,
        },
      });
      return;
    }

    this.logger.error(exception instanceof Error ? exception.stack : exception);
    response.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', requestId },
    });
  }
}

function normalizeValidationMessages(message: string | string[]): ApiErrorDetail[] {
  const messages = Array.isArray(message) ? message : [message];
  return messages.map((m) => {
    const field = m.split(' ')[0] || 'body';
    return { field, reason: m };
  });
}

function httpStatusToGenericCode(status: number): string {
  switch (status) {
    case 401:
      return 'AUTHENTICATION_REQUIRED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'RESOURCE_NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 429:
      return 'RATE_LIMITED';
    default:
      return 'INVALID_REQUEST';
  }
}
