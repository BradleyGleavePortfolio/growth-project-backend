/**
 * prod-readiness/registry-loader.ts
 *
 * Single source of truth for the prod-switches.yml schema + load+validate.
 * Required by AGENT_RULES R108 — every env-var-shaped switch in the
 * codebase must have a row in prod-switches.yml.
 *
 * Validation rules:
 *   - YAML parses cleanly.
 *   - Top-level shape is { switches: SwitchEntry[] }.
 *   - Each entry has all required fields with valid enum values.
 *   - No duplicate `name` entries.
 *
 * This module is deliberately tiny and free of external runtime deps
 * other than `js-yaml` so it can run as the very first stage of the
 * deploy-readiness test (other stages may import this).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

export type SwitchTier = 'hard' | 'prod' | 'feature' | 'optional';
export type ProdDefault = 'MUST_SET' | 'ON' | 'OFF' | 'STUB_ALLOWED';

const TIERS: ReadonlySet<SwitchTier> = new Set(['hard', 'prod', 'feature', 'optional']);
const PROD_DEFAULTS: ReadonlySet<ProdDefault> = new Set(['MUST_SET', 'ON', 'OFF', 'STUB_ALLOWED']);

export interface SwitchEntry {
  name: string;
  tier: SwitchTier;
  prod_default: ProdDefault;
  auto_flip_on_in_prod: boolean;
  owner: string;
  description: string;
}

export interface RegistryLoadResult {
  switches: SwitchEntry[];
  byName: Map<string, SwitchEntry>;
  registryPath: string;
}

export class RegistryValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`prod-switches.yml validation failed:\n  - ${errors.join('\n  - ')}`);
    this.name = 'RegistryValidationError';
  }
}

export function defaultRegistryPath(repoRoot: string = process.cwd()): string {
  return path.join(repoRoot, 'prod-switches.yml');
}

export function loadRegistry(registryPath: string = defaultRegistryPath()): RegistryLoadResult {
  if (!fs.existsSync(registryPath)) {
    throw new RegistryValidationError([`Registry file does not exist at ${registryPath}`]);
  }
  const raw = fs.readFileSync(registryPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    throw new RegistryValidationError([
      `YAML parse error: ${(err as Error).message}`,
    ]);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as Record<string, unknown>).switches)) {
    throw new RegistryValidationError([
      "Top-level shape must be { switches: SwitchEntry[] }",
    ]);
  }
  const rawSwitches = (parsed as { switches: unknown[] }).switches;
  const errors: string[] = [];
  const switches: SwitchEntry[] = [];
  const byName = new Map<string, SwitchEntry>();
  rawSwitches.forEach((raw, idx) => {
    const validated = validateEntry(raw, idx);
    if ('error' in validated) {
      errors.push(validated.error);
      return;
    }
    const entry = validated.entry;
    if (byName.has(entry.name)) {
      errors.push(`switches[${idx}] (${entry.name}): duplicate name; first defined earlier in the file.`);
      return;
    }
    byName.set(entry.name, entry);
    switches.push(entry);
  });
  if (errors.length) throw new RegistryValidationError(errors);
  return { switches, byName, registryPath };
}

function validateEntry(raw: unknown, idx: number): { entry: SwitchEntry } | { error: string } {
  if (!raw || typeof raw !== 'object') {
    return { error: `switches[${idx}]: must be an object` };
  }
  const r = raw as Record<string, unknown>;
  const issues: string[] = [];
  if (typeof r.name !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(r.name)) {
    issues.push('name must be SCREAMING_SNAKE_CASE');
  }
  if (typeof r.tier !== 'string' || !TIERS.has(r.tier as SwitchTier)) {
    issues.push(`tier must be one of ${[...TIERS].join('|')}`);
  }
  if (typeof r.prod_default !== 'string' || !PROD_DEFAULTS.has(r.prod_default as ProdDefault)) {
    issues.push(`prod_default must be one of ${[...PROD_DEFAULTS].join('|')}`);
  }
  if (typeof r.auto_flip_on_in_prod !== 'boolean') {
    issues.push('auto_flip_on_in_prod must be boolean');
  }
  if (typeof r.owner !== 'string' || r.owner.length === 0) {
    issues.push('owner must be a non-empty string');
  }
  if (typeof r.description !== 'string') {
    issues.push('description must be a string');
  }
  if (issues.length) {
    return { error: `switches[${idx}] (${typeof r.name === 'string' ? r.name : '<no-name>'}): ${issues.join('; ')}` };
  }
  return {
    entry: {
      name: r.name as string,
      tier: r.tier as SwitchTier,
      prod_default: r.prod_default as ProdDefault,
      auto_flip_on_in_prod: r.auto_flip_on_in_prod as boolean,
      owner: r.owner as string,
      description: r.description as string,
    },
  };
}
