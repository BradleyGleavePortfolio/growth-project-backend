import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { CanonicalFamily, SourceMappingSpec } from '../reconstruct/mapping-spec';
import type { NativeRuleSet } from '../reconstruct/native/native-rules';
import type { InductionManifestV1 } from './contract';
import { mappingSpecDigest } from './digest';
import {
  isCanonicalFamily,
  listsVerifierBoundKind,
  parseInductionManifest,
  parseInductionManifestForRuntime,
} from './parse';

// S10-A — the induction package registry (D-S10-1 V1-V6). Loaded once, read-only, fail closed and
// loud like `source-mapper-registry.ts` and `native-rule-registry.ts`. The mapping specs and
// native rule sets are passed in (S10-B/C wires the existing loaders), so this module imports
// only landed types and never re-implements those loaders.

/**
 * `src/scout/induction/sources/<p>.json`, resolved beside this module (S10-D D1 adds the
 * `nest-cli.json` asset entry). ABSENT = empty registry; PRESENT but empty = misconfiguration.
 */
export const INDUCTION_MANIFESTS_DIR = join(__dirname, 'sources');

function byteOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * S12-B2 — TEST-ONLY artifacts (`testOnly` manifests, `test_only` verifiers) are allowed ONLY when
 * the runtime is explicitly development or test (trimmed, case-insensitive). Everything else,
 * including an unset or blank `NODE_ENV`, production, staging and unknown spellings, refuses them:
 * fail closed, so a deployable image that never sets `NODE_ENV` cannot trust a committed test key.
 */
export function testOnlyArtifactsAllowed(nodeEnv: string | undefined): boolean {
  const mode = (nodeEnv ?? '').trim().toLowerCase();
  return mode === 'development' || mode === 'test';
}

/**
 * Load and strictly validate every `*.json` manifest in byte-sorted filename order. With
 * `refuseTestOnly` (default: the runtime is not explicitly development/test) a TEST-ONLY manifest is
 * validated and then not loaded, and TEST-ONLY verifiers are dropped from the others.
 */
export function loadInductionManifests(
  dir: string = INDUCTION_MANIFESTS_DIR,
  refuseTestOnly: boolean = !testOnlyArtifactsAllowed(process.env.NODE_ENV),
): InductionManifestV1[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort(byteOrder);
  if (files.length === 0) {
    throw new Error(`induction manifest directory ${dir} is present but has no *.json manifest`);
  }
  const seen = new Set<string>();
  return files
    .map((name) => {
      const path = join(dir, name);
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(path, 'utf8'));
      } catch (err) {
        throw new Error(
          `induction manifest ${path} is not valid JSON: ${err instanceof Error ? err.message : 'parse error'}`,
        );
      }
      const manifest = parseInductionManifest(raw, path);
      if (name !== `${manifest.sourcePlatform}.json`) {
        throw new Error(
          `induction manifest ${path} must be named <sourcePlatform>.json (${manifest.sourcePlatform})`,
        );
      }
      if (seen.has(manifest.sourcePlatform)) {
        throw new Error(`duplicate induction manifest for ${manifest.sourcePlatform} (${path})`);
      }
      seen.add(manifest.sourcePlatform);
      return parseInductionManifestForRuntime(raw, path, refuseTestOnly);
    })
    .filter((manifest): manifest is InductionManifestV1 => manifest !== null);
}

/** One source's validated package: manifest plus the facts the evaluator binds to. */
export interface InductionPackage {
  readonly manifest: InductionManifestV1;
  /** sha256 of the loaded mapping spec's canonical JSON (E3 `mapping_spec_digest`). */
  readonly specDigest: string;
  /**
   * L3: the mapping spec's step keys per canonical family (`spec.steps` inverted, sorted). The
   * `replay_terminal_enumeration` rule requires a terminal for every step feeding the family.
   */
  readonly stepsByFamily: ReadonlyMap<CanonicalFamily, readonly string[]>;
}

export interface InductionRegistry {
  /** Platforms with a manifest. A platform without one is never provable (every family unknown). */
  readonly packages: ReadonlyMap<string, InductionPackage>;
  /** Every registered mapping spec's `families` keys, sorted (emitted families without a manifest). */
  readonly specFamilies: ReadonlyMap<string, readonly CanonicalFamily[]>;
}

export interface InductionRegistryInput {
  readonly manifests: readonly InductionManifestV1[];
  readonly specs: readonly SourceMappingSpec[];
  readonly nativeRuleSets: readonly NativeRuleSet[];
  /**
   * L3 r4 (`R589-c7B2-01`): refuse every manifest that lists a verifier-bound kind
   * (`source_signed_enumeration`) at THIS boundary, which every package passes — the file loader's
   * manifests, a run's pinned/learned package (`composeRunArtifacts` → `buildSourceRegistries`),
   * a partition (`partitionInductionRegistry`) and the proof workers alike. Default: the runtime
   * is not explicitly development/test (`testOnlyArtifactsAllowed`), read at build time. A
   * refused manifest is dropped, exactly as the loader drops it: its platform has no induction
   * package, every family is unknown (`package_missing`) and the run settles `partial`. Tests and
   * the S10/S11 harnesses pass `false` only through an allowing `NODE_ENV`.
   */
  readonly refuseVerifierBoundKinds?: boolean;
}

function familyKeys(families: object): CanonicalFamily[] {
  return Object.keys(families).filter(isCanonicalFamily).sort(byteOrder);
}

/** `spec.steps` inverted: family → its step keys, sorted bytewise (L3 replay step cross-check). */
export function stepsByFamily(
  spec: SourceMappingSpec,
): ReadonlyMap<CanonicalFamily, readonly string[]> {
  const out = new Map<CanonicalFamily, string[]>();
  for (const [step, family] of Object.entries(spec.steps)) {
    if (!isCanonicalFamily(family)) continue;
    const list = out.get(family) ?? [];
    list.push(step);
    out.set(family, list);
  }
  for (const list of out.values()) list.sort(byteOrder);
  return out;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Cross-check the three artifacts (V2, V3, V6) and build the registry. Throws on: a duplicate
 * spec, rule set or manifest; a manifest or rule set without exactly one spec; `expectedFamilies`
 * ≠ the spec's `families` keys; `nativeRules: 'declared'` without a loaded rule set (or `absent`
 * with one); rule-set families outside `expectedFamilies`.
 *
 * L3 r4 (`R589-c7B2-01`; executive reset 2026-09-29 §1, L0 r7 D-L0-6 "no package type — learned,
 * file/reviewed or legacy — has a run-level closure"): this is the ONE choke point every induction
 * package passes before the evaluator can see it, so the kind-level refusal of
 * `source_signed_enumeration` (the only kind that yields `known: true`, from which S9 settles
 * `complete`) is enforced HERE, not only in the file loader. In a refusing runtime a manifest
 * listing that kind for any family is validated (the cross-checks above still run on it) and then
 * dropped, marker or no marker, whichever path supplied it. `parseInductionManifestForRuntime`
 * in the loader stays as the earlier, redundant gate.
 */
export function buildInductionRegistry(input: InductionRegistryInput): InductionRegistry {
  const refuseVerifierBoundKinds =
    input.refuseVerifierBoundKinds ?? !testOnlyArtifactsAllowed(process.env.NODE_ENV);
  const specs = new Map<string, SourceMappingSpec>();
  for (const spec of input.specs) {
    if (specs.has(spec.sourcePlatform)) {
      throw new Error(`duplicate mapping spec for ${spec.sourcePlatform}`);
    }
    specs.set(spec.sourcePlatform, spec);
  }
  const ruleSets = new Map<string, NativeRuleSet>();
  for (const set of input.nativeRuleSets) {
    if (ruleSets.has(set.sourcePlatform)) {
      throw new Error(`duplicate native rule set for ${set.sourcePlatform}`);
    }
    if (!specs.has(set.sourcePlatform)) {
      throw new Error(`native rule set for ${set.sourcePlatform} has no mapping spec`);
    }
    ruleSets.set(set.sourcePlatform, set);
  }

  const specFamilies = new Map<string, readonly CanonicalFamily[]>();
  for (const [platform, spec] of specs) {
    specFamilies.set(platform, Object.freeze(familyKeys(spec.families)));
  }

  const packages = new Map<string, InductionPackage>();
  for (const manifest of input.manifests) {
    const platform = manifest.sourcePlatform;
    if (packages.has(platform)) throw new Error(`duplicate induction manifest for ${platform}`);
    const spec = specs.get(platform);
    if (spec === undefined) {
      throw new Error(`induction manifest for ${platform} has no mapping spec`);
    }
    const declared = specFamilies.get(platform) ?? [];
    if (!sameList(manifest.expectedFamilies, declared)) {
      throw new Error(
        `induction manifest for ${platform}: expectedFamilies must equal the mapping spec families (${declared.join(', ')})`,
      );
    }
    const ruleSet = ruleSets.get(platform);
    if ((manifest.nativeRules === 'declared') !== (ruleSet !== undefined)) {
      throw new Error(
        `induction manifest for ${platform}: nativeRules '${manifest.nativeRules}' contradicts the loaded native rule sets`,
      );
    }
    if (ruleSet !== undefined) {
      for (const family of familyKeys(ruleSet.families)) {
        if (!manifest.expectedFamilies.includes(family)) {
          throw new Error(
            `native rule set for ${platform}: family ${family} is not in expectedFamilies`,
          );
        }
      }
    }
    const specDigest = mappingSpecDigest(spec);
    if (specDigest === null) throw new Error(`mapping spec for ${platform} is not canonical JSON`);
    // L3 r4: after the cross-checks (a defective manifest still fails loudly), before the package
    // exists. Dropped, never composed: the platform is unprovable in this runtime.
    if (refuseVerifierBoundKinds && listsVerifierBoundKind(manifest)) continue;
    packages.set(
      platform,
      Object.freeze({ manifest, specDigest, stepsByFamily: stepsByFamily(spec) }),
    );
  }
  return Object.freeze({ packages, specFamilies });
}
