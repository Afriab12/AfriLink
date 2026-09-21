import { describe, it, expect } from 'vitest';
import type { ArgumentMetadata } from '@nestjs/common';
import { ParseUuidPipe } from './parse-uuid.pipe';
import { ValidationFailedException } from '../errors/api-exception';

const param = (name?: string): ArgumentMetadata => ({ type: 'param', data: name });

describe('ParseUuidPipe', () => {
  const pipe = new ParseUuidPipe();

  it.each([
    ['a v4 UUID', '9b2e2bd0-5f0c-4c1e-8f4e-2f3a5a8f7c11'],
    ['a v7 UUID', '018f4a6e-7b3c-7d2e-9a41-5c8e2f1b0a37'],
    ['an upper-case UUID', '9B2E2BD0-5F0C-4C1E-8F4E-2F3A5A8F7C11'],
    ['the nil UUID', '00000000-0000-0000-0000-000000000000'],
  ])('returns %s unchanged', (_name, value) => {
    expect(pipe.transform(value, param('postId'))).toBe(value);
  });

  it.each([
    ['plain text', 'not-a-uuid'],
    ['a number', '12345'],
    ['an empty string', ''],
    ['one character short', '9b2e2bd0-5f0c-4c1e-8f4e-2f3a5a8f7c1'],
    ['one character long', '9b2e2bd0-5f0c-4c1e-8f4e-2f3a5a8f7c111'],
    ['a non-hex character', 'zb2e2bd0-5f0c-4c1e-8f4e-2f3a5a8f7c11'],
    ['a SQL fragment', "1' OR '1'='1"],
    ['surrounding whitespace', ' 9b2e2bd0-5f0c-4c1e-8f4e-2f3a5a8f7c11 '],
  ])('rejects %s with the canonical 422', (_name, value) => {
    let thrown: unknown;
    try {
      pipe.transform(value, param('postId'));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ValidationFailedException);
    const exception = thrown as ValidationFailedException;
    expect(exception.getStatus()).toBe(422);
    expect(exception.getResponse()).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ field: 'postId', reason: 'postId must be a UUID' }],
    });
  });

  it("names the field after the route parameter, and never echoes the offending value", () => {
    let thrown: ValidationFailedException | undefined;
    try {
      pipe.transform('secret-looking-input', param('friendshipId'));
    } catch (error) {
      thrown = error as ValidationFailedException;
    }
    const body = JSON.stringify(thrown?.getResponse());
    expect(body).toContain('friendshipId must be a UUID');
    expect(body).not.toContain('secret-looking-input');
  });

  it('falls back to the field "id" when the parameter has no name', () => {
    expect(() => pipe.transform('nope', { type: 'param' })).toThrow(ValidationFailedException);
    try {
      pipe.transform('nope', { type: 'param' });
    } catch (error) {
      expect((error as ValidationFailedException).getResponse()).toMatchObject({ details: [{ field: 'id' }] });
    }
  });
});
