import {
  FIELD_COERCIONS,
  CANONICAL_FAMILIES,
  PERSON_FAMILY,
  parseSourceMappingSpec,
  type CanonicalFamily,
  type FieldRule,
  type SourceMappingSpec,
} from '../reconstruct/mapping-spec';
import {
  parseNativeRuleSet,
  type NativeRule,
  type NativeRuleSet,
  type RuleKind,
} from '../reconstruct/native/native-rules';
import { WORKOUT_PLAN_TYPES } from '../reconstruct/native/native-contract';
import type { InductionManifestV1, ProvingBasisKind } from '../induction/contract';
import { parseInductionManifest } from '../induction/parse';
import { buildInductionRegistry } from '../induction/manifest-registry';
import {
  CONTACT_CLASSES,
  DIGIT_RUN_PATTERN,
  Errors,
  ID_CLASSES,
  asObject,
  itemShapeAt,
  shapeAtPath,
  templateParamCount,
  type DigestTemplate,
  type LearnParseResult,
  type ShapeNode,
  type StructureDigestV1,
} from './digest-contract';
import { KEY_IDENTIFIER_PATTERN, KEY_MAX_BYTES } from './admission';
import {
  ENTITY_FIELD_DESCRIPTIONS,
  EXERCISE_NATIVE_FIELDS,
  PERSON_FIELD_DESCRIPTIONS,
  PROGRAM_NATIVE_FIELDS,
  WORKOUT_NATIVE_FIELDS,
  type NativeFieldDescription,
} from './canonical-contract';
import { templateKey } from './fingerprint';
import { validateSchema, type JsonSchema } from './schema';

/**
 * L1 (D-L0-4) — the `LearnedProposalV1` grammar (data only), its strict parser V-L1 and the
 * validators V-L2…V-L8 and V-L10 that must accept before any source request. The grammar is
 * written ONCE as a JSON Schema (`proposalJsonSchema()`), generated from the same canonical
 * tables the validators iterate; V-L1 interprets that schema, the prompt prints it, the provider
 * enforces it. `mappingSpec` and `nativeRules` are re-parsed by the landed interpreters
 * (`parseSourceMappingSpec`, `parseNativeRuleSet`) — never reimplemented — and the derived
 * `InductionManifestV1` must pass S10 V1-V6 in `buildInductionRegistry`.
 */

export const PROPOSAL_VERSION = 1 as const;
export const PROPOSAL_MAX_STEPS = 8;
export const PROPOSAL_MAX_EXPLORE = 8;
export const PROPOSAL_MAX_RATIONALE_CHARS = 512;
export const PROPOSAL_MAX_PATHS_PER_RULE = 4;
export const PROPOSAL_MAX_PATH_DEPTH = 4;

export const UNMAPPED_REASONS = [
  'out_of_scope_billing',
  'out_of_scope_account_settings',
  'out_of_scope_ui_config',
  'unsupported_coaching_data',
  'unknown',
] as const;
export type UnmappedReason = (typeof UNMAPPED_REASONS)[number];
export const PAGINATION_STYLES = ['page', 'cursor'] as const;
export type PaginationStyle = (typeof PAGINATION_STYLES)[number];

/**
 * Divergence from r3 D-L0-4 (flagged, not silent): r3 names the id classes `int_id|uuid|short_id`
 * (string classes only). The legacy oracle and the shared X2 vectors carry `{kind:'number',
 * class:'int'}` ids, so a literal reading makes V1-P item 6 (oracle parity) unreachable. An
 * integer NUMBER node is therefore accepted as an id field as well; flip this to `false` if r4
 * keeps the literal rule.
 */
export const ACCEPT_INTEGER_NUMBER_ID_FIELD = true;

export interface ProposalPagination {
  readonly style: PaginationStyle;
  readonly param: string;
  readonly start?: number;
  readonly nextPath?: readonly string[];
}

export interface ProposalStep {
  readonly templateRef: string;
  readonly entityType: string;
  readonly itemsPath: readonly string[];
  readonly idField: string;
  readonly collectAs?: string;
  readonly forEach?: string;
  readonly pagination: ProposalPagination | null;
}

export interface ProposalUnmapped {
  readonly templateRef: string;
  readonly reason: UnmappedReason;
}

export interface LearnedProposalV1 {
  readonly proposalVersion: typeof PROPOSAL_VERSION;
  readonly steps: readonly ProposalStep[];
  readonly mappingSpec: SourceMappingSpec;
  readonly nativeRules: NativeRuleSet | null;
  readonly unmapped: readonly ProposalUnmapped[];
  readonly explore: readonly string[];
  readonly rationale: string;
}

// ── Grammar as schema ─────────────────────────────────────────────────────────────────────

const TOKEN_PATTERN = '^[a-z][a-z0-9_]{0,63}$';
const KEY_PATTERN = KEY_IDENTIFIER_PATTERN.source;
const TEMPLATE_REF = '^t(0|[1-9][0-9]?)$';
const LINK_REF = '^l(0|[1-9][0-9]?)$';
const SLUG_PATTERN = '^[a-z0-9][a-z0-9._:-]{0,255}$';
/** Printable text: no control or format characters, no `@`, no scheme separator, no digit run. */
const RATIONALE_PATTERN = '^(?!.*(://|@|[0-9]{4}))[^\\p{Cc}\\p{Cf}]*$';
/** A model-invented source enum value or flag marker: short ASCII, never a digit run. */
const SOURCE_VALUE_PATTERN = '^(?![0-9]{4})(?!.*[0-9]{4})[A-Za-z0-9 _-]{1,32}$';

const keyString: JsonSchema = { type: 'string', pattern: KEY_PATTERN, maxLength: KEY_MAX_BYTES };
const keyPath: JsonSchema = {
  type: 'array',
  items: keyString,
  minItems: 1,
  maxItems: PROPOSAL_MAX_PATH_DEPTH,
};
const paths: JsonSchema = {
  type: 'array',
  items: keyPath,
  minItems: 1,
  maxItems: PROPOSAL_MAX_PATHS_PER_RULE,
  uniqueItems: true,
};
const token: JsonSchema = { type: 'string', pattern: TOKEN_PATTERN, maxLength: 64 };

function fieldRuleSchema(): JsonSchema {
  return {
    type: 'object',
    required: ['paths', 'coerce'],
    additionalProperties: false,
    properties: { paths, coerce: { type: 'string', enum: FIELD_COERCIONS } },
  };
}

function fieldsSchema(fields: Readonly<Record<string, unknown>>): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  for (const field of Object.keys(fields)) properties[field] = fieldRuleSchema();
  return {
    type: 'object',
    required: Object.keys(fields),
    additionalProperties: false,
    properties,
  };
}

function mappingSpecSchema(): JsonSchema {
  const families: Record<string, JsonSchema> = {};
  const shared: Record<string, JsonSchema> = {};
  for (const family of CANONICAL_FAMILIES) {
    families[family] = fieldsSchema(
      family === PERSON_FAMILY ? PERSON_FIELD_DESCRIPTIONS : ENTITY_FIELD_DESCRIPTIONS,
    );
    shared[family] = { type: 'array', items: token, minItems: 2, maxItems: PROPOSAL_MAX_STEPS };
  }
  return {
    type: 'object',
    required: ['specVersion', 'sourcePlatform', 'steps', 'families'],
    additionalProperties: false,
    properties: {
      specVersion: { const: 1 },
      sourcePlatform: { type: 'string', pattern: SLUG_PATTERN },
      steps: {
        type: 'object',
        propertyNames: { pattern: TOKEN_PATTERN, maxLength: 64 },
        additionalProperties: { type: 'string', enum: CANONICAL_FAMILIES },
        minProperties: 1,
        maxProperties: PROPOSAL_MAX_STEPS,
      },
      families: {
        type: 'object',
        additionalProperties: false,
        properties: families,
        minProperties: 1,
      },
      sharedIdSpaces: { type: 'object', additionalProperties: false, properties: shared },
    },
  };
}

function nativeRuleSchema(kinds: readonly RuleKind[]): JsonSchema {
  const options: JsonSchema[] = kinds.map((kind): JsonSchema => {
    const base = { type: 'object' as const, additionalProperties: false as const };
    const kindProp: JsonSchema = { type: 'string', const: kind };
    switch (kind) {
      case 'integer':
        return {
          ...base,
          required: ['kind', 'paths'],
          properties: {
            kind: kindProp,
            paths,
            base: { type: 'integer', minimum: 0, maximum: 1 },
            default: { type: 'integer', minimum: -999, maximum: 999 },
          },
        };
      case 'enum':
        return {
          ...base,
          required: ['kind', 'paths', 'map'],
          properties: {
            kind: kindProp,
            paths,
            map: {
              type: 'object',
              propertyNames: { pattern: SOURCE_VALUE_PATTERN, maxLength: 32 },
              additionalProperties: { type: 'string', enum: WORKOUT_PLAN_TYPES },
              minProperties: 1,
              maxProperties: 16,
            },
            default: { type: 'string', enum: WORKOUT_PLAN_TYPES },
          },
        };
      case 'flag':
        return {
          ...base,
          required: ['kind', 'paths', 'truthy'],
          properties: {
            kind: kindProp,
            paths,
            truthy: {
              type: 'array',
              minItems: 1,
              maxItems: 8,
              items: {
                anyOf: [
                  { type: 'string', pattern: SOURCE_VALUE_PATTERN, maxLength: 32 },
                  { type: 'integer', minimum: -999, maximum: 999 },
                  { type: 'boolean' },
                ],
              },
            },
          },
        };
      case 'duration':
        return {
          ...base,
          required: ['kind', 'paths', 'unit'],
          properties: {
            kind: kindProp,
            paths,
            unit: { type: 'string', enum: ['seconds', 'minutes'] },
          },
        };
      case 'weight':
        return {
          ...base,
          required: ['kind', 'paths', 'unit'],
          properties: { kind: kindProp, paths, unit: { type: 'string', enum: ['lb', 'kg'] } },
        };
      default:
        return { ...base, required: ['kind', 'paths'], properties: { kind: kindProp, paths } };
    }
  });
  return options.length === 1 ? options[0] : { anyOf: options };
}

function nativeFieldsSchema(
  fields: Readonly<Record<string, NativeFieldDescription>>,
  extra: Record<string, JsonSchema> = {},
): JsonSchema {
  const properties: Record<string, JsonSchema> = { ...extra };
  for (const [field, meta] of Object.entries(fields))
    properties[field] = nativeRuleSchema(meta.kinds);
  return { type: 'object', additionalProperties: false, properties };
}

function nativeRulesSchema(): JsonSchema {
  return {
    anyOf: [
      { type: 'null' },
      {
        type: 'object',
        required: ['specVersion', 'sourcePlatform', 'families'],
        additionalProperties: false,
        properties: {
          specVersion: { const: 1 },
          sourcePlatform: { type: 'string', pattern: SLUG_PATTERN },
          families: {
            type: 'object',
            additionalProperties: false,
            properties: {
              programs: nativeFieldsSchema(PROGRAM_NATIVE_FIELDS),
              workouts: nativeFieldsSchema(WORKOUT_NATIVE_FIELDS, {
                exercises: {
                  type: 'object',
                  required: ['paths', 'item'],
                  additionalProperties: false,
                  properties: { paths, item: nativeFieldsSchema(EXERCISE_NATIVE_FIELDS) },
                },
              }),
            },
          },
        },
      },
    ],
  };
}

/** The ONE `LearnedProposalV1` schema: printed in the prompt, sent to the provider, run by V-L1. */
export function proposalJsonSchema(): JsonSchema {
  return {
    type: 'object',
    required: [
      'proposalVersion',
      'steps',
      'mappingSpec',
      'nativeRules',
      'unmapped',
      'explore',
      'rationale',
    ],
    additionalProperties: false,
    properties: {
      proposalVersion: { const: PROPOSAL_VERSION },
      steps: {
        type: 'array',
        maxItems: PROPOSAL_MAX_STEPS,
        items: {
          type: 'object',
          required: ['templateRef', 'entityType', 'itemsPath', 'idField', 'pagination'],
          additionalProperties: false,
          properties: {
            templateRef: { type: 'string', pattern: TEMPLATE_REF },
            entityType: token,
            itemsPath: { type: 'array', items: keyString, maxItems: PROPOSAL_MAX_PATH_DEPTH },
            idField: keyString,
            collectAs: token,
            forEach: token,
            pagination: {
              anyOf: [
                { type: 'null' },
                {
                  type: 'object',
                  required: ['style', 'param'],
                  additionalProperties: false,
                  properties: {
                    style: { type: 'string', enum: PAGINATION_STYLES },
                    param: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_.[\\]-]{0,63}$' },
                    start: { type: 'integer', minimum: 0, maximum: 1 },
                    nextPath: keyPath,
                  },
                },
              ],
            },
          },
        },
      },
      mappingSpec: mappingSpecSchema(),
      nativeRules: nativeRulesSchema(),
      unmapped: {
        type: 'array',
        maxItems: 64,
        items: {
          type: 'object',
          required: ['templateRef', 'reason'],
          additionalProperties: false,
          properties: {
            templateRef: { type: 'string', pattern: TEMPLATE_REF },
            reason: { type: 'string', enum: UNMAPPED_REASONS },
          },
        },
      },
      explore: {
        type: 'array',
        maxItems: PROPOSAL_MAX_EXPLORE,
        uniqueItems: true,
        items: { type: 'string', pattern: LINK_REF },
      },
      rationale: {
        type: 'string',
        maxLength: PROPOSAL_MAX_RATIONALE_CHARS,
        pattern: RATIONALE_PATTERN,
      },
    },
  };
}

// ── V-L1 ──────────────────────────────────────────────────────────────────────────────────

/** Every string anywhere in the reply: no scheme, no `@`, no digit run, no control/format char. */
function scanStrings(value: unknown, path: string, errors: Errors): void {
  if (typeof value === 'string') {
    if (/:\/\//.test(value) || /^[a-z][a-z0-9+.-]*:/i.test(value))
      errors.add(path, 'string parses as a URL or scheme');
    if (value.includes('@')) errors.add(path, 'value-like character in string');
    if (DIGIT_RUN_PATTERN.test(value)) errors.add(path, 'digit run of 4 or more in string');
    if (/[\p{Cc}\p{Cf}]/u.test(value)) errors.add(path, 'control or format character in string');
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => scanStrings(v, `${path}[${i}]`, errors));
    return;
  }
  const obj = asObject(value);
  if (obj !== null)
    for (const [k, v] of Object.entries(obj)) scanStrings(v, `${path}.${k}`, errors);
}

/**
 * V-L1: JSON only (the caller hands over a parsed value or `undefined` for non-JSON), strict keys
 * at every level, closed enums, bounds and patterns per the generated schema, plus the string
 * scan above. The `mappingSpec`/`nativeRules` subtrees are shape-checked here and re-parsed by
 * the landed interpreters in V-L2/V-L3.
 */
export function parseLearnedProposal(raw: unknown): LearnParseResult<LearnedProposalV1> {
  const errors = new Errors('V-L1');
  if (raw === undefined) {
    errors.add('', 'reply is not JSON');
    return { ok: false, errors: errors.list };
  }
  for (const e of validateSchema(proposalJsonSchema(), raw)) errors.add(e.path, e.detail);
  scanStrings(raw, '$', errors);
  if (errors.any) return { ok: false, errors: errors.list };
  const obj = raw as Record<string, unknown>;
  const steps = (obj.steps as Record<string, unknown>[]).map((s) =>
    Object.freeze({
      templateRef: s.templateRef as string,
      entityType: s.entityType as string,
      itemsPath: Object.freeze([...(s.itemsPath as string[])]),
      idField: s.idField as string,
      ...(s.collectAs === undefined ? {} : { collectAs: s.collectAs as string }),
      ...(s.forEach === undefined ? {} : { forEach: s.forEach as string }),
      pagination:
        s.pagination === null
          ? null
          : Object.freeze({
              style: (s.pagination as ProposalPagination).style,
              param: (s.pagination as ProposalPagination).param,
              ...((s.pagination as ProposalPagination).start === undefined
                ? {}
                : { start: (s.pagination as ProposalPagination).start }),
              ...((s.pagination as ProposalPagination).nextPath === undefined
                ? {}
                : { nextPath: Object.freeze([...(s.pagination as ProposalPagination).nextPath!]) }),
            }),
    }),
  );
  return {
    ok: true,
    value: Object.freeze({
      proposalVersion: PROPOSAL_VERSION,
      steps: Object.freeze(steps),
      // Shape-checked above; re-parsed (and frozen) by V-L2/V-L3 before any use.
      mappingSpec: obj.mappingSpec as SourceMappingSpec,
      nativeRules: obj.nativeRules as NativeRuleSet | null,
      unmapped: Object.freeze(
        (obj.unmapped as ProposalUnmapped[]).map((u) =>
          Object.freeze({ templateRef: u.templateRef, reason: u.reason }),
        ),
      ),
      explore: Object.freeze([...(obj.explore as string[])]),
      rationale: obj.rationale as string,
    }),
  };
}

// ── V-L2 … V-L8, V-L10 ────────────────────────────────────────────────────────────────────

export interface ProposalValidationContext {
  /** The run's slug (D-L0-5); the digest, the spec and the rules must all carry it. */
  readonly slug: string;
  /** Round 2 (D-L0-3): template keys of the round-1 package's steps, each must still be a step. */
  readonly round1StepKeys?: readonly string[];
}

export interface ValidatedStep {
  readonly step: ProposalStep;
  readonly template: DigestTemplate;
  readonly templateKey: string;
  readonly family: CanonicalFamily;
  readonly itemShape: ShapeNode & { readonly kind: 'object' };
}

export interface ValidatedProposal {
  readonly proposal: LearnedProposalV1;
  readonly digest: StructureDigestV1;
  readonly mappingSpec: SourceMappingSpec;
  readonly nativeRules: NativeRuleSet | null;
  readonly manifest: InductionManifestV1;
  readonly steps: readonly ValidatedStep[];
  readonly unmapped: readonly { readonly templateKey: string; readonly reason: UnmappedReason }[];
}

function isIdShape(node: ShapeNode): boolean {
  if (node.kind === 'string') return ID_CLASSES.includes(node.class);
  return ACCEPT_INTEGER_NUMBER_ID_FIELD && node.kind === 'number' && node.class === 'int';
}

function isContactShape(node: ShapeNode): boolean {
  return node.kind === 'string' && CONTACT_CLASSES.includes(node.class);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : 'parse error';
}

/**
 * D-L0-4: the manifest is DERIVED by the server, never proposed. `expectedFamilies` = spec
 * `families` keys (sorted), `basisKinds` = an empty list per family (never provable without L3;
 * S10 V4 requires the keys to equal `expectedFamilies`, so `{}` literally would fail — flagged),
 * `verifiers: []`, `nativeRules` declared ⇔ rules accepted.
 */
export function deriveInductionManifest(
  spec: SourceMappingSpec,
  rules: NativeRuleSet | null,
): InductionManifestV1 {
  const expectedFamilies = Object.keys(spec.families)
    .filter((f): f is CanonicalFamily => (CANONICAL_FAMILIES as readonly string[]).includes(f))
    .sort();
  const basisKinds: Partial<Record<CanonicalFamily, readonly ProvingBasisKind[]>> = {};
  for (const family of expectedFamilies) basisKinds[family] = Object.freeze([]);
  return Object.freeze({
    manifestVersion: 1,
    sourcePlatform: spec.sourcePlatform,
    expectedFamilies: Object.freeze(expectedFamilies),
    basisKinds: Object.freeze(basisKinds),
    verifiers: Object.freeze([]),
    nativeRules: rules === null ? 'absent' : 'declared',
  });
}

function checkPagination(
  step: ProposalStep,
  template: DigestTemplate,
  where: string,
  errors: Errors,
): void {
  const p = step.pagination;
  if (p === null) return;
  if (!template.queryKeys.some((q) => q.key === p.param))
    errors.add(
      `${where}.pagination.param`,
      'pagination param is not a query key of the template',
      'V-L5',
    );
  if (p.style === 'cursor') {
    if (p.nextPath === undefined)
      errors.add(`${where}.pagination.nextPath`, 'cursor needs nextPath', 'V-L5');
    else {
      const node = shapeAtPath(template.shape, p.nextPath);
      if (node === null || node.kind !== 'string')
        errors.add(
          `${where}.pagination.nextPath`,
          'nextPath does not resolve to a string in the shape',
          'V-L5',
        );
    }
    if (p.start !== undefined)
      errors.add(`${where}.pagination.start`, 'start is for style page only', 'V-L5');
  } else if (p.nextPath !== undefined) {
    errors.add(`${where}.pagination.nextPath`, 'nextPath is for style cursor only', 'V-L5');
  }
}

function checkPathTarget(
  path: readonly string[],
  shapes: readonly ShapeNode[],
  where: string,
  acceptsClasses: readonly string[] | null,
  errors: Errors,
  code: string,
): void {
  const targets = shapes.map((s) => shapeAtPath(s, path)).filter((n): n is ShapeNode => n !== null);
  if (targets.length === 0) {
    errors.add(where, 'path does not resolve to a key in the item shape of a feeding step', code);
    return;
  }
  for (const node of targets) {
    if (isContactShape(node)) {
      errors.add(where, 'path targets an email or phone class', code);
      return;
    }
    if (acceptsClasses !== null && !isIdShape(node)) {
      errors.add(where, 'path must target an id-class key', code);
      return;
    }
  }
}

function rulePaths(rule: NativeRule): readonly (readonly string[])[] {
  return rule.paths;
}

/** V-L2…V-L8, V-L10 over a V-L1-parsed proposal and a V-L0-parsed digest. Total, never throws. */
export function validateLearnedProposal(
  proposal: LearnedProposalV1,
  digest: StructureDigestV1,
  context: ProposalValidationContext,
): LearnParseResult<ValidatedProposal> {
  const errors = new Errors('V-L2');
  if (digest.sourcePlatform !== context.slug)
    errors.add('digest.sourcePlatform', 'digest slug differs from the run slug', 'V-L0');

  // V-L2
  let spec: SourceMappingSpec | null = null;
  try {
    spec = parseSourceMappingSpec(proposal.mappingSpec, 'learn:proposal');
    if (spec.sourcePlatform !== context.slug)
      errors.add('mappingSpec.sourcePlatform', 'mappingSpec slug differs from the run slug');
  } catch (err) {
    errors.add('mappingSpec', message(err));
  }
  // V-L3
  let rules: NativeRuleSet | null = null;
  if (proposal.nativeRules !== null) {
    try {
      rules = parseNativeRuleSet(proposal.nativeRules, 'learn:proposal');
      if (rules.sourcePlatform !== context.slug)
        errors.add(
          'nativeRules.sourcePlatform',
          'nativeRules slug differs from the run slug',
          'V-L3',
        );
      if (spec !== null)
        for (const family of Object.keys(rules.families))
          if (!(family in spec.families))
            errors.add(
              `nativeRules.families.${family}`,
              'rule family is not a spec family',
              'V-L3',
            );
    } catch (err) {
      errors.add('nativeRules', message(err), 'V-L3');
    }
  }
  if (spec === null || errors.any) return { ok: false, errors: errors.list };

  // V-L4
  const entityTypes = proposal.steps.map((s) => s.entityType);
  if (new Set(entityTypes).size !== entityTypes.length)
    errors.add('steps', 'duplicate entityType across steps', 'V-L4');
  for (const [i, s] of proposal.steps.entries())
    if (!Object.prototype.hasOwnProperty.call(spec.steps, s.entityType))
      errors.add(`steps[${i}].entityType`, 'entityType is not a mappingSpec.steps key', 'V-L4');
  for (const key of Object.keys(spec.steps))
    if (!entityTypes.includes(key))
      errors.add(`mappingSpec.steps.${key}`, 'spec step has no proposal step', 'V-L4');

  // V-L5
  const byRef = new Map(digest.templates.map((t) => [t.ref, t]));
  const validated: ValidatedStep[] = [];
  const collectAs = new Map<string, number>();
  proposal.steps.forEach((step, i) => {
    const where = `steps[${i}]`;
    const template = byRef.get(step.templateRef);
    if (template === undefined || template.role !== 'collection') {
      errors.add(
        `${where}.templateRef`,
        'templateRef is not a collection template of the digest',
        'V-L5',
      );
      return;
    }
    const pathText = JSON.stringify(step.itemsPath);
    if (!template.collectionPaths.some((p) => JSON.stringify(p) === pathText)) {
      errors.add(
        `${where}.itemsPath`,
        'itemsPath is not one of the template collectionPaths',
        'V-L5',
      );
      return;
    }
    const item = itemShapeAt(template.shape, step.itemsPath);
    if (item === null || item.kind !== 'object') {
      errors.add(`${where}.itemsPath`, 'items are not objects', 'V-L5');
      return;
    }
    const idNode = Object.prototype.hasOwnProperty.call(item.keys, step.idField)
      ? item.keys[step.idField]
      : null;
    if (idNode === null || !isIdShape(idNode))
      errors.add(`${where}.idField`, 'idField is not an id-class key of the item shape', 'V-L5');
    checkPagination(step, template, where, errors);
    const params = templateParamCount(template.template);
    if (step.forEach !== undefined) {
      const source = collectAs.get(step.forEach);
      if (source === undefined || source >= i)
        errors.add(`${where}.forEach`, 'forEach must name an earlier step collectAs', 'V-L5');
      if (params !== 1)
        errors.add(`${where}.forEach`, 'a forEach template needs exactly one :p parameter', 'V-L5');
    } else if (params !== 0) {
      errors.add(`${where}.templateRef`, 'a template with :p parameters needs forEach', 'V-L5');
    }
    if (step.collectAs !== undefined) {
      if (collectAs.has(step.collectAs))
        errors.add(`${where}.collectAs`, 'duplicate collectAs', 'V-L5');
      else collectAs.set(step.collectAs, i);
    }
    const family = spec.steps[step.entityType];
    if (family !== undefined)
      validated.push({
        step,
        template,
        templateKey: templateKey(template),
        family,
        itemShape: item,
      });
  });
  if (errors.any) return { ok: false, errors: errors.list };

  // V-L6
  for (const family of CANONICAL_FAMILIES) {
    const familyRules = spec.families[family];
    if (familyRules === undefined) continue;
    const fieldRules: Record<string, FieldRule> = { ...familyRules };
    const feeding = validated.filter((v) => v.family === family).map((v) => v.itemShape);
    if (feeding.length === 0) {
      errors.add(`mappingSpec.families.${family}`, 'family has no feeding step', 'V-L6');
      continue;
    }
    const descriptions =
      family === PERSON_FAMILY ? PERSON_FIELD_DESCRIPTIONS : ENTITY_FIELD_DESCRIPTIONS;
    for (const [field, rule] of Object.entries(fieldRules)) {
      const meta = (descriptions as Record<string, { acceptsClasses: readonly string[] | null }>)[
        field
      ];
      rule.paths.forEach((path, j) =>
        checkPathTarget(
          path,
          feeding,
          `mappingSpec.families.${family}.${field}.paths[${j}]`,
          meta?.acceptsClasses ?? null,
          errors,
          'V-L6',
        ),
      );
    }
  }
  if (rules !== null) {
    for (const [family, familyRules] of Object.entries(rules.families) as [
      string,
      Record<string, unknown>,
    ][]) {
      const feeding = validated.filter((v) => v.family === family).map((v) => v.itemShape);
      if (feeding.length === 0) {
        errors.add(`nativeRules.families.${family}`, 'family has no feeding step', 'V-L6');
        continue;
      }
      for (const [field, rule] of Object.entries(familyRules)) {
        const where = `nativeRules.families.${family}.${field}`;
        if (field === 'exercises') {
          const ex = rule as {
            paths: readonly (readonly string[])[];
            item: Record<string, NativeRule>;
          };
          const arrays: ShapeNode[] = [];
          ex.paths.forEach((path, j) => {
            const nodes = feeding
              .map((s) => shapeAtPath(s, path))
              .filter((n): n is ShapeNode => n !== null);
            const items = nodes
              .filter((n) => n.kind === 'array')
              .map((n) => (n as { items: ShapeNode }).items);
            if (items.length === 0)
              errors.add(
                `${where}.paths[${j}]`,
                'exercises path does not resolve to an array',
                'V-L6',
              );
            arrays.push(...items);
          });
          for (const [itemField, itemRule] of Object.entries(ex.item))
            rulePaths(itemRule).forEach((path, j) =>
              checkPathTarget(
                path,
                arrays,
                `${where}.item.${itemField}.paths[${j}]`,
                null,
                errors,
                'V-L6',
              ),
            );
        } else {
          rulePaths(rule as NativeRule).forEach((path, j) =>
            checkPathTarget(path, feeding, `${where}.paths[${j}]`, null, errors, 'V-L6'),
          );
        }
      }
    }
  }

  // V-L7
  const manifest = deriveInductionManifest(spec, rules);
  try {
    const parsedManifest = parseInductionManifest(manifest, 'learn:derived');
    buildInductionRegistry({
      manifests: [parsedManifest],
      specs: [spec],
      nativeRuleSets: rules === null ? [] : [rules],
    });
  } catch (err) {
    errors.add('manifest', message(err), 'V-L7');
  }

  // V-L8
  const linkRefs = new Set(digest.linkTemplates.map((l) => l.ref));
  proposal.explore.forEach((ref, i) => {
    if (!linkRefs.has(ref))
      errors.add(`explore[${i}]`, 'explore ref is not a linkTemplates ref', 'V-L8');
  });
  if (digest.round === 2 && proposal.explore.length > 0)
    errors.add('explore', 'explore is round 1 only', 'V-L8');

  // V-L10
  const collection = digest.templates.filter((t) => t.role === 'collection').map((t) => t.ref);
  const stepRefs = proposal.steps.map((s) => s.templateRef);
  const unmappedRefs = proposal.unmapped.map((u) => u.templateRef);
  const seen = new Set<string>();
  for (const ref of [...stepRefs, ...unmappedRefs]) {
    if (seen.has(ref))
      errors.add('steps/unmapped', `template ${ref} appears more than once`, 'V-L10');
    seen.add(ref);
  }
  proposal.unmapped.forEach((u, i) => {
    const t = byRef.get(u.templateRef);
    if (t === undefined || t.role !== 'collection')
      errors.add(
        `unmapped[${i}].templateRef`,
        'unmapped ref is not a collection template',
        'V-L10',
      );
  });
  for (const ref of collection)
    if (!seen.has(ref))
      errors.add(
        'steps/unmapped',
        `collection template ${ref} is neither a step nor unmapped`,
        'V-L10',
      );
  if (digest.round === 2 && context.round1StepKeys !== undefined) {
    const keys = new Set(validated.map((v) => v.templateKey));
    for (const key of context.round1StepKeys)
      if (!keys.has(key))
        errors.add('steps', 'round-2 proposal drops a round-1 step (template key)', 'V-L10');
  }
  if (errors.any) return { ok: false, errors: errors.list };

  const unmapped = proposal.unmapped.map((u) =>
    Object.freeze({ templateKey: templateKey(byRef.get(u.templateRef)!), reason: u.reason }),
  );
  return {
    ok: true,
    value: Object.freeze({
      proposal,
      digest,
      mappingSpec: spec,
      nativeRules: rules,
      manifest,
      steps: Object.freeze(validated),
      unmapped: Object.freeze(unmapped),
    }),
  };
}
