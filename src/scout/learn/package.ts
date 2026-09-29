import { createHash } from 'crypto';
import type { SourceMappingSpec } from '../reconstruct/mapping-spec';
import type { NativeRuleSet } from '../reconstruct/native/native-rules';
import type { InductionManifestV1 } from '../induction/contract';
import { canonicalJson } from '../induction/digest';
import { parseInductionManifest } from '../induction/parse';
import { buildInductionRegistry } from '../induction/manifest-registry';
import { parseSourceMappingSpec } from '../reconstruct/mapping-spec';
import { parseNativeRuleSet } from '../reconstruct/native/native-rules';
import { isCanonicalPlatform } from '../scout-platform';
import {
  DIGEST_METHODS,
  DISCOVERED_BY,
  Errors,
  asObject,
  checkKeys,
  identityMatches,
  isWellFormedTemplate,
  keyPathGrowth,
  structureKeyMatches,
  structureKeyOf,
  structureKeyString,
  templateSegments,
  utf8Bytes,
  type DigestMethod,
  type DiscoveredBy,
  type LearnParseResult,
  type StructureDigestV1,
  type StructureKey,
} from './digest-contract';
import {
  headerNameRefusal,
  keyGrammarRefusal,
  originTemplateRefusal,
  pathLiteralRefusal,
} from './admission';
import { VOCABULARY_VERSION, mutatingTokenRefusal } from './contract-vocabulary';
import { CANONICAL_CONTRACT_VERSION, contractHash, isMappedFamily } from './canonical-contract';
import {
  PROPOSAL_MAX_STEPS,
  PROPOSAL_VERSION,
  UNMAPPED_REASONS,
  copyStep,
  deriveInductionManifest,
  scanStrings,
  stepJsonSchema,
  validateLearnedProposal,
  type LearnedProposalV1,
  type ProposalStep,
  type UnmappedReason,
  type ValidatedProposal,
} from './proposal';
import { validateSchema } from './schema';

/**
 * L1 (D-L0-4 "The package stores steps by structure key", D-L0-5, V-L9; r2 review round) —
 * `LearnedPackageV1` (grammar version 2): what per-coach memory stores and the SAME coach's later
 * runs reuse (V1; cross-coach reuse is a later slice and nothing here assumes a global row).
 *
 * - Steps are keyed by the STRUCTURE KEY `(originTemplate, method, slotted template, required
 *   keyPaths)` — never by ref (refs are per digest) and never by a shape signature (R591-B-B3).
 * - The grammar has no field that can hold a source value: no header value, slot value, query
 *   value, path literal outside the vocabulary, hostname or enum literal.
 * - `contractHash` is pinned (R591-B-C5): a package learned under another contract is refused.
 * - The READER is not authoritative (R591-A-03, R591-B-B1): `parseLearnedPackage` re-runs every
 *   validator a digest is not needed for (grammar fragment, string scan, V-L2/V-L3 interpreters,
 *   V-L4 coherence, forEach/parentEdge order, manifest == derived, V-L7 registry), and
 *   `applyLearnedPackage` re-runs V-L4…V-L10 against the CURRENT digest (D-L0-3 step 3, match
 *   mode) before a stored package may drive anything. A row that fails either is refused.
 */

export const PACKAGE_VERSION = 2 as const;
/** V-L9: canonical JSON of one package ≤ 64 KiB. */
export const PACKAGE_MAX_BYTES = 64 * 1024;

export interface PackageStep {
  readonly key: StructureKey;
  readonly discoveredBy: DiscoveredBy;
  readonly step: Omit<ProposalStep, 'templateRef'>;
}

export interface PackageUnmapped {
  readonly key: StructureKey;
  readonly reason: UnmappedReason;
}

export interface LearnedPackageV1 {
  readonly packageVersion: typeof PACKAGE_VERSION;
  readonly sourcePlatform: string;
  readonly contractVersion: typeof CANONICAL_CONTRACT_VERSION;
  readonly vocabularyVersion: typeof VOCABULARY_VERSION;
  readonly contractHash: string;
  /** The origin TEMPLATES the steps bind to (slot rule); the device confines requests to them. */
  readonly origins: readonly string[];
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
  'contractHash',
  'origins',
  'steps',
  'unmapped',
  'mappingSpec',
  'nativeRules',
  'manifest',
  'constantHeaderNames',
] as const;
const KEY_KEYS = ['origin', 'method', 'template', 'keyPaths'] as const;
const STEP_KEYS = ['key', 'discoveredBy', 'step'] as const;
const KEY_PATH_PATTERN = /^(\[\]|[^.[\]]+)(\.(\[\]|[^.[\]]+)|\[\])*$/;

function keyPathRefusal(path: string): string | null {
  if (!KEY_PATH_PATTERN.test(path)) return 'malformed key path';
  for (const part of path.split('.')) {
    const name = part.endsWith('[]') ? part.slice(0, -2) : part;
    if (name === '') continue;
    const refusal = keyGrammarRefusal(name);
    if (refusal !== null) return refusal;
  }
  return null;
}

function parseKey(raw: unknown, where: string, errors: Errors): StructureKey | null {
  const obj = asObject(raw);
  if (obj === null || !checkKeys(obj, KEY_KEYS, KEY_KEYS, where, errors)) return null;
  let ok = true;
  if (typeof obj.origin !== 'string' || originTemplateRefusal(obj.origin) !== null) {
    errors.add(`${where}.origin`, 'origin must be a host template under the slot rule');
    ok = false;
  }
  if (!(DIGEST_METHODS as readonly unknown[]).includes(obj.method)) {
    errors.add(`${where}.method`, 'method must be GET or HEAD');
    ok = false;
  }
  if (
    typeof obj.template !== 'string' ||
    !isWellFormedTemplate(obj.template) ||
    templateSegments(obj.template).some((s) => !/^:[ps]/.test(s) && pathLiteralRefusal(s) !== null)
  ) {
    errors.add(`${where}.template`, 'template must be slotted with vocabulary literals only');
    ok = false;
  }
  const paths = obj.keyPaths;
  if (
    !Array.isArray(paths) ||
    paths.length > 1024 ||
    paths.some((p) => typeof p !== 'string' || keyPathRefusal(p) !== null) ||
    paths.some((p, i) => i > 0 && !(paths[i - 1] < p))
  ) {
    errors.add(`${where}.keyPaths`, 'keyPaths must be sorted distinct admitted key paths');
    ok = false;
  }
  if (!ok) return null;
  return Object.freeze({
    origin: obj.origin as string,
    method: obj.method as DigestMethod,
    template: obj.template as string,
    keyPaths: Object.freeze([...(paths as string[])]),
  });
}

function stripRef(step: ProposalStep): Omit<ProposalStep, 'templateRef'> {
  const { templateRef: _ref, ...rest } = step;
  return Object.freeze(rest);
}

/** Build the package from a fully validated proposal (V-L2…V-L10 passed). Pure. */
export function buildLearnedPackage(validated: ValidatedProposal): LearnedPackageV1 {
  const origins = new Set<string>();
  for (const v of validated.steps) origins.add(v.structureKey.origin);
  return Object.freeze({
    packageVersion: PACKAGE_VERSION,
    sourcePlatform: validated.mappingSpec.sourcePlatform,
    contractVersion: CANONICAL_CONTRACT_VERSION,
    vocabularyVersion: VOCABULARY_VERSION,
    contractHash: contractHash(),
    origins: Object.freeze([...origins].sort()),
    steps: Object.freeze(
      validated.steps.map((v) =>
        Object.freeze({
          key: v.structureKey,
          discoveredBy: v.template.discoveredBy,
          step: stripRef(v.step),
        }),
      ),
    ),
    unmapped: Object.freeze(
      validated.unmapped.map((u) => Object.freeze({ key: u.structureKey, reason: u.reason })),
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

/** The structure keys of the package's steps (the round-2 union rule input, V-L10). */
export function packageStepKeys(pkg: LearnedPackageV1): readonly StructureKey[] {
  return Object.freeze(pkg.steps.map((s) => s.key));
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : 'parse error';
}

/**
 * Strict parser for a STORED package (L2 reads rows back through this; a corrupted or hostile row
 * never reaches the registry). Re-runs: strict keys; versions and the pinned `contractHash`;
 * the string scan (no scheme, `@`, digit run or control char anywhere); the step grammar
 * fragment of `proposalJsonSchema()`; the landed interpreters (V-L2/V-L3); V-L4 coherence with
 * the spec; forEach/parentEdge/idScope order rules; `manifest` byte-equal to the derived
 * manifest; V-L7 (`buildInductionRegistry`). What it cannot check without a digest
 * (V-L5/V-L6/V-L10) is `applyLearnedPackage`'s job — the parsed value is not yet applicable.
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
  // Every string but the pinned hash: no scheme, `@`, digit run or control character anywhere.
  const { contractHash: storedHash, ...scannable } = obj;
  scanStrings(scannable, '$', errors);
  if (typeof storedHash !== 'string' || !/^[0-9a-f]{64}$/.test(storedHash))
    errors.add('contractHash', 'contractHash must be a sha256 hex digest');
  if (obj.packageVersion !== PACKAGE_VERSION)
    errors.add('packageVersion', `packageVersion must be ${PACKAGE_VERSION}`);
  if (obj.contractVersion !== CANONICAL_CONTRACT_VERSION)
    errors.add('contractVersion', 'contractVersion differs from the live contract');
  if (obj.vocabularyVersion !== VOCABULARY_VERSION)
    errors.add('vocabularyVersion', 'vocabularyVersion differs from the live vocabulary');
  else if (storedHash !== contractHash())
    errors.add('contractHash', 'package was learned under another contract');
  if (!isCanonicalPlatform(obj.sourcePlatform))
    errors.add('sourcePlatform', 'not a canonical slug');
  if (
    !Array.isArray(obj.origins) ||
    obj.origins.length > 8 ||
    obj.origins.some((o) => typeof o !== 'string' || originTemplateRefusal(o) !== null) ||
    obj.origins.some((o, i) => i > 0 && !((obj.origins as string[])[i - 1] < o))
  )
    errors.add('origins', 'origins must be sorted distinct host templates under the slot rule');
  const originSet = new Set(Array.isArray(obj.origins) ? (obj.origins as unknown[]) : []);

  let spec: SourceMappingSpec | null = null;
  try {
    spec = parseSourceMappingSpec(obj.mappingSpec, 'learn:package');
    if (spec.sourcePlatform !== obj.sourcePlatform) errors.add('mappingSpec', 'slug mismatch');
  } catch (err) {
    errors.add('mappingSpec', message(err), 'V-L2');
  }
  let rules: NativeRuleSet | null = null;
  if (obj.nativeRules !== null) {
    try {
      rules = parseNativeRuleSet(obj.nativeRules, 'learn:package');
      if (rules.sourcePlatform !== obj.sourcePlatform) errors.add('nativeRules', 'slug mismatch');
    } catch (err) {
      errors.add('nativeRules', message(err), 'V-L3');
    }
  }
  // The manifest is DERIVED (D-L0-4): a stored one is accepted only if byte-equal to what the
  // stored spec and rules derive (so no verifier, basis kind or family can be smuggled in), and
  // V-L7 runs the landed registry over it.
  let manifest: InductionManifestV1 | null = null;
  if (spec !== null && !errors.any) {
    const derived = deriveInductionManifest(spec, rules);
    if (canonicalJson(obj.manifest) !== canonicalJson(derived)) {
      errors.add(
        'manifest',
        'stored manifest differs from the manifest derived from spec and rules',
      );
    } else {
      try {
        manifest = parseInductionManifest(obj.manifest, 'learn:package');
        buildInductionRegistry({
          manifests: [manifest],
          specs: [spec],
          nativeRuleSets: rules === null ? [] : [rules],
        });
      } catch (err) {
        manifest = null;
        errors.add('manifest', message(err), 'V-L7');
      }
    }
  }

  const steps: PackageStep[] = [];
  const stepSchema = stepJsonSchema();
  if (!Array.isArray(obj.steps) || obj.steps.length > PROPOSAL_MAX_STEPS) {
    errors.add('steps', `steps must be a list of at most ${PROPOSAL_MAX_STEPS}`);
  } else {
    const keyStrings = new Set<string>();
    obj.steps.forEach((s, i) => {
      const where = `steps[${i}]`;
      const entry = asObject(s);
      if (entry === null || !checkKeys(entry, STEP_KEYS, STEP_KEYS, where, errors)) return;
      const key = parseKey(entry.key, `${where}.key`, errors);
      if (key !== null) {
        const text = structureKeyString(key);
        if (keyStrings.has(text)) errors.add(`${where}.key`, 'duplicate structure key');
        keyStrings.add(text);
        if (!originSet.has(key.origin))
          errors.add(`${where}.key.origin`, 'step origin is not a package origin');
        // A stored step on a mutating template never drives a request (D-L0-6.2, V-L5).
        const mutating = mutatingTokenRefusal(templateSegments(key.template), []);
        if (mutating !== null) errors.add(`${where}.key.template`, mutating, 'V-L5');
      }
      if (!(DISCOVERED_BY as readonly unknown[]).includes(entry.discoveredBy))
        errors.add(`${where}.discoveredBy`, 'discoveredBy must be landing|explore');
      const stepObj = asObject(entry.step);
      if (stepObj === null) {
        errors.add(`${where}.step`, 'step must be an object');
        return;
      }
      // The stored step is the proposal step minus its per-digest ref: re-run the grammar.
      const fragmentErrors = validateSchema(stepSchema, { ...stepObj, templateRef: 't0' });
      for (const e of fragmentErrors)
        errors.add(`${where}.step${e.path.replace(/^\$/, '')}`, e.detail, 'V-L1');
      if (Object.prototype.hasOwnProperty.call(stepObj, 'templateRef'))
        errors.add(`${where}.step.templateRef`, 'a stored step has no ref');
      if (key === null || fragmentErrors.length > 0) return;
      steps.push(
        Object.freeze({
          key,
          discoveredBy: entry.discoveredBy as DiscoveredBy,
          step: stripRef(copyStep({ ...stepObj, templateRef: 't0' })),
        }),
      );
    });
    // Coherence without a digest (the V-L4/V-L5 order rules).
    if (spec !== null && steps.length === obj.steps.length) {
      const types = steps.map((s) => s.step.entityType);
      if (new Set(types).size !== types.length) errors.add('steps', 'duplicate entityType', 'V-L4');
      const mapped = new Set<string>();
      steps.forEach((s, i) => {
        const where = `steps[${i}].step`;
        const inSpec = Object.prototype.hasOwnProperty.call(spec.steps, s.step.entityType);
        if (isMappedFamily(s.step.family)) {
          mapped.add(s.step.entityType);
          if (!inSpec || spec.steps[s.step.entityType] !== s.step.family)
            errors.add(`${where}.family`, 'step family disagrees with mappingSpec.steps', 'V-L4');
        } else if (inSpec) {
          errors.add(`${where}.family`, 'classification-only family in mappingSpec.steps', 'V-L4');
        }
        if (s.step.forEach !== undefined) {
          const source = steps.findIndex((o) => o.step.collectAs === s.step.forEach);
          if (source < 0 || source >= i)
            errors.add(`${where}.forEach`, 'forEach must name an earlier step collectAs', 'V-L5');
          if (s.step.idScope === undefined)
            errors.add(`${where}.idScope`, 'a forEach step must state idScope', 'V-L5');
        }
        if (s.step.parentEdge !== undefined) {
          const target = types.indexOf(s.step.parentEdge.toStep);
          if (target < 0 || target >= i)
            errors.add(
              `${where}.parentEdge.toStep`,
              'parentEdge.toStep must be an earlier step',
              'V-L5',
            );
        }
      });
      for (const type of Object.keys(spec.steps))
        if (!mapped.has(type))
          errors.add(`mappingSpec.steps.${type}`, 'spec step has no package step', 'V-L4');
    }
  }

  const unmapped: PackageUnmapped[] = [];
  if (!Array.isArray(obj.unmapped) || obj.unmapped.length > 64) {
    errors.add('unmapped', 'unmapped must be a list of at most 64');
  } else {
    obj.unmapped.forEach((u, i) => {
      const where = `unmapped[${i}]`;
      const entry = asObject(u);
      if (entry === null || !checkKeys(entry, ['key', 'reason'], ['key', 'reason'], where, errors))
        return;
      const key = parseKey(entry.key, `${where}.key`, errors);
      if (!(UNMAPPED_REASONS as readonly unknown[]).includes(entry.reason)) {
        errors.add(`${where}.reason`, 'unknown unmapped reason');
        return;
      }
      if (key !== null)
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
    contractHash: obj.contractHash as string,
    origins: Object.freeze([...(obj.origins as string[])]),
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

export interface PackageApplication {
  /** V-L2…V-L10 over the reconstructed proposal and THIS digest (match mode). */
  readonly validated: ValidatedProposal;
  /**
   * Package steps whose IDENTITY no collection template of this digest shows: `template_absent`
   * (D-L0-3) — round 1: explore targets; round 2: zero requests, gap `template_absent`, never a
   * refusal.
   */
  readonly absentSteps: readonly PackageStep[];
  /**
   * Admitted key paths this digest shows beyond the matched package entries (D-L0-3 key-path
   * growth): recorded on the pin as `keypath_growth`, an audit drift signal, never a trigger.
   */
  readonly keypathGrowth: number;
}

export interface PackageApplicationContext {
  readonly slug: string;
  /** Round 2 only (mandatory then): the round-1 pin's step keys (`packageStepKeys`). */
  readonly round1StepKeys?: readonly StructureKey[];
}

/**
 * D-L0-3 step 3 (memory match) and round-2 step (iii) — apply a parsed package to the CURRENT
 * digest: every collection template of the digest must be covered by exactly one package step or
 * unmapped entry BY IDENTITY (`(origin, method, template)`; r7). A sparser digest (fewer key
 * paths) and key-path growth (more) both match: growth binds nothing and is counted. When several
 * entries share an identity the one whose key paths include the digest's is taken. The
 * reconstructed proposal must pass V-L2…V-L10 in match mode. A digest template no entry covers is
 * a miss (`package_uncovered`); a package step absent from the digest is not a miss — it is
 * returned as `absentSteps` (`template_absent`). Nothing stored is trusted past this point: the
 * digest, not the row, decides.
 */
export function applyLearnedPackage(
  pkg: LearnedPackageV1,
  digest: StructureDigestV1,
  context: PackageApplicationContext,
): LearnParseResult<PackageApplication> {
  const errors = new Errors('V-L10');
  if (pkg.sourcePlatform !== context.slug) {
    errors.add('package.sourcePlatform', 'package slug differs from the run slug');
    return { ok: false, errors: errors.list };
  }
  const steps: ProposalStep[] = [];
  const unmapped: { templateRef: string; reason: UnmappedReason }[] = [];
  const used = new Set<number>();
  let growth = 0;
  type Hit = {
    readonly key: StructureKey;
    readonly index: number;
    readonly kind: 'step' | 'unmapped';
  };
  for (const template of digest.templates) {
    if (template.role !== 'collection') continue;
    const key = structureKeyOf(digest, template);
    let hits: Hit[] = [
      ...pkg.steps.map((s, i): Hit => ({ key: s.key, index: i, kind: 'step' })),
      ...pkg.unmapped.map((u, i): Hit => ({ key: u.key, index: i, kind: 'unmapped' })),
    ].filter((h) => identityMatches(h.key, key));
    if (hits.length > 1) {
      // several entries share the identity (a `:q` variant recorded later, a re-learn): the one
      // whose recorded key paths include this digest's and are closest to it wins; a tie refuses
      const including = hits.filter((h) => structureKeyMatches(h.key, key));
      const distance = (h: Hit): number => h.key.keyPaths.length - key.keyPaths.length;
      const best = Math.min(...including.map(distance));
      hits = including.filter((h) => distance(h) === best);
    }
    if (hits.length !== 1) {
      errors.add(
        `digest.templates.${template.ref}`,
        hits.length === 0
          ? 'no package step or unmapped entry covers this collection template'
          : 'more than one package entry covers this collection template',
      );
      continue;
    }
    const [hit] = hits;
    growth += keyPathGrowth(hit.key, key);
    if (hit.kind === 'step') {
      used.add(hit.index);
      steps.push(Object.freeze({ templateRef: template.ref, ...pkg.steps[hit.index].step }));
    } else {
      unmapped.push({ templateRef: template.ref, reason: pkg.unmapped[hit.index].reason });
    }
  }
  if (errors.any) return { ok: false, errors: errors.list };
  // Steps are ordered as stored (forEach/parentEdge order is positional).
  const order = new Map(pkg.steps.map((s, i) => [s.step.entityType, i]));
  steps.sort((a, b) => (order.get(a.entityType) ?? 0) - (order.get(b.entityType) ?? 0));
  const absentSteps = pkg.steps.filter((_, i) => !used.has(i));
  // An absent step may leave a spec step without a proposal step; match mode accepts that (the
  // step is an explore target in round 1 and `template_absent` in round 2 — the caller decides
  // with `absentSteps`).
  const proposal: LearnedProposalV1 = Object.freeze({
    proposalVersion: PROPOSAL_VERSION,
    steps: Object.freeze(steps),
    mappingSpec: pkg.mappingSpec,
    nativeRules: pkg.nativeRules,
    unmapped: Object.freeze(unmapped.map((u) => Object.freeze(u))),
    explore: Object.freeze([]),
    rationale: '',
  });
  const validated = validateLearnedProposal(proposal, digest, {
    slug: context.slug,
    mode: 'match',
    ...(context.round1StepKeys === undefined ? {} : { round1StepKeys: context.round1StepKeys }),
  });
  if (!validated.ok) return validated;
  return {
    ok: true,
    value: Object.freeze({
      validated: validated.value,
      absentSteps: Object.freeze(absentSteps),
      keypathGrowth: growth,
    }),
  };
}
