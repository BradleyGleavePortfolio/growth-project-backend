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
import type { InductionManifestV1, ProvingBasisKind } from '../induction/contract';
import { parseInductionManifest } from '../induction/parse';
import { buildInductionRegistry } from '../induction/manifest-registry';
import {
  CONTACT_CLASSES,
  DIGIT_RUN_PATTERN,
  Errors,
  ID_CLASSES,
  asObject,
  identityMatches,
  itemShapeAt,
  shapeAtPath,
  structureKeyOf,
  templateParamCount,
  templateSegments,
  type DigestTemplate,
  type LearnParseResult,
  type ShapeNode,
  type StructureDigestV1,
  type StructureKey,
} from './digest-contract';
import {
  KEY_IDENTIFIER_PATTERN,
  KEY_MAX_BYTES,
  ORIGIN_TEMPLATE_PATTERN,
  PAGINATION_PARAM_WORDS,
  QUERY_KEY_PATTERN,
} from './admission';
import {
  ACCEPT_INTEGER_NUMBER_ID_FIELD,
  ENTITY_FIELD_DESCRIPTIONS,
  EXERCISE_NATIVE_FIELDS,
  NATIVE_RULE_KINDS,
  PAGINATION_STYLES,
  type PaginationStyle,
  PERSON_FIELD_DESCRIPTIONS,
  PROGRAM_NATIVE_FIELDS,
  WORKOUT_NATIVE_FIELDS,
  isMappedFamily,
  type NativeFieldDescription,
} from './canonical-contract';
import { MORE_PAGES_SIGNALS, mutatingTokenRefusal, tokenize } from './contract-vocabulary';
import { FAMILY_LABELS, type FamilyLabel } from './family-catalogue';
import { validateSchema, type JsonSchema } from './schema';

/**
 * L1 (D-L0-4, grammar version 2; r2 review round) — the `LearnedProposalV1` grammar (data only),
 * its strict parser V-L1 and the validators V-L2…V-L8 and V-L10 that must accept before any
 * source request. The grammar is written ONCE as a JSON Schema (`proposalJsonSchema()`),
 * generated from the same canonical tables the validators iterate; V-L1 interprets that schema,
 * the prompt prints it, the provider enforces it. `mappingSpec` and `nativeRules` are re-parsed
 * by the landed interpreters (`parseSourceMappingSpec`, `parseNativeRuleSet`) — never
 * reimplemented — and the derived `InductionManifestV1` must pass S10 V1-V6 in
 * `buildInductionRegistry` (V-L7 is the ONLY check of "rule families ⊆ spec families": the
 * landed registry does it, so a test with a stray rule family fails at V-L7 alone).
 *
 * The model proposes a FAMILY LABEL (closed FAM-0 catalogue, `unclassified` catch-all) and a
 * field mapping; it never proposes a destination (r2 direction 2). Steps carry `idScope`,
 * `parentEdge` and `timestampField` (direction 3). Pagination is judged against the template's
 * device-computed `paginationSignals` (direction 4). Enum rules and string flag markers are not
 * proposable: the digest carries no values, so such literals would be model-invented (A-02).
 */

export const PROPOSAL_VERSION = 2 as const;
export const PROPOSAL_MAX_STEPS = 16;
export const PROPOSAL_MAX_EXPLORE = 8;
export const PROPOSAL_MAX_RATIONALE_CHARS = 512;
export const PROPOSAL_MAX_PATHS_PER_RULE = 4;
export const PROPOSAL_MAX_PATH_DEPTH = 4;

/**
 * r7 (D-L0-4; D-L0-9 L1 owed item 1): `out_of_scope_billing` is DELETED — billing is a family
 * (`billing_history` / `billing_schedule`, D10; FAM-0 D-FAM-5), never an unmapped reason. A
 * reason is a claim, never an exclusion: every unmapped collection is gap `collection_unmapped`.
 */
export const UNMAPPED_REASONS = [
  'out_of_scope_account_settings',
  'out_of_scope_ui_config',
  'unknown',
] as const;
export type UnmappedReason = (typeof UNMAPPED_REASONS)[number];
export const ID_SCOPES = ['global', 'parent'] as const;
export type IdScope = (typeof ID_SCOPES)[number];
export { ACCEPT_INTEGER_NUMBER_ID_FIELD, PAGINATION_STYLES, type PaginationStyle };

export interface ProposalPagination {
  readonly style: PaginationStyle;
  /** Query key carrying the page number / cursor (styles page, cursor). */
  readonly param?: string;
  /** First page value (style page: 0|1). */
  readonly start?: number;
  /** Path to the next cursor (style cursor) or the next link (style next_url). */
  readonly nextPath?: readonly string[];
}

export interface ParentEdge {
  /** The item key holding the parent's source id. */
  readonly field: string;
  /** The `entityType` of an EARLIER step the parent lives in. */
  readonly toStep: string;
}

export interface ProposalStep {
  readonly templateRef: string;
  readonly entityType: string;
  /** Classification only; the destination is derived later (r2 direction 2). */
  readonly family: FamilyLabel;
  readonly itemsPath: readonly string[];
  readonly idField: string;
  /** Required when `forEach` is set: `parent` ⇒ identity is `${parentId}:${id}`. */
  readonly idScope?: IdScope;
  readonly parentEdge?: ParentEdge;
  readonly timestampField?: string;
  readonly collectAs?: string;
  readonly forEach?: string;
  readonly pagination: ProposalPagination;
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
      case 'flag':
        // R591-A-02: truthy markers are booleans or small integers only; a string marker would
        // be a source VALUE the digest never showed the model.
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
              uniqueItems: true,
              items: {
                anyOf: [{ type: 'integer', minimum: -999, maximum: 999 }, { type: 'boolean' }],
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
  for (const [field, meta] of Object.entries(fields)) {
    // Only the proposable kinds (no `enum`); a field with none left is not proposable at all.
    const kinds = meta.kinds.filter((k) => NATIVE_RULE_KINDS.includes(k));
    if (kinds.length > 0) properties[field] = nativeRuleSchema(kinds);
  }
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
          required: ['templateRef', 'entityType', 'family', 'itemsPath', 'idField', 'pagination'],
          additionalProperties: false,
          properties: {
            templateRef: { type: 'string', pattern: TEMPLATE_REF },
            entityType: token,
            family: { type: 'string', enum: FAMILY_LABELS },
            itemsPath: { type: 'array', items: keyString, maxItems: PROPOSAL_MAX_PATH_DEPTH },
            idField: keyString,
            idScope: { type: 'string', enum: ID_SCOPES },
            parentEdge: {
              type: 'object',
              required: ['field', 'toStep'],
              additionalProperties: false,
              properties: { field: keyString, toStep: token },
            },
            timestampField: keyString,
            collectAs: token,
            forEach: token,
            pagination: {
              type: 'object',
              required: ['style'],
              additionalProperties: false,
              properties: {
                style: { type: 'string', enum: PAGINATION_STYLES },
                param: { type: 'string', pattern: QUERY_KEY_PATTERN.source },
                start: { type: 'integer', minimum: 0, maximum: 1 },
                nextPath: keyPath,
              },
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

/** Copy one schema-validated step into a frozen `ProposalStep` (shared with the package reader). */
export function copyStep(s: Record<string, unknown>): ProposalStep {
  const edge = s.parentEdge as ParentEdge | undefined;
  return Object.freeze({
    templateRef: s.templateRef as string,
    entityType: s.entityType as string,
    family: s.family as FamilyLabel,
    itemsPath: Object.freeze([...(s.itemsPath as string[])]),
    idField: s.idField as string,
    ...(s.idScope === undefined ? {} : { idScope: s.idScope as IdScope }),
    ...(edge === undefined
      ? {}
      : { parentEdge: Object.freeze({ field: edge.field, toStep: edge.toStep }) }),
    ...(s.timestampField === undefined ? {} : { timestampField: s.timestampField as string }),
    ...(s.collectAs === undefined ? {} : { collectAs: s.collectAs as string }),
    ...(s.forEach === undefined ? {} : { forEach: s.forEach as string }),
    pagination: copyPagination(s.pagination as ProposalPagination),
  });
}

/** The step fragment of the grammar, for readers that re-validate stored steps (package.ts). */
export function stepJsonSchema(): JsonSchema {
  const schema = proposalJsonSchema();
  if (!('type' in schema) || schema.type !== 'object' || schema.properties === undefined)
    throw new Error('grammar');
  const steps = schema.properties.steps;
  if (!('type' in steps) || steps.type !== 'array') throw new Error('grammar');
  return steps.items;
}

function copyPagination(p: ProposalPagination): ProposalPagination {
  return Object.freeze({
    style: p.style,
    ...(p.param === undefined ? {} : { param: p.param }),
    ...(p.start === undefined ? {} : { start: p.start }),
    ...(p.nextPath === undefined ? {} : { nextPath: Object.freeze([...p.nextPath]) }),
  });
}

// ── V-L1 ──────────────────────────────────────────────────────────────────────────────────

/** Every string anywhere in the reply: no scheme, no `@`, no digit run, no control/format char. */
export function scanStrings(value: unknown, path: string, errors: Errors): void {
  if (typeof value === 'string') {
    if (
      /:\/\//.test(value) ||
      (/^[a-z][a-z0-9+.-]*:/i.test(value) && !ORIGIN_TEMPLATE_PATTERN.test(value))
    )
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
  const steps = (obj.steps as Record<string, unknown>[]).map((s) => copyStep(s));
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
  /** The run's slug (D-L0-5), server-side context: the spec and the rules must carry it. */
  readonly slug: string;
  /**
   * Round 2 (D-L0-3, V-L10 union rule; r7): the structure keys of the round-1 package's steps.
   * Every round-1 step WHOSE IDENTITY IS IN THE UNION (a collection template of this digest with
   * the same `(origin, method, template)`, whatever its key paths) must still be a step; a
   * round-1 step whose identity the union never shows is `template_absent` — never a refusal.
   * MANDATORY for a round-2 digest — a round-2 validation without it is refused (R591-B-B2: no
   * fail-open).
   */
  readonly round1StepKeys?: readonly StructureKey[];
  /**
   * `strict` (default, a live proposal): every mapping path resolves. `match` (a stored package
   * re-applied to a new digest, D-L0-3 step 3): a mapping path whose FIRST key this digest never
   * observed in the item shape is compatible and binds nothing; a path that resolves to the wrong
   * class is still refused.
   */
  readonly mode?: 'strict' | 'match';
}

export interface ValidatedStep {
  readonly step: ProposalStep;
  readonly template: DigestTemplate;
  readonly structureKey: StructureKey;
  readonly family: FamilyLabel;
  /** The canonical mapping family when `family` is mapped, else `null` (classification only). */
  readonly mappedFamily: CanonicalFamily | null;
  readonly itemShape: ShapeNode & { readonly kind: 'object' };
}

export interface ValidatedProposal {
  readonly proposal: LearnedProposalV1;
  readonly digest: StructureDigestV1;
  readonly mappingSpec: SourceMappingSpec;
  readonly nativeRules: NativeRuleSet | null;
  readonly manifest: InductionManifestV1;
  readonly steps: readonly ValidatedStep[];
  readonly unmapped: readonly {
    readonly structureKey: StructureKey;
    readonly reason: UnmappedReason;
  }[];
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

const PARAM_WORD_SET: ReadonlySet<string> = new Set(PAGINATION_PARAM_WORDS);

function isPaginationWord(param: string): boolean {
  const tokens = tokenize(param);
  return tokens.length > 0 && tokens.every((t) => PARAM_WORD_SET.has(t));
}

/**
 * Reset directive 4 + r2 direction 4: `none` is a claim that needs POSITIVE proof from the
 * device-computed signals — `single_response` present, no more-pages signal, and a total count
 * either absent or proven equal to the row count. Never exhaustion: L3 proves that at replay.
 */
export function paginationNoneRefusal(template: DigestTemplate): string | null {
  const signals = new Set<string>(template.paginationSignals);
  if (!signals.has('single_response'))
    return 'pagination none needs positive proof: template lacks the single_response signal';
  const more = MORE_PAGES_SIGNALS.find((sig) => signals.has(sig));
  if (more !== undefined) return `pagination none needs positive proof: template signals ${more}`;
  if (signals.has('total_count_key') && !signals.has('total_equals_count'))
    return 'pagination none needs positive proof: a total count key without total_equals_count';
  return null;
}

function checkPagination(
  step: ProposalStep,
  template: DigestTemplate,
  where: string,
  errors: Errors,
): void {
  const p = step.pagination;
  const at = `${where}.pagination`;
  const signals = new Set<string>(template.paginationSignals);
  const needsParam = p.style === 'page' || p.style === 'cursor';
  const needsNext = p.style === 'cursor' || p.style === 'next_url';
  if (needsParam) {
    if (p.param === undefined) errors.add(`${at}.param`, `${p.style} needs param`, 'V-L5');
    else if (!template.queryKeys.some((q) => q.key === p.param)) {
      const signal = p.style === 'page' ? 'page_param' : 'cursor_key';
      if (!(isPaginationWord(p.param) && signals.has(signal)))
        errors.add(
          `${at}.param`,
          `pagination param must be a query key of the template, or a pagination word when the template signals ${signal}`,
          'V-L5',
        );
    }
  } else if (p.param !== undefined) {
    errors.add(`${at}.param`, `${p.style} takes no param`, 'V-L5');
  }
  if (needsNext) {
    if (p.nextPath === undefined) errors.add(`${at}.nextPath`, `${p.style} needs nextPath`, 'V-L5');
    else {
      const node = shapeAtPath(template.shape, p.nextPath);
      if (node === null || node.kind !== 'string')
        errors.add(`${at}.nextPath`, 'nextPath does not resolve to a string in the shape', 'V-L5');
      else if (p.style === 'next_url' && node.class !== 'url')
        errors.add(
          `${at}.nextPath`,
          'next_url nextPath must resolve to a url-class string',
          'V-L5',
        );
      else if (p.style === 'cursor' && node.class === 'url')
        errors.add(`${at}.nextPath`, 'a url-class next link needs style next_url', 'V-L5');
    }
  } else if (p.nextPath !== undefined) {
    errors.add(`${at}.nextPath`, `${p.style} takes no nextPath`, 'V-L5');
  }
  if (p.start !== undefined && p.style !== 'page')
    errors.add(`${at}.start`, `${p.style} takes no start`, 'V-L5');
  if (p.style === 'none') {
    const refusal = paginationNoneRefusal(template);
    if (refusal !== null) errors.add(`${at}.style`, refusal, 'V-L5');
  }
}

function checkPathTarget(
  path: readonly string[],
  shapes: readonly ShapeNode[],
  where: string,
  acceptsClasses: readonly string[] | null,
  errors: Errors,
  code: string,
  mode: 'strict' | 'match' = 'strict',
): void {
  const targets = shapes.map((s) => shapeAtPath(s, path)).filter((n): n is ShapeNode => n !== null);
  if (targets.length === 0) {
    // Match mode: a key this digest never observed is a sparser account, not a contradiction.
    const unobserved = shapes.every(
      (s) => s.kind === 'object' && !Object.prototype.hasOwnProperty.call(s.keys, path[0]),
    );
    if (mode === 'match' && unobserved) return;
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
  const mode = context.mode ?? 'strict';
  if (digest.round === 2 && context.round1StepKeys === undefined) {
    errors.add('context.round1StepKeys', 'round-2 validation needs the round-1 step keys', 'V-L10');
    return { ok: false, errors: errors.list };
  }

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
      // "rule families ⊆ spec families" is V-L7's (the landed registry's) check, not repeated here.
    } catch (err) {
      errors.add('nativeRules', message(err), 'V-L3');
    }
  }
  if (spec === null || errors.any) return { ok: false, errors: errors.list };

  // V-L4: steps with a MAPPED family ⇔ mappingSpec.steps keys, same family; a step whose family
  // is classification-only (no mapping family) must not appear in the spec.
  const entityTypes = proposal.steps.map((s) => s.entityType);
  if (new Set(entityTypes).size !== entityTypes.length)
    errors.add('steps', 'duplicate entityType across steps', 'V-L4');
  const mappedTypes: string[] = [];
  for (const [i, s] of proposal.steps.entries()) {
    const inSpec = Object.prototype.hasOwnProperty.call(spec.steps, s.entityType);
    if (isMappedFamily(s.family)) {
      mappedTypes.push(s.entityType);
      if (!inSpec)
        errors.add(`steps[${i}].entityType`, 'entityType is not a mappingSpec.steps key', 'V-L4');
      else if (spec.steps[s.entityType] !== s.family)
        errors.add(`steps[${i}].family`, 'family differs from mappingSpec.steps family', 'V-L4');
    } else if (inSpec) {
      errors.add(
        `steps[${i}].family`,
        'a classification-only family label has no mappingSpec.steps entry',
        'V-L4',
      );
    }
  }
  // Match mode: a spec step absent from this digest is an explore target, not a refusal.
  if (mode === 'strict')
    for (const key of Object.keys(spec.steps))
      if (!mappedTypes.includes(key))
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
    // r7 D-L0-6.2 no-mutation bound, server half: a template naming a mutating verb in a path
    // literal or query key may only be `unmapped` (the device refuses it with zero requests).
    const mutating = mutatingTokenRefusal(
      templateSegments(template.template),
      template.queryKeys.map((q) => q.key),
    );
    if (mutating !== null) {
      errors.add(
        `${where}.templateRef`,
        `${mutating}: a mutating template may only be unmapped (D-L0-6.2)`,
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
    const keyOf = (name: string): ShapeNode | null =>
      Object.prototype.hasOwnProperty.call(item.keys, name) ? item.keys[name] : null;
    const idNode = keyOf(step.idField);
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
      if (step.idScope === undefined)
        errors.add(`${where}.idScope`, 'a forEach step must state idScope', 'V-L5');
    } else if (params !== 0) {
      errors.add(`${where}.templateRef`, 'a template with :p parameters needs forEach', 'V-L5');
    }
    if (step.collectAs !== undefined) {
      if (collectAs.has(step.collectAs))
        errors.add(`${where}.collectAs`, 'duplicate collectAs', 'V-L5');
      else collectAs.set(step.collectAs, i);
    }
    if (step.parentEdge !== undefined) {
      const fieldNode = keyOf(step.parentEdge.field);
      if (fieldNode === null || !isIdShape(fieldNode) || step.parentEdge.field === step.idField)
        errors.add(
          `${where}.parentEdge.field`,
          'parentEdge.field must be an id-class key of the item shape other than idField',
          'V-L5',
        );
      const target = proposal.steps.findIndex((o) => o.entityType === step.parentEdge?.toStep);
      if (target < 0 || target >= i)
        errors.add(
          `${where}.parentEdge.toStep`,
          'parentEdge.toStep must be an earlier step',
          'V-L5',
        );
    }
    if (step.timestampField !== undefined) {
      const tsNode = keyOf(step.timestampField);
      if (tsNode === null || tsNode.kind !== 'string' || tsNode.class !== 'iso_date')
        errors.add(
          `${where}.timestampField`,
          'timestampField must be an iso_date key of the item shape',
          'V-L5',
        );
    }
    validated.push({
      step,
      template,
      structureKey: structureKeyOf(digest, template),
      family: step.family,
      mappedFamily: isMappedFamily(step.family) ? step.family : null,
      itemShape: item,
    });
  });
  if (errors.any) return { ok: false, errors: errors.list };

  // V-L6
  for (const family of CANONICAL_FAMILIES) {
    const familyRules = spec.families[family];
    if (familyRules === undefined) continue;
    const fieldRules: Record<string, FieldRule> = { ...familyRules };
    const feeding = validated.filter((v) => v.mappedFamily === family).map((v) => v.itemShape);
    if (feeding.length === 0) {
      if (mode === 'strict')
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
          mode,
        ),
      );
    }
  }
  if (rules !== null) {
    for (const [family, familyRules] of Object.entries(rules.families) as [
      string,
      Record<string, unknown>,
    ][]) {
      // A rule family outside the spec is V-L7's refusal (registry), not a V-L6 path error.
      if (!Object.prototype.hasOwnProperty.call(spec.families, family)) continue;
      const feeding = validated.filter((v) => v.mappedFamily === family).map((v) => v.itemShape);
      if (feeding.length === 0) {
        if (mode === 'strict')
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
                mode,
              ),
            );
        } else {
          rulePaths(rule as NativeRule).forEach((path, j) =>
            checkPathTarget(path, feeding, `${where}.paths[${j}]`, null, errors, 'V-L6', mode),
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
    // Union rule (r7): a round-1 step is owed only when the union shows its identity; a step the
    // run never observed is `template_absent`, never a refusal (sparse account, unvisited link).
    const unionIdentities = digest.templates
      .filter((t) => t.role === 'collection')
      .map((t) => structureKeyOf(digest, t));
    context.round1StepKeys.forEach((key, i) => {
      if (!unionIdentities.some((u) => identityMatches(u, key))) return;
      if (!validated.some((v) => identityMatches(v.structureKey, key)))
        errors.add(
          'steps',
          `round-2 proposal drops round-1 step ${i} whose identity is in the union`,
          'V-L10',
        );
    });
  }
  if (errors.any) return { ok: false, errors: errors.list };

  const unmapped = proposal.unmapped.map((u) =>
    Object.freeze({
      structureKey: structureKeyOf(digest, byRef.get(u.templateRef)!),
      reason: u.reason,
    }),
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
