// registry-loader.ts — zod-validated loader for prod-switches.yml, the single
// source of truth for every env-var-shaped switch in the codebase (R108).
// Parses the YAML, validates each row against a schema, and exposes pure
// query/validation helpers consumed by H4.B (env-discovery) and H4.F
// (auto-flipper). Field semantics mirror the header block in the YAML:
//   tier: hard|prod|feature|optional · prod_default: MUST_SET|ON|OFF|STUB_ALLOWED
//   auto_flip_on_in_prod: bool · owner: domain group ("unowned" until claimed)
// CLI: ts-node test/prod-readiness/registry-loader.ts --validate

import { readFile } from 'node:fs/promises';
import { load as parseYaml } from 'js-yaml';
import { z } from 'zod';

export const TIERS = ['hard', 'prod', 'feature', 'optional'] as const;
export type Tier = (typeof TIERS)[number];
export const PROD_DEFAULTS = ['MUST_SET', 'ON', 'OFF', 'STUB_ALLOWED'] as const;
export type ProdDefault = (typeof PROD_DEFAULTS)[number];
/** Sentinel owner value for rows not yet claimed by a domain. */
export const UNOWNED = 'unowned';

export const RegistryRowSchema = z
  .object({
    name: z.string().min(1).regex(/^[A-Z][A-Z0-9_]*$/, 'env name must be UPPER_SNAKE_CASE'),
    tier: z.enum(TIERS),
    prod_default: z.enum(PROD_DEFAULTS),
    auto_flip_on_in_prod: z.boolean(),
    owner: z.string().min(1),
    description: z.string().min(1),
  })
  .strict();
export type RegistryRow = z.infer<typeof RegistryRowSchema>;

export const RegistrySchema = z.object({ switches: z.array(RegistryRowSchema) }).strict();
export type Registry = z.infer<typeof RegistrySchema>;
/** Read, parse, and validate the registry at `path`. */
export async function loadRegistry(path: string): Promise<Registry> {
  return parseRegistry(await readFile(path, 'utf8'));
}

/** Parse + validate registry contents already in memory (FS-free). */
export function parseRegistry(raw: string): Registry {
  if (raw.trim().length === 0) {
    throw new Error('registry is empty: expected a top-level `switches:` array');
  }
  const parsed: unknown = parseYaml(raw);
  return RegistrySchema.parse(parsed);
}

export type FindingKind = 'unowned' | 'must-set-but-auto-flip' | 'duplicate-name';
export interface ValidationFinding {
  kind: FindingKind;
  name: string;
  severity: 'error' | 'warn';
}
export interface ValidationReport {
  /** true when there are zero `error`-severity findings. */
  ok: boolean;
  findings: ValidationFinding[];
}

/** Findings of `error` severity only. */
export function errorFindings(report: ValidationReport): ValidationFinding[] {
  return report.findings.filter((f) => f.severity === 'error');
}

/**
 * Cross-row coherence checks beyond per-row schema validation:
 *   owner === "unowned"                          → unowned (warn, tolerated)
 *   prod_default MUST_SET + auto_flip_on_in_prod → must-set-but-auto-flip (error)
 *   duplicate `name`                             → duplicate-name (error)
 */
export function validateRegistry(reg: Registry): ValidationReport {
  const findings: ValidationFinding[] = [];
  const seen = new Set<string>();
  for (const row of reg.switches) {
    if (row.owner === UNOWNED) {
      findings.push({ kind: 'unowned', name: row.name, severity: 'warn' });
    }
    if (row.prod_default === 'MUST_SET' && row.auto_flip_on_in_prod) {
      findings.push({ kind: 'must-set-but-auto-flip', name: row.name, severity: 'error' });
    }
    if (seen.has(row.name)) {
      findings.push({ kind: 'duplicate-name', name: row.name, severity: 'error' });
    }
    seen.add(row.name);
  }
  return { ok: findings.every((f) => f.severity !== 'error'), findings };
}

/** All rows owned by `owner` (exact match). */
export function getByOwner(reg: Registry, owner: string): RegistryRow[] {
  return reg.switches.filter((r) => r.owner === owner);
}

/** All rows that must be set in prod (prod_default === "MUST_SET"). */
export function getProdRequired(reg: Registry): RegistryRow[] {
  return reg.switches.filter((r) => r.prod_default === 'MUST_SET');
}

/** All rows still flagged as unowned. */
export function getUnowned(reg: Registry): RegistryRow[] {
  return reg.switches.filter((r) => r.owner === UNOWNED);
}

/** All rows the readiness test should auto-flip on against a prod environment. */
export function getAutoFlip(reg: Registry): RegistryRow[] {
  return reg.switches.filter((r) => r.auto_flip_on_in_prod);
}

/** Sorted list of distinct owners present in the registry. */
export function listOwners(reg: Registry): string[] {
  return Array.from(new Set(reg.switches.map((r) => r.owner))).sort();
}

if (require.main === module) {
  loadRegistry('prod-switches.yml')
    .then((reg) => {
      const errors = errorFindings(validateRegistry(reg));
      if (errors.length > 0) {
        console.error('Registry validation failed:', JSON.stringify(errors, null, 2));
        process.exit(1);
      }
      console.log(`Registry OK — ${reg.switches.length} switches.`);
    })
    .catch((err: unknown) => {
      console.error('Registry load failed:', err);
      process.exit(1);
    });
}
