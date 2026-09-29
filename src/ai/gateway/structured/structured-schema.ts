import { z } from 'zod';
import { JsonSchemaObject, StructuredValidation } from './structured-provider.types';
import { AiGatewayError } from './structured-ai.errors';

// L1-gw — OPTIONAL helper: derive the (responseSchema, validate) pair the gateway requires from a
// single zod object schema, so the JSON schema sent to the provider and the
// local validator can never drift apart.
//
// The JSON round-trip drops zod's non-JSON metadata (`~standard`, functions)
// and `$schema`, leaving a plain draft-2020-12 object schema the provider
// accepts as a tool `input_schema`.
export interface StructuredOutputContract<T> {
  responseSchema: JsonSchemaObject;
  validate: (raw: unknown) => StructuredValidation<T>;
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
    responseSchema: raw,
    validate: (v: unknown) => {
      const r = schema.safeParse(v);
      if (r.success) return { ok: true, value: r.data };
      // Paths and zod's fixed codes only — never the offending values.
      return {
        ok: false,
        errors: r.error.issues.map((i) => ({
          path: '$' + i.path.map((seg) => `.${String(seg)}`).join(''),
          detail: i.code,
        })),
      };
    },
  };
}
