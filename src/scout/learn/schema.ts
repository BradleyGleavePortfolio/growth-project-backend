import { asObject, utf8Bytes } from './digest-contract';

/**
 * L1 (D-L0-7.1 part 3, D-L0-7.2 "Output constraint") — a small, closed JSON Schema subset. The
 * proposal grammar is written ONCE as a schema (`proposal.ts`); the same object is printed in
 * the prompt, passed to the provider as the structured-output constraint, and interpreted here
 * for V-L1 (strict keys, bounds, enums, patterns). No drift is possible between the three uses.
 * Total: `validateSchema` never throws; it returns fixed-detail refusals with JSON-pointer paths.
 */

export type JsonSchema =
  | { readonly type: 'null' }
  | { readonly type: 'boolean' }
  | {
      readonly type: 'integer' | 'number';
      readonly minimum?: number;
      readonly maximum?: number;
    }
  | {
      readonly type: 'string';
      readonly minLength?: number;
      readonly maxLength?: number;
      readonly pattern?: string;
      readonly enum?: readonly string[];
      readonly const?: string;
    }
  | {
      readonly type: 'array';
      readonly items: JsonSchema;
      readonly minItems?: number;
      readonly maxItems?: number;
      readonly uniqueItems?: boolean;
    }
  | {
      readonly type: 'object';
      readonly properties?: Readonly<Record<string, JsonSchema>>;
      readonly required?: readonly string[];
      readonly additionalProperties?: false | JsonSchema;
      readonly propertyNames?: { readonly pattern: string; readonly maxLength?: number };
      readonly minProperties?: number;
      readonly maxProperties?: number;
      readonly description?: string;
    }
  | { readonly anyOf: readonly JsonSchema[] }
  | { readonly const: number };

export interface SchemaError {
  readonly path: string;
  readonly detail: string;
}

/** Bounded string check: JS length for `maxLength`, plus a hard 4 KiB byte ceiling on any string. */
const STRING_HARD_MAX_BYTES = 4096;

function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isSafeInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function kindConst(schema: JsonSchema): string | undefined {
  if (!('type' in schema) || schema.type !== 'object') return undefined;
  const kind = schema.properties?.kind;
  return kind !== undefined && 'type' in kind && kind.type === 'string' ? kind.const : undefined;
}

function kindOf(value: unknown): string | undefined {
  const obj = asObject(value);
  return obj !== null && typeof obj.kind === 'string' ? obj.kind : undefined;
}

function pushError(out: SchemaError[], path: string, detail: string): void {
  if (out.length < 64) out.push({ path, detail });
}

function validateNode(schema: JsonSchema, value: unknown, path: string, out: SchemaError[]): void {
  if ('anyOf' in schema) {
    for (const option of schema.anyOf) {
      const trial: SchemaError[] = [];
      validateNode(option, value, path, trial);
      if (trial.length === 0) return;
    }
    // Report the single applicable option's errors when the value's type (and `kind`
    // discriminator) select exactly one; otherwise the generic refusal.
    const candidates = schema.anyOf.filter((o) => 'type' in o && o.type === jsonType(value));
    const discriminated =
      candidates.length > 1 ? candidates.filter((o) => kindConst(o) === kindOf(value)) : candidates;
    if (discriminated.length === 1) validateNode(discriminated[0], value, path, out);
    else pushError(out, path, 'matches none of the allowed forms');
    return;
  }
  if (!('type' in schema)) {
    if (value !== schema.const) pushError(out, path, `must be ${String(schema.const)}`);
    return;
  }
  switch (schema.type) {
    case 'null':
      if (value !== null) pushError(out, path, 'must be null');
      return;
    case 'boolean':
      if (typeof value !== 'boolean') pushError(out, path, 'must be a boolean');
      return;
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        pushError(out, path, 'must be a finite number');
        return;
      }
      if (schema.type === 'integer' && !Number.isSafeInteger(value)) {
        pushError(out, path, 'must be an integer');
        return;
      }
      if (schema.minimum !== undefined && value < schema.minimum)
        pushError(out, path, `must be at least ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum)
        pushError(out, path, `must be at most ${schema.maximum}`);
      return;
    }
    case 'string': {
      if (typeof value !== 'string') {
        pushError(out, path, 'must be a string');
        return;
      }
      if (utf8Bytes(value) > STRING_HARD_MAX_BYTES) {
        pushError(out, path, 'string over the hard byte ceiling');
        return;
      }
      if (schema.const !== undefined && value !== schema.const)
        pushError(out, path, `must be "${schema.const}"`);
      if (schema.enum !== undefined && !schema.enum.includes(value))
        pushError(out, path, 'must be one of the closed enum');
      if (schema.minLength !== undefined && value.length < schema.minLength)
        pushError(out, path, `shorter than ${schema.minLength}`);
      if (schema.maxLength !== undefined && value.length > schema.maxLength)
        pushError(out, path, `longer than ${schema.maxLength}`);
      if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value))
        pushError(out, path, 'does not match the required pattern');
      return;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        pushError(out, path, 'must be an array');
        return;
      }
      if (schema.minItems !== undefined && value.length < schema.minItems)
        pushError(out, path, `fewer than ${schema.minItems} items`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        pushError(out, path, `more than ${schema.maxItems} items`);
        return;
      }
      if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length)
        pushError(out, path, 'items must be unique');
      value.forEach((item, i) => validateNode(schema.items, item, `${path}[${i}]`, out));
      return;
    }
    case 'object': {
      const obj = asObject(value);
      if (obj === null) {
        pushError(out, path, 'must be an object');
        return;
      }
      const keys = Object.keys(obj);
      if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) {
        pushError(out, path, `more than ${schema.maxProperties} keys`);
        return;
      }
      if (schema.minProperties !== undefined && keys.length < schema.minProperties)
        pushError(out, path, `fewer than ${schema.minProperties} keys`);
      const properties = schema.properties ?? {};
      for (const key of schema.required ?? []) {
        if (!Object.prototype.hasOwnProperty.call(obj, key))
          pushError(out, `${path}.${key}`, 'missing key');
      }
      for (const key of keys) {
        const at = `${path}.${key}`;
        if (schema.propertyNames !== undefined) {
          if (
            !new RegExp(schema.propertyNames.pattern, 'u').test(key) ||
            (schema.propertyNames.maxLength !== undefined &&
              key.length > schema.propertyNames.maxLength)
          ) {
            pushError(out, at, 'key outside the allowed key grammar');
            continue;
          }
        }
        if (Object.prototype.hasOwnProperty.call(properties, key)) {
          validateNode(properties[key], obj[key], at, out);
        } else if (
          schema.additionalProperties === false ||
          schema.additionalProperties === undefined
        ) {
          pushError(out, at, 'unknown key');
        } else {
          validateNode(schema.additionalProperties, obj[key], at, out);
        }
      }
      return;
    }
  }
}

/** Validate `value` against `schema`. Unknown keys are refused unless the schema allows them. */
export function validateSchema(schema: JsonSchema, value: unknown, root = '$'): SchemaError[] {
  const out: SchemaError[] = [];
  validateNode(schema, value, root, out);
  return out;
}

/**
 * The schema with a title, as handed to the provider; the SAME object is validated here. No
 * `$schema` URL: the prompt's instruction parts carry no URL at all (tested), and the providers'
 * structured-output constraint does not need one.
 */
export function withTitle(schema: JsonSchema, title: string): Record<string, unknown> {
  return { title, ...schema };
}
