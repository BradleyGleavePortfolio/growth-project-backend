import { getSchemaPath } from '@nestjs/swagger';
import { ErrorEnvelope, RateLimitError } from './error-envelope.dto';

// Shared @ApiResponse `schema` builders for the importer surface (R80). Every
// importer 4xx/5xx points at one of these so the frozen contract references the
// two truthful error schemas (ErrorEnvelope / RateLimitError) instead of a
// per-route shape. The extractor deep-sorts keys, so the object-literal key
// order here does not affect the deterministic artifact.

type SchemaLike = Record<string, unknown>;

/** A plain reference to the standard HttpExceptionFilter envelope. */
export function errorEnvelopeSchema(): SchemaLike {
  return { $ref: getSchemaPath(ErrorEnvelope) };
}

/** A reference to the distinct 429 throttler body. */
export function rateLimitSchema(): SchemaLike {
  return { $ref: getSchemaPath(RateLimitError) };
}

/**
 * The standard envelope narrowed so its `code` is pinned to a fixed enum.
 * `required: true` (default) asserts `code` is always present (a domain
 * exception that sets it); `required: false` pins the enum only WHEN present,
 * for a status whose body may also arrive without a code (e.g. a redeem 400 that
 * can come from either the domain `invalid` path or a code-less ValidationPipe
 * array).
 */
export function envelopeWithCode(
  codes: readonly string[],
  opts: { required?: boolean } = {},
): SchemaLike {
  const required = opts.required !== false;
  const codeConstraint: SchemaLike = {
    type: 'object',
    properties: { code: { type: 'string', enum: [...codes] } },
  };
  if (required) codeConstraint.required = ['code'];
  return { allOf: [{ $ref: getSchemaPath(ErrorEnvelope) }, codeConstraint] };
}
