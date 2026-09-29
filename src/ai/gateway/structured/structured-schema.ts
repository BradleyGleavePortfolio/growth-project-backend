import { z } from 'zod';
import { JsonSchemaObject } from './structured-provider.types';
import { AiGatewayError } from './structured-ai.errors';

// L1-gw — derive the (responseSchema, parse) pair the gateway requires from a
// single zod object schema, so the JSON schema sent to the provider and the
// local validator can never drift apart.
//
// The JSON round-trip drops zod's non-JSON metadata (`~standard`, functions)
// and `$schema`, leaving a plain draft-2020-12 object schema the provider
// accepts as a tool `input_schema`.
export interface StructuredOutputContract<T> {
  responseSchema: JsonSchemaObject;
  parse: (raw: unknown) => T;
}

export function structuredContractFromZod<S extends z.ZodType>(
  schema: S,
): StructuredOutputContract<z.infer<S>> {
  const raw: Record<string, unknown> = JSON.parse(JSON.stringify(z.toJSONSchema(schema)));
  delete raw['$schema'];
  delete raw['~standard'];
  if (raw.type !== 'object') {
    throw new AiGatewayError('ai_malformed_output', { reason: 'response-schema-must-be-object' });
  }
  return {
    responseSchema: raw as JsonSchemaObject,
    parse: (v: unknown) => schema.parse(v),
  };
}
