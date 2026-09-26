import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { CanonicalFamily, SourceMappingSpec } from '../reconstruct/mapping-spec';
import type { NativeRuleSet } from '../reconstruct/native/native-rules';
import type { InductionManifestV1 } from './contract';
import { mappingSpecDigest } from './digest';
import { isCanonicalFamily, parseInductionManifest } from './parse';

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

/** Load and strictly validate every `*.json` manifest in byte-sorted filename order. */
export function loadInductionManifests(
  dir: string = INDUCTION_MANIFESTS_DIR,
): InductionManifestV1[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort(byteOrder);
  if (files.length === 0) {
    throw new Error(`induction manifest directory ${dir} is present but has no *.json manifest`);
  }
  const seen = new Set<string>();
  return files.map((name) => {
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
    return manifest;
  });
}

/** One source's validated package: manifest plus the facts the evaluator binds to. */
export interface InductionPackage {
  readonly manifest: InductionManifestV1;
  /** sha256 of the loaded mapping spec's canonical JSON (E3 `mapping_spec_digest`). */
  readonly specDigest: string;
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
}

function familyKeys(families: object): CanonicalFamily[] {
  return Object.keys(families).filter(isCanonicalFamily).sort(byteOrder);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Cross-check the three artifacts (V2, V3, V6) and build the registry. Throws on: a duplicate
 * spec, rule set or manifest; a manifest or rule set without exactly one spec; `expectedFamilies`
 * ≠ the spec's `families` keys; `nativeRules: 'declared'` without a loaded rule set (or `absent`
 * with one); rule-set families outside `expectedFamilies`.
 */
export function buildInductionRegistry(input: InductionRegistryInput): InductionRegistry {
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
    packages.set(platform, Object.freeze({ manifest, specDigest }));
  }
  return Object.freeze({ packages, specFamilies });
}
