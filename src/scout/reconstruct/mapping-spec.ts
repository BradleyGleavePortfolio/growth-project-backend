import { Prisma } from '@prisma/client';
import { isCanonicalPlatform } from '../scout-platform';
import { RECONSTRUCT_FAMILY } from '../scout-reconstruct.dto';

/**
 * S8-A (D-S8-1) — the data-only source mapping contract and its ONE generic
 * interpreter. A source's field meaning lives in a repository-resident JSON
 * `SourceMappingSpec` (`./sources/*.json`), never in per-source TypeScript: a new
 * source is a new JSON file, with zero core diff. The interpreter is pure and
 * total — every row yields either a canonical value or an explicit skip reason,
 * never a throw — so the engine's accounting stays exhaustive. Identity and the
 * skip reasons (`unsupported_platform:<token>`, `missing_source_id`) are core,
 * not data, and are byte-identical to the retired per-source mappers. Email and
 * billing are never mapped: the spec grammar has no field that could carry them.
 */

/** The staged row the interpreter consumes (a persisted ScoutIngestEntity). */
export interface StagedSourceRow {
  readonly source_id: string;
  readonly source_platform: string;
  readonly payload: Prisma.JsonValue;
}

/**
 * A staged client mapped to the fields needed to reconstruct an invite-pending
 * roster Person. Identity is the source platform id (`sourcePersonId`), never
 * email — D2 forbids email as a canonical or linking key.
 */
export interface MappedClient {
  readonly sourcePersonId: string;
  readonly sourcePlatform: string;
  readonly displayName: string | null;
}

/**
 * A staged non-person entity mapped to the PII-minimal fields of a canonical
 * `ScoutReconstructedEntity`. Identity is the opaque source_id the engine carries
 * as the external_ref key; `clientSourceId` is a soft provenance link and `label`
 * a best-effort display title.
 */
export interface MappedEntity {
  readonly sourcePlatform: string;
  readonly clientSourceId: string | null;
  readonly label: string | null;
}

/** Total-function result: either a mapped client or a skip with a reason. */
export type MapClientResult =
  | { readonly ok: true; readonly client: MappedClient }
  | { readonly ok: false; readonly reason: string };

/** Total-function result: either a mapped entity or a skip with a reason. */
export type MapEntityResult =
  | { readonly ok: true; readonly entity: MappedEntity }
  | { readonly ok: false; readonly reason: string };

/** A source step resolved to a canonical TGP family, or an explicit unresolved reason. */
export type StepResolution =
  | { readonly ok: true; readonly family: CanonicalFamily }
  | { readonly ok: false; readonly reason: string };

/** The closed canonical family allow-list the spec may target (TGP-owned, not data). */
export type CanonicalFamily = (typeof RECONSTRUCT_FAMILY)[keyof typeof RECONSTRUCT_FAMILY];

/** The person family; every other canonical family is a generic entity family. */
export const PERSON_FAMILY: CanonicalFamily = RECONSTRUCT_FAMILY.clients;

/** Every canonical family, in the allow-list's declaration order. */
export const CANONICAL_FAMILIES: readonly CanonicalFamily[] = Object.values(RECONSTRUCT_FAMILY);

/**
 * Typed coercion applied to the first non-nullish value found along a field's
 * paths. Both trim a string and null an empty/whitespace one; only
 * `string_or_finite_number` also stringifies a finite number. Anything else
 * (object, array, boolean, non-finite number, absent) is a soft null.
 */
export const FIELD_COERCIONS = ['string', 'string_or_finite_number'] as const;
export type FieldCoercion = (typeof FIELD_COERCIONS)[number];

/**
 * One canonical field rule. `paths` are tried in order and the FIRST value that
 * is neither null nor absent is coerced (`??` semantics — a present but unusable
 * value does not fall through to the next path). Each path is a list of own
 * object keys walked from the payload root; a non-object at any level is absent.
 */
export interface FieldRule {
  readonly paths: readonly (readonly string[])[];
  readonly coerce: FieldCoercion;
}

/** Field rules for the person family (`clients`). */
export interface PersonFieldRules {
  readonly displayName: FieldRule;
}

/** Field rules for a generic entity family (`workouts`, `client_history`). */
export interface EntityFieldRules {
  readonly clientSourceId: FieldRule;
  readonly label: FieldRule;
}

/**
 * The data-only mapping for one source platform. `steps` maps the source's own
 * step/entity tokens to a canonical TGP family; a token absent from `steps` is
 * `unresolved_family:<token>`, never silently dropped. `families` carries the
 * canonical field rules per family; a family absent there is likewise
 * `unresolved_family:<family>` for that source.
 *
 * Canonical identity is (platform, family, source_id), so two source steps that
 * feed ONE family must draw their ids from one id space or their records could
 * silently merge or collide. Such a fan-in is therefore rejected unless the spec
 * declares it in `sharedIdSpaces` (family → the exact set of steps sharing it).
 */
export interface SourceMappingSpec {
  readonly specVersion: 1;
  readonly sourcePlatform: string;
  readonly steps: Readonly<Record<string, CanonicalFamily>>;
  readonly families: {
    readonly clients?: PersonFieldRules;
    readonly workouts?: EntityFieldRules;
    readonly client_history?: EntityFieldRules;
    readonly programs?: EntityFieldRules;
  };
  readonly sharedIdSpaces?: Readonly<Partial<Record<CanonicalFamily, readonly string[]>>>;
}

const PERSON_FIELDS = ['displayName'] as const;
const ENTITY_FIELDS = ['clientSourceId', 'label'] as const;
const REQUIRED_SPEC_KEYS = ['specVersion', 'sourcePlatform', 'steps', 'families'] as const;
const SPEC_KEYS = [...REQUIRED_SPEC_KEYS, 'sharedIdSpaces'] as const;
const RULE_KEYS = ['paths', 'coerce'] as const;

/** The skip reason for a row whose platform no spec (or a different spec) owns. */
export function unsupportedPlatformReason(sourcePlatform: string): string {
  return `unsupported_platform:${sourcePlatform}`;
}

/** The reason for a source step or family the spec does not map to a canonical family. */
export function unresolvedFamilyReason(token: string): string {
  return `unresolved_family:${token}`;
}

/** Narrow an opaque JSON value to an indexable plain object, else null. */
function asObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Walk one path of own keys; a non-object level or a missing key is absent. */
function readPath(payload: Prisma.JsonValue, path: readonly string[]): unknown {
  let current: unknown = payload;
  for (const key of path) {
    const obj = asObject(current);
    if (obj === null || !Object.prototype.hasOwnProperty.call(obj, key)) return undefined;
    current = obj[key];
  }
  return current;
}

/** Apply one coercion to a raw value; every unusable shape is a soft null. */
function coerce(raw: unknown, coercion: FieldCoercion): string | null {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed.length === 0 ? null : trimmed;
  }
  if (coercion === 'string_or_finite_number' && typeof raw === 'number' && Number.isFinite(raw)) {
    return String(raw);
  }
  return null;
}

/** Read one canonical field from the opaque payload per its rule. Pure and total. */
export function readField(payload: Prisma.JsonValue, rule: FieldRule): string | null {
  let raw: unknown = undefined;
  for (const path of rule.paths) {
    raw = readPath(payload, path);
    if (raw !== null && raw !== undefined) break;
  }
  return coerce(raw, rule.coerce);
}

/**
 * The shared identity guard (core, not data): the row must belong to this spec's
 * platform and carry a non-blank source_id. The source_id is trimmed exactly
 * once, here; `clients` keys its Person on the trimmed id while generic entities
 * and the ledger keep the raw source_id — unchanged persisted behavior.
 */
function guardIdentity(
  spec: SourceMappingSpec,
  row: StagedSourceRow,
):
  | { readonly ok: true; readonly trimmedSourceId: string }
  | { readonly ok: false; readonly reason: string } {
  if (row.source_platform !== spec.sourcePlatform) {
    return { ok: false, reason: unsupportedPlatformReason(row.source_platform) };
  }
  const trimmedSourceId = row.source_id.trim();
  if (trimmedSourceId.length === 0) return { ok: false, reason: 'missing_source_id' };
  return { ok: true, trimmedSourceId };
}

/** Interpret a staged row of the person family (`clients`) under a spec. */
export function interpretClient(spec: SourceMappingSpec, row: StagedSourceRow): MapClientResult {
  const identity = guardIdentity(spec, row);
  if (!identity.ok) return identity;
  const rules = spec.families.clients;
  if (rules === undefined) return { ok: false, reason: unresolvedFamilyReason(PERSON_FAMILY) };
  return {
    ok: true,
    client: {
      sourcePersonId: identity.trimmedSourceId,
      sourcePlatform: row.source_platform,
      displayName: readField(row.payload, rules.displayName),
    },
  };
}

/** Interpret a staged row of a generic entity family under a spec. */
export function interpretEntity(
  spec: SourceMappingSpec,
  family: string,
  row: StagedSourceRow,
): MapEntityResult {
  const identity = guardIdentity(spec, row);
  if (!identity.ok) return identity;
  const rules = entityRules(spec, family);
  if (rules === undefined) return { ok: false, reason: unresolvedFamilyReason(family) };
  return {
    ok: true,
    entity: {
      sourcePlatform: row.source_platform,
      clientSourceId: readField(row.payload, rules.clientSourceId),
      label: readField(row.payload, rules.label),
    },
  };
}

/** The entity rules a spec declares for a family, or undefined (never the person family). */
function entityRules(spec: SourceMappingSpec, family: string): EntityFieldRules | undefined {
  if (family === RECONSTRUCT_FAMILY.workouts) return spec.families.workouts;
  if (family === RECONSTRUCT_FAMILY.client_history) return spec.families.client_history;
  if (family === RECONSTRUCT_FAMILY.programs) return spec.families.programs;
  return undefined;
}

/**
 * Resolve a source step/entity token to its canonical family under a spec. An
 * unmapped token (e.g. TrueCoach `notes`) is the explicit
 * `unresolved_family:<token>` — accounted for, never a silent absence.
 */
export function resolveStep(spec: SourceMappingSpec, step: string): StepResolution {
  if (Object.prototype.hasOwnProperty.call(spec.steps, step)) {
    const family = spec.steps[step];
    if (spec.families[family] !== undefined) return { ok: true, family };
  }
  return { ok: false, reason: unresolvedFamilyReason(step) };
}

// ---------------------------------------------------------------------------
// Strict spec validation. A spec is repository data loaded once at startup; any
// malformed spec is a loud load-time error (fail closed), never a silently
// degraded mapping at row time.
// ---------------------------------------------------------------------------

function invalid(origin: string, detail: string): Error {
  return new Error(`invalid source mapping spec (${origin}): ${detail}`);
}

function assertExactKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  origin: string,
  where: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw invalid(origin, `unknown key ${where}.${key}`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) {
      throw invalid(origin, `missing key ${where}.${key}`);
    }
  }
}

function isCanonicalFamily(value: unknown): value is CanonicalFamily {
  return typeof value === 'string' && (CANONICAL_FAMILIES as readonly string[]).includes(value);
}

function parseRule(raw: unknown, origin: string, where: string): FieldRule {
  const obj = asObject(raw);
  if (obj === null) throw invalid(origin, `${where} must be an object`);
  assertExactKeys(obj, RULE_KEYS, RULE_KEYS, origin, where);
  const { paths, coerce: coercion } = obj;
  if (!Array.isArray(paths) || paths.length === 0) {
    throw invalid(origin, `${where}.paths must be a non-empty array`);
  }
  const parsedPaths = paths.map((path, index) => {
    if (
      !Array.isArray(path) ||
      path.length === 0 ||
      path.some((key) => typeof key !== 'string' || key.length === 0)
    ) {
      throw invalid(origin, `${where}.paths[${index}] must be a non-empty array of keys`);
    }
    return Object.freeze([...(path as string[])]);
  });
  if (typeof coercion !== 'string' || !(FIELD_COERCIONS as readonly string[]).includes(coercion)) {
    throw invalid(origin, `${where}.coerce must be one of ${FIELD_COERCIONS.join('|')}`);
  }
  return Object.freeze({ paths: Object.freeze(parsedPaths), coerce: coercion as FieldCoercion });
}

function parseRules<K extends string>(
  raw: unknown,
  fields: readonly K[],
  origin: string,
  where: string,
): Readonly<Record<K, FieldRule>> {
  const obj = asObject(raw);
  if (obj === null) throw invalid(origin, `${where} must be an object`);
  assertExactKeys(obj, fields, fields, origin, where);
  const rules = {} as Record<K, FieldRule>;
  for (const field of fields) rules[field] = parseRule(obj[field], origin, `${where}.${field}`);
  return Object.freeze(rules);
}

/**
 * Validate an opaque JSON value as a `SourceMappingSpec`. Strict: unknown keys,
 * a non-canonical platform token, a step or family outside the canonical
 * allow-list, a step pointing at a family the spec does not map, or a malformed
 * rule all throw with the offending location.
 */
export function parseSourceMappingSpec(raw: unknown, origin: string): SourceMappingSpec {
  const obj = asObject(raw);
  if (obj === null) throw invalid(origin, 'spec must be an object');
  assertExactKeys(obj, SPEC_KEYS, REQUIRED_SPEC_KEYS, origin, 'spec');
  if (obj.specVersion !== 1) throw invalid(origin, 'specVersion must be 1');
  if (!isCanonicalPlatform(obj.sourcePlatform)) {
    throw invalid(origin, 'sourcePlatform must be a canonical platform token');
  }
  const sourcePlatform = obj.sourcePlatform;

  const familiesRaw = asObject(obj.families);
  if (familiesRaw === null) throw invalid(origin, 'families must be an object');
  const families: { -readonly [F in CanonicalFamily]?: PersonFieldRules | EntityFieldRules } = {};
  for (const family of Object.keys(familiesRaw)) {
    if (!isCanonicalFamily(family)) throw invalid(origin, `families.${family} is not canonical`);
    families[family] =
      family === PERSON_FAMILY
        ? parseRules(familiesRaw[family], PERSON_FIELDS, origin, `families.${family}`)
        : parseRules(familiesRaw[family], ENTITY_FIELDS, origin, `families.${family}`);
  }

  const stepsRaw = asObject(obj.steps);
  if (stepsRaw === null) throw invalid(origin, 'steps must be an object');
  const steps: Record<string, CanonicalFamily> = {};
  for (const [step, family] of Object.entries(stepsRaw)) {
    if (step.length === 0) throw invalid(origin, 'steps keys must be non-empty');
    if (!isCanonicalFamily(family)) throw invalid(origin, `steps.${step} is not canonical`);
    if (families[family] === undefined) {
      throw invalid(origin, `steps.${step} targets unmapped family ${family}`);
    }
    steps[step] = family;
  }

  const sharedIdSpaces = parseSharedIdSpaces(obj, steps, origin);

  return Object.freeze({
    specVersion: 1,
    sourcePlatform,
    steps: Object.freeze(steps),
    families: Object.freeze(families) as SourceMappingSpec['families'],
    ...(sharedIdSpaces === undefined ? {} : { sharedIdSpaces }),
  });
}

/**
 * Enforce one id space per canonical family: every family fed by two or more
 * steps must be declared in `sharedIdSpaces` with exactly that step set, and
 * every declaration must name such a fan-in (no stale or partial declarations).
 */
function parseSharedIdSpaces(
  obj: Record<string, unknown>,
  steps: Readonly<Record<string, CanonicalFamily>>,
  origin: string,
): SourceMappingSpec['sharedIdSpaces'] {
  const declared: Partial<Record<CanonicalFamily, readonly string[]>> = {};
  const hasDeclarations = Object.prototype.hasOwnProperty.call(obj, 'sharedIdSpaces');
  if (hasDeclarations) {
    const raw = asObject(obj.sharedIdSpaces);
    if (raw === null) throw invalid(origin, 'sharedIdSpaces must be an object');
    for (const [family, members] of Object.entries(raw)) {
      const where = `sharedIdSpaces.${family}`;
      if (!isCanonicalFamily(family)) throw invalid(origin, `${where} is not canonical`);
      if (
        !Array.isArray(members) ||
        members.some((step) => typeof step !== 'string' || step.length === 0) ||
        new Set(members).size !== members.length
      ) {
        throw invalid(origin, `${where} must be an array of distinct step tokens`);
      }
      declared[family] = Object.freeze([...(members as string[])].sort());
    }
  }

  const fanIn: Partial<Record<CanonicalFamily, string[]>> = {};
  for (const [step, family] of Object.entries(steps)) (fanIn[family] ??= []).push(step);

  for (const family of CANONICAL_FAMILIES) {
    const actual = [...(fanIn[family] ?? [])].sort();
    const shared = declared[family];
    if (actual.length < 2) {
      if (shared !== undefined) {
        throw invalid(origin, `sharedIdSpaces.${family} declares no multi-step fan-in`);
      }
      continue;
    }
    if (shared === undefined) {
      throw invalid(
        origin,
        `steps ${actual.join(', ')} all map to ${family} without a declared shared id space`,
      );
    }
    if (JSON.stringify(shared) !== JSON.stringify(actual)) {
      throw invalid(
        origin,
        `sharedIdSpaces.${family} must list exactly the steps mapping to it (${actual.join(', ')})`,
      );
    }
  }
  return hasDeclarations ? Object.freeze(declared) : undefined;
}
