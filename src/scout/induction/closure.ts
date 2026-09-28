import type { CanonicalFamily } from '../reconstruct/mapping-spec';
import {
  CLOSURE_CONFIRMABLE_REASONS,
  CLOSURE_EXCLUDED_TEMPLATE_KEYS,
  CLOSURE_EXCLUSION_REASONS,
  CLOSURE_MAPPED_TEMPLATE_KEYS,
  CLOSURE_MAX_TEMPLATES,
  CLOSURE_OBSERVED_KEYS,
  CLOSURE_REVIEWED_KEYS,
  CLOSURE_TEMPLATE_REF_PATTERN,
  EXCLUSION_SIGNAL_KEYS,
  type ClosureExclusionReason,
  type ExclusionSignalsV1,
  type FamilySetClosureTemplateV1,
  type FamilySetClosureV1,
} from './contract';
import type { InductionPackage, InductionRegistry } from './manifest-registry';
import { isCanonicalFamily } from './parse';

// L3 — family-set closure (owner D1, 2026-09-28: "complete" means "All past client and coaching
// records in this site are now in TGP"; L0 r2 D-L0-6.1 (i) with the T4 review defaults). A run
// may be `complete` only if its pinned package's closure record shows that discovery left
// nothing behind (no truncated digest, no refused collection, no unexplored navigation target or
// filter variant) and every observed collection template is either mapped or excluded by the
// deterministic out-of-scope rule. Any `unsupported_coaching_data`, `unknown` or unconfirmed
// exclusion forces `partial`. Pure and total: no I/O, no clock, no exceptions; every blocker is a
// named gap so the caller can record it. The AI's classification alone never closes a set: an
// exclusion counts only when the rule's structure-only signals (path AND key AND shape, no veto,
// a non-empty item shape) are re-derived here on every run — nothing stored says "confirmed".

/** Why the family set is not closed. Stable codes; a template ref, family or count names the gap. */
export type ClosureGapCode =
  | 'closure_unknown'
  | 'closure_platform_mismatch'
  | 'closure_spec_mismatch'
  | 'closure_malformed'
  | 'digest_truncated'
  | 'collection_refused'
  | 'target_unexplored'
  | 'variant_unexplored'
  | 'template_duplicated'
  | 'template_family_undeclared'
  | 'template_unsupported_coaching_data'
  | 'template_unknown'
  | 'template_exclusion_unconfirmed'
  | 'family_without_template';

export interface ClosureGap {
  readonly code: ClosureGapCode;
  readonly template_ref?: string;
  readonly family?: string;
  readonly count?: number;
  readonly reason?: ClosureExclusionReason;
  readonly signals?: ExclusionSignalsV1;
}

export type ClosureVerdict =
  | { readonly closed: true; readonly origin: FamilySetClosureV1['origin'] }
  | { readonly closed: false; readonly gaps: readonly ClosureGap[] };

/** The one closure record a repository (file) package carries: its reviewed spec. */
export function reviewedPackageClosure(
  platform: string,
  pkg: InductionPackage,
): FamilySetClosureV1 {
  return Object.freeze({
    closure_version: 1 as const,
    source_platform: platform,
    mapping_spec_digest: pkg.specDigest,
    origin: 'reviewed_package' as const,
  });
}

/**
 * Closure records for every FILE package of a registry (S10-C settle-time caller). A registry
 * composed with learned packages (L2) must NOT use this for them: a learned package's closure is
 * the `observed_templates` record of its pinned version, or `null` (unknown, blocks `complete`).
 */
export function reviewedPackageClosures(
  registry: InductionRegistry,
): readonly FamilySetClosureV1[] {
  const out: FamilySetClosureV1[] = [];
  for (const [platform, pkg] of registry.packages) out.push(reviewedPackageClosure(platform, pkg));
  return Object.freeze(out);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(record);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isClosureExclusionReason(value: unknown): value is ClosureExclusionReason {
  return (
    typeof value === 'string' && (CLOSURE_EXCLUSION_REASONS as readonly string[]).includes(value)
  );
}

function readSignals(raw: unknown): ExclusionSignalsV1 | null {
  if (!isRecord(raw) || !hasExactKeys(raw, EXCLUSION_SIGNAL_KEYS)) return null;
  for (const key of EXCLUSION_SIGNAL_KEYS) if (typeof raw[key] !== 'boolean') return null;
  return {
    path: raw.path === true,
    key: raw.key === true,
    shape: raw.shape === true,
    veto: raw.veto === true,
    empty_shape: raw.empty_shape === true,
  };
}

/**
 * The deterministic exclusion verdict, re-derived from structure-only signals on every run
 * (never read from storage): the claimed reason is confirmable, path AND key AND shape evidence
 * all hold, no veto (coaching vocabulary in path or keys, or an email/phone-like key) fired, and
 * the collection exposed a non-empty item shape.
 */
export function exclusionConfirmed(
  reason: ClosureExclusionReason,
  signals: ExclusionSignalsV1,
): boolean {
  return (
    CLOSURE_CONFIRMABLE_REASONS.includes(reason) &&
    signals.path &&
    signals.key &&
    signals.shape &&
    !signals.veto &&
    !signals.empty_shape
  );
}

function gap(code: ClosureGapCode, extra: Omit<ClosureGap, 'code'> = {}): ClosureGap {
  return Object.freeze({ code, ...extra });
}

/** A structurally valid template entry, or `null` (the caller names `closure_malformed`). */
function readTemplate(raw: unknown): FamilySetClosureTemplateV1 | null {
  if (!isRecord(raw)) return null;
  const ref = raw.template_ref;
  if (typeof ref !== 'string' || !CLOSURE_TEMPLATE_REF_PATTERN.test(ref)) return null;
  if (raw.disposition === 'mapped') {
    if (!hasExactKeys(raw, CLOSURE_MAPPED_TEMPLATE_KEYS)) return null;
    if (!isCanonicalFamily(raw.family) || !isCount(raw.unexplored_variants)) return null;
    return {
      template_ref: ref,
      disposition: 'mapped',
      family: raw.family,
      unexplored_variants: raw.unexplored_variants,
    };
  }
  if (raw.disposition === 'excluded') {
    if (!hasExactKeys(raw, CLOSURE_EXCLUDED_TEMPLATE_KEYS)) return null;
    if (!isClosureExclusionReason(raw.reason)) return null;
    const signals = readSignals(raw.signals);
    if (signals === null) return null;
    return { template_ref: ref, disposition: 'excluded', reason: raw.reason, signals };
  }
  return null;
}

/**
 * Evaluate one platform's closure record against its loaded package. `undefined`/`null` is not
 * known and never closed. A `reviewed_package` record is closed iff it binds to the package. An
 * `observed_templates` record is closed iff discovery left nothing behind (no truncated digest,
 * no refused collection, no unexplored target), every template is well-formed and unique, every
 * mapped template names a declared family and has no unexplored filter variant, every excluded
 * template is confirmed by the rule signals, and every declared family has at least one mapped
 * template. The record is read as untrusted data (it arrives through a typed input whose
 * producer is not this module), so a malformed value is a named gap, never a throw.
 */
export function evaluateFamilySetClosure(
  closure: FamilySetClosureV1 | null | undefined | unknown,
  platform: string,
  pkg: InductionPackage,
): ClosureVerdict {
  if (closure === null || closure === undefined || !isRecord(closure)) {
    return { closed: false, gaps: [gap('closure_unknown')] };
  }
  if (closure.closure_version !== 1) return { closed: false, gaps: [gap('closure_malformed')] };
  if (closure.source_platform !== platform) {
    return { closed: false, gaps: [gap('closure_platform_mismatch')] };
  }
  if (closure.mapping_spec_digest !== pkg.specDigest) {
    return { closed: false, gaps: [gap('closure_spec_mismatch')] };
  }
  if (closure.origin === 'reviewed_package') {
    return hasExactKeys(closure, CLOSURE_REVIEWED_KEYS)
      ? { closed: true, origin: 'reviewed_package' }
      : { closed: false, gaps: [gap('closure_malformed')] };
  }
  if (
    closure.origin !== 'observed_templates' ||
    !hasExactKeys(closure, CLOSURE_OBSERVED_KEYS) ||
    closure.rule_version !== 1 ||
    typeof closure.digest_truncated !== 'boolean' ||
    !isCount(closure.refused_collections) ||
    !isCount(closure.unexplored_targets) ||
    !Array.isArray(closure.templates)
  ) {
    return { closed: false, gaps: [gap('closure_malformed')] };
  }
  const templates: readonly unknown[] = closure.templates;
  if (templates.length > CLOSURE_MAX_TEMPLATES) {
    return { closed: false, gaps: [gap('closure_malformed')] };
  }

  const gaps: ClosureGap[] = [];
  // Discovery holes first: what the digest never contained cannot be closed by what it did.
  if (closure.digest_truncated) gaps.push(gap('digest_truncated'));
  if (closure.refused_collections > 0) {
    gaps.push(gap('collection_refused', { count: closure.refused_collections }));
  }
  if (closure.unexplored_targets > 0) {
    gaps.push(gap('target_unexplored', { count: closure.unexplored_targets }));
  }

  const seen = new Set<string>();
  const mappedFamilies = new Set<CanonicalFamily>();
  const declared: readonly CanonicalFamily[] = pkg.manifest.expectedFamilies;
  for (const raw of templates) {
    const template = readTemplate(raw);
    if (template === null) {
      gaps.push(gap('closure_malformed'));
      continue;
    }
    const template_ref = template.template_ref;
    if (seen.has(template_ref)) {
      gaps.push(gap('template_duplicated', { template_ref }));
      continue;
    }
    seen.add(template_ref);
    if (template.disposition === 'mapped') {
      if (!declared.includes(template.family)) {
        gaps.push(gap('template_family_undeclared', { template_ref, family: template.family }));
        continue;
      }
      if (template.unexplored_variants > 0) {
        gaps.push(gap('variant_unexplored', { template_ref, count: template.unexplored_variants }));
      }
      mappedFamilies.add(template.family);
      continue;
    }
    if (template.reason === 'unsupported_coaching_data') {
      gaps.push(gap('template_unsupported_coaching_data', { template_ref }));
    } else if (template.reason === 'unknown') {
      gaps.push(gap('template_unknown', { template_ref }));
    } else if (!exclusionConfirmed(template.reason, template.signals)) {
      gaps.push(
        gap('template_exclusion_unconfirmed', {
          template_ref,
          reason: template.reason,
          signals: template.signals,
        }),
      );
    }
  }
  for (const family of declared) {
    if (!mappedFamilies.has(family)) gaps.push(gap('family_without_template', { family }));
  }
  return gaps.length === 0
    ? { closed: true, origin: 'observed_templates' }
    : { closed: false, gaps };
}
