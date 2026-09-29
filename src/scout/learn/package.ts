import { createHash } from 'crypto';
import type { SourceMappingSpec } from '../reconstruct/mapping-spec';
import type { NativeRuleSet } from '../reconstruct/native/native-rules';
import type { InductionManifestV1 } from '../induction/contract';
import { canonicalJson } from '../induction/digest';
import { parseInductionManifest } from '../induction/parse';
import { parseSourceMappingSpec } from '../reconstruct/mapping-spec';
import { parseNativeRuleSet } from '../reconstruct/native/native-rules';
import { isCanonicalPlatform } from '../scout-platform';
import {
  DIGEST_METHODS,
  Errors,
  asObject,
  checkKeys,
  isWellFormedTemplate,
  templateKeyString,
  templateSegments,
  utf8Bytes,
  type DigestMethod,
  type LearnParseResult,
} from './digest-contract';
import { headerNameRefusal, pathLiteralRefusal } from './admission';
import { VOCABULARY_VERSION } from './contract-vocabulary';
import { CANONICAL_CONTRACT_VERSION } from './canonical-contract';
import {
  PROPOSAL_MAX_STEPS,
  UNMAPPED_REASONS,
  type ProposalPagination,
  type UnmappedReason,
  type ValidatedProposal,
} from './proposal';

/**
 * L1 (D-L0-4 "The package stores steps by template key", D-L0-5, V-L9) — `LearnedPackageV1`:
 * what memory stores and every later coach on the same structure reuses. Steps are keyed by
 * `(method, slotted template, shapeSignature)` (never by ref: refs are per digest), and the
 * grammar has no field that can hold a source value — no header value, no slot value, no query
 * value, no path literal outside the vocabulary. `closureInputs` (r3) is L1b's sequential edit.
 */

export const PACKAGE_VERSION = 1 as const;
/** V-L9: canonical JSON of one package ≤ 64 KiB. */
export const PACKAGE_MAX_BYTES = 64 * 1024;

export interface PackageTemplateKey {
  readonly method: DigestMethod;
  readonly template: string;
  readonly shapeSignature: string;
}

export interface PackageStep {
  readonly key: PackageTemplateKey;
  readonly entityType: string;
  readonly itemsPath: readonly string[];
  readonly idField: string;
  readonly collectAs?: string;
  readonly forEach?: string;
  readonly pagination: ProposalPagination | null;
}

export interface PackageUnmapped {
  readonly key: PackageTemplateKey;
  readonly reason: UnmappedReason;
}

export interface LearnedPackageV1 {
  readonly packageVersion: typeof PACKAGE_VERSION;
  readonly sourcePlatform: string;
  readonly contractVersion: typeof CANONICAL_CONTRACT_VERSION;
  readonly vocabularyVersion: typeof VOCABULARY_VERSION;
  readonly steps: readonly PackageStep[];
  readonly unmapped: readonly PackageUnmapped[];
  readonly mappingSpec: SourceMappingSpec;
  readonly nativeRules: NativeRuleSet | null;
  readonly manifest: InductionManifestV1;
  /** Header NAMES only; the device rebinds values from the coach's own capture (D-L0-2). */
  readonly constantHeaderNames: readonly string[];
}

const PACKAGE_KEYS = [
  'packageVersion',
  'sourcePlatform',
  'contractVersion',
  'vocabularyVersion',
  'steps',
  'unmapped',
  'mappingSpec',
  'nativeRules',
  'manifest',
  'constantHeaderNames',
] as const;
const KEY_KEYS = ['method', 'template', 'shapeSignature'] as const;
const STEP_KEYS = [
  'key',
  'entityType',
  'itemsPath',
  'idField',
  'collectAs',
  'forEach',
  'pagination',
] as const;
const STEP_REQUIRED = ['key', 'entityType', 'itemsPath', 'idField', 'pagination'] as const;
const SIGNATURE_PATTERN = /^[a-z(){}[\]*,0-9]{1,4096}$/;

function parseKey(raw: unknown): PackageTemplateKey | null {
  const obj = asObject(raw);
  if (obj === null || Object.keys(obj).some((k) => !(KEY_KEYS as readonly string[]).includes(k)))
    return null;
  if (!(DIGEST_METHODS as readonly unknown[]).includes(obj.method)) return null;
  if (typeof obj.template !== 'string' || !isWellFormedTemplate(obj.template)) return null;
  if (
    templateSegments(obj.template).some((s) => !/^:[ps]/.test(s) && pathLiteralRefusal(s) !== null)
  )
    return null;
  if (typeof obj.shapeSignature !== 'string' || !SIGNATURE_PATTERN.test(obj.shapeSignature))
    return null;
  return Object.freeze({
    method: obj.method as DigestMethod,
    template: obj.template,
    shapeSignature: obj.shapeSignature,
  });
}

function keyOf(templateKey: string): PackageTemplateKey {
  const [method, template, shapeSignature] = JSON.parse(templateKey) as [
    DigestMethod,
    string,
    string,
  ];
  return Object.freeze({ method, template, shapeSignature });
}

export function packageTemplateKeyString(key: PackageTemplateKey): string {
  return templateKeyString(key.method, key.template, key.shapeSignature);
}

/** Build the package from a fully validated proposal (V-L2…V-L10 passed). Pure. */
export function buildLearnedPackage(validated: ValidatedProposal): LearnedPackageV1 {
  return Object.freeze({
    packageVersion: PACKAGE_VERSION,
    sourcePlatform: validated.mappingSpec.sourcePlatform,
    contractVersion: CANONICAL_CONTRACT_VERSION,
    vocabularyVersion: VOCABULARY_VERSION,
    steps: Object.freeze(
      validated.steps.map((v) =>
        Object.freeze({
          key: keyOf(v.templateKey),
          entityType: v.step.entityType,
          itemsPath: v.step.itemsPath,
          idField: v.step.idField,
          ...(v.step.collectAs === undefined ? {} : { collectAs: v.step.collectAs }),
          ...(v.step.forEach === undefined ? {} : { forEach: v.step.forEach }),
          pagination: v.step.pagination,
        }),
      ),
    ),
    unmapped: Object.freeze(
      validated.unmapped.map((u) => Object.freeze({ key: keyOf(u.templateKey), reason: u.reason })),
    ),
    mappingSpec: validated.mappingSpec,
    nativeRules: validated.nativeRules,
    manifest: validated.manifest,
    constantHeaderNames: validated.digest.constantHeaderNames,
  });
}

/** V-L9: the canonical JSON text of a package, or a refusal when unserialisable or over 64 KiB. */
export function canonicalPackageJson(pkg: LearnedPackageV1): LearnParseResult<string> {
  const errors = new Errors('V-L9');
  const text = canonicalJson(pkg);
  if (text === null) {
    errors.add('package', 'package is not canonical JSON');
    return { ok: false, errors: errors.list };
  }
  if (utf8Bytes(text) > PACKAGE_MAX_BYTES) {
    errors.add('package', `package over ${PACKAGE_MAX_BYTES} bytes`);
    return { ok: false, errors: errors.list };
  }
  return { ok: true, value: text };
}

/** `package_digest` = sha256 hex over the canonical JSON (V-L9). */
export function packageDigest(pkg: LearnedPackageV1): LearnParseResult<string> {
  const text = canonicalPackageJson(pkg);
  if (!text.ok) return text;
  return { ok: true, value: createHash('sha256').update(text.value, 'utf8').digest('hex') };
}

/** The sorted template keys of the package's steps (the round-2 union rule input, V-L10). */
export function packageStepKeys(pkg: LearnedPackageV1): readonly string[] {
  return pkg.steps.map((s) => packageTemplateKeyString(s.key)).sort();
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : 'parse error';
}

/**
 * Strict parser for a STORED package (L2 reads rows back through this; a corrupted or hostile row
 * never reaches the registry). Re-runs the landed interpreters on the embedded artifacts and
 * re-derives nothing: what was stored is what is served, or it is refused.
 */
export function parseLearnedPackage(raw: unknown): LearnParseResult<LearnedPackageV1> {
  const errors = new Errors('V-L9');
  const obj = asObject(raw);
  if (obj === null) {
    errors.add('', 'package must be an object');
    return { ok: false, errors: errors.list };
  }
  if (!checkKeys(obj, PACKAGE_KEYS, PACKAGE_KEYS, 'package', errors))
    return { ok: false, errors: errors.list };
  if (obj.packageVersion !== PACKAGE_VERSION)
    errors.add('packageVersion', 'packageVersion must be 1');
  if (obj.contractVersion !== CANONICAL_CONTRACT_VERSION)
    errors.add('contractVersion', 'contractVersion differs from the live contract');
  if (obj.vocabularyVersion !== VOCABULARY_VERSION)
    errors.add('vocabularyVersion', 'vocabularyVersion differs from the live vocabulary');
  if (!isCanonicalPlatform(obj.sourcePlatform))
    errors.add('sourcePlatform', 'not a canonical slug');
  let spec: SourceMappingSpec | null = null;
  try {
    spec = parseSourceMappingSpec(obj.mappingSpec, 'learn:package');
    if (spec.sourcePlatform !== obj.sourcePlatform) errors.add('mappingSpec', 'slug mismatch');
  } catch (err) {
    errors.add('mappingSpec', message(err));
  }
  let rules: NativeRuleSet | null = null;
  if (obj.nativeRules !== null) {
    try {
      rules = parseNativeRuleSet(obj.nativeRules, 'learn:package');
      if (rules.sourcePlatform !== obj.sourcePlatform) errors.add('nativeRules', 'slug mismatch');
    } catch (err) {
      errors.add('nativeRules', message(err));
    }
  }
  let manifest: InductionManifestV1 | null = null;
  try {
    manifest = parseInductionManifest(obj.manifest, 'learn:package');
    if (manifest.sourcePlatform !== obj.sourcePlatform) errors.add('manifest', 'slug mismatch');
    if (manifest.verifiers.length > 0)
      errors.add('manifest', 'a learned manifest has no verifiers');
    if ((manifest.nativeRules === 'declared') !== (obj.nativeRules !== null))
      errors.add('manifest', 'nativeRules declaration contradicts the stored rules');
  } catch (err) {
    errors.add('manifest', message(err));
  }
  const steps: PackageStep[] = [];
  if (!Array.isArray(obj.steps) || obj.steps.length > PROPOSAL_MAX_STEPS) {
    errors.add('steps', 'steps must be a list of at most 8');
  } else {
    obj.steps.forEach((s, i) => {
      const where = `steps[${i}]`;
      const step = asObject(s);
      if (step === null || !checkKeys(step, STEP_KEYS, STEP_REQUIRED, where, errors)) return;
      const key = parseKey(step.key);
      if (key === null) errors.add(`${where}.key`, 'malformed template key');
      if (typeof step.entityType !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(step.entityType))
        errors.add(`${where}.entityType`, 'malformed entityType');
      if (!Array.isArray(step.itemsPath) || step.itemsPath.some((k) => typeof k !== 'string'))
        errors.add(`${where}.itemsPath`, 'malformed itemsPath');
      if (typeof step.idField !== 'string') errors.add(`${where}.idField`, 'malformed idField');
      if (step.pagination !== null && asObject(step.pagination) === null)
        errors.add(`${where}.pagination`, 'malformed pagination');
      if (key !== null && !errors.any)
        steps.push(
          Object.freeze({
            key,
            entityType: step.entityType as string,
            itemsPath: Object.freeze([...(step.itemsPath as string[])]),
            idField: step.idField as string,
            ...(step.collectAs === undefined ? {} : { collectAs: step.collectAs as string }),
            ...(step.forEach === undefined ? {} : { forEach: step.forEach as string }),
            pagination: step.pagination as ProposalPagination | null,
          }),
        );
    });
  }
  const unmapped: PackageUnmapped[] = [];
  if (!Array.isArray(obj.unmapped) || obj.unmapped.length > 64) {
    errors.add('unmapped', 'unmapped must be a list of at most 64');
  } else {
    obj.unmapped.forEach((u, i) => {
      const entry = asObject(u);
      const key = entry === null ? null : parseKey(entry.key);
      if (
        entry === null ||
        key === null ||
        !(UNMAPPED_REASONS as readonly unknown[]).includes(entry.reason) ||
        Object.keys(entry).length !== 2
      ) {
        errors.add(`unmapped[${i}]`, 'malformed unmapped entry');
        return;
      }
      unmapped.push(Object.freeze({ key, reason: entry.reason as UnmappedReason }));
    });
  }
  if (
    !Array.isArray(obj.constantHeaderNames) ||
    obj.constantHeaderNames.length > 16 ||
    obj.constantHeaderNames.some((n) => typeof n !== 'string' || headerNameRefusal(n) !== null)
  )
    errors.add('constantHeaderNames', 'constantHeaderNames must be admitted header names');
  if (errors.any || spec === null || manifest === null) return { ok: false, errors: errors.list };
  const pkg: LearnedPackageV1 = Object.freeze({
    packageVersion: PACKAGE_VERSION,
    sourcePlatform: obj.sourcePlatform as string,
    contractVersion: CANONICAL_CONTRACT_VERSION,
    vocabularyVersion: VOCABULARY_VERSION,
    steps: Object.freeze(steps),
    unmapped: Object.freeze(unmapped),
    mappingSpec: spec,
    nativeRules: rules,
    manifest,
    constantHeaderNames: Object.freeze([...(obj.constantHeaderNames as string[])]),
  });
  const text = canonicalPackageJson(pkg);
  if (!text.ok) return text;
  return { ok: true, value: pkg };
}
