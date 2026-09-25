import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseNativeRuleSet, type NativeRuleSet } from './native-rules';

/**
 * Repository-resident native rule sets: `./sources/<platform>.json`, one per
 * source platform, loaded once at module load and validated strictly (a
 * malformed file is a loud error). The directory is resolved beside this module,
 * so when the first rule set lands the build must copy
 * `scout/reconstruct/native/sources/*.json` as an asset exactly like the S8-A
 * specs — that one-line `nest-cli.json` change is parent-owned and is reported,
 * not made here.
 *
 * Today no repository rule set exists: no real source has declared typed native
 * fields (TrueCoach's workout exercise payload shape is not established), so an
 * ABSENT directory is the truthful "no native rules declared" state and yields an
 * empty registry — every workout keeps its accepted evidence path and no native
 * row is ever guessed. A PRESENT directory must contain at least one valid
 * `.json` (an empty directory is a misconfiguration, fail closed like S8-A).
 */
export const NATIVE_RULES_DIR = join(__dirname, 'sources');

export function loadNativeRuleSets(dir: string = NATIVE_RULES_DIR): NativeRuleSet[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (files.length === 0)
    throw new Error(`native rules directory ${dir} is present but has no *.json rule set`);
  const seen = new Set<string>();
  return files.map((name) => {
    const path = join(dir, name);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      throw new Error(
        `native rule set ${path} is not valid JSON: ${err instanceof Error ? err.message : 'parse error'}`,
      );
    }
    const parsed = parseNativeRuleSet(raw, path);
    if (name !== `${parsed.sourcePlatform}.json`) {
      throw new Error(
        `native rule set ${path} must be named <sourcePlatform>.json (${parsed.sourcePlatform})`,
      );
    }
    if (seen.has(parsed.sourcePlatform))
      throw new Error(`duplicate native rule set for ${parsed.sourcePlatform}`);
    seen.add(parsed.sourcePlatform);
    return parsed;
  });
}

/** `source_platform` → rule set. Read-only after construction. */
export type NativeRuleRegistry = ReadonlyMap<string, NativeRuleSet>;

export function buildNativeRuleRegistry(
  ruleSets: readonly NativeRuleSet[] = loadNativeRuleSets(),
): NativeRuleRegistry {
  const registry = new Map<string, NativeRuleSet>();
  for (const set of ruleSets) {
    if (registry.has(set.sourcePlatform))
      throw new Error(`duplicate native rule set for ${set.sourcePlatform}`);
    registry.set(set.sourcePlatform, set);
  }
  return registry;
}
