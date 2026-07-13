import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// R80 truthful error modeling. These classes are the OpenAPI mirror of the two
// error bodies the importer surface can actually receive at runtime — NOT a
// bespoke per-route `{ code, message }` shape. Modeling the real envelope keeps
// the frozen contract honest: a generated client sees exactly the fields the
// server emits (statusCode/error/timestamp/path/…), not a subset that would
// make request(err).data.statusCode look absent when it is always present.
//
// ErrorEnvelope   ← src/filters/not-found-envelope.ts buildErrorEnvelope()
//                   (emitted by the global HttpExceptionFilter for every 4xx/5xx
//                   except throttling, and by the R-DARK-1 feature-flag 404).
// RateLimitError  ← src/filters/throttler-exception.filter.ts (the 429 body has
//                   a DIFFERENT shape — retryAfter, no timestamp/path — so it is
//                   a distinct schema rather than a lie folded into ErrorEnvelope).

/**
 * The structured JSON body emitted by HttpExceptionFilter for every handled
 * exception (4xx/5xx) other than a throttle rejection. Field presence mirrors
 * buildErrorEnvelope() exactly: `code` and `request_id` are optional (present
 * only when the thrown exception carried a machine-readable code and when
 * RequestIdMiddleware assigned a correlation id, respectively); everything else
 * is always present.
 */
export class ErrorEnvelope {
  @ApiProperty({ description: 'HTTP status code, echoed in the body.', example: 400 })
  statusCode!: number;

  @ApiPropertyOptional({
    description:
      'Machine-readable failure discriminant, present only when the handler set ' +
      'one (e.g. `extension_refresh_invalid`, `invalid`). Absent for generic ' +
      'validation/guard errors.',
    example: 'invalid',
  })
  code?: string;

  @ApiProperty({
    description:
      'Human-readable message. A single string for most errors; an array of ' +
      'strings when the global ValidationPipe reports one entry per failed ' +
      'constraint.',
    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
    example: 'Invalid pairing code.',
  })
  message!: string | string[];

  @ApiProperty({
    description: 'Short error class name (Nest default), e.g. `Bad Request`, `Unauthorized`.',
    example: 'Bad Request',
  })
  error!: string;

  @ApiProperty({
    description: 'ISO-8601 instant the error envelope was built.',
    format: 'date-time',
    example: '2026-07-13T18:30:00.000Z',
  })
  timestamp!: string;

  @ApiProperty({ description: 'Request path the error occurred on.', example: '/api/scout/ingest' })
  path!: string;

  @ApiPropertyOptional({
    description: 'Correlation id from RequestIdMiddleware; omitted when absent.',
    example: '5f2c9b1e-6d3a-4c8b-9f0e-1a2b3c4d5e6f',
  })
  request_id?: string;
}

/**
 * The 429 Too Many Requests body emitted by ThrottlerExceptionFilter. It does
 * NOT flow through buildErrorEnvelope, so it carries `retryAfter` (matching the
 * `Retry-After` header) and deliberately omits timestamp/path/code/request_id.
 * Kept a separate schema so the contract does not misrepresent the 429 shape as
 * an ErrorEnvelope.
 */
export class RateLimitError {
  @ApiProperty({ description: 'Always 429.', example: 429 })
  statusCode!: number;

  @ApiProperty({ description: 'Always `Too Many Requests`.', example: 'Too Many Requests' })
  error!: string;

  @ApiProperty({
    description: 'Generic backoff message (never echoes input or which limit fired).',
    example: 'Too many attempts. Please wait before trying again.',
  })
  message!: string;

  @ApiProperty({
    description: 'Seconds to wait before retrying; matches the `Retry-After` header.',
    example: 3600,
  })
  retryAfter!: number;
}
