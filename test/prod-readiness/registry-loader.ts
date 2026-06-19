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

/**
 * Minimum row count enforced by the schema. The seeded registry currently lists
 * 223 prod-touching env switches; 200 is a safe floor that catches an accidental
 * truncation or a regenerated-empty registry (a guardrail bypass) while leaving
 * head-room for the registry to grow or shrink over time.
 */
export const MIN_SWITCHES = 200;
export const RegistrySchema = z
  .object({
    switches: z
      .array(RegistryRowSchema)
      .min(
        MIN_SWITCHES,
        `production-readiness registry must list every prod-touching env switch (currently >${MIN_SWITCHES}); an empty or truncated registry is a guardrail bypass`,
      ),
  })
  .strict();
export type Registry = z.infer<typeof RegistrySchema>;

/** Raised when the raw YAML uses constructs banned for diff-reviewability. */
export class RegistryParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryParseError';
  }
}

/**
 * Reject YAML anchors (`&name`), aliases (`*name`), and merge keys (`<<:`) so
 * every switch row stays self-contained and reviewable by diff. Anchors/aliases
 * let a row inherit defaults from elsewhere in the file, hiding production
 * behaviour from a line-by-line review. Scans line-by-line, ignoring `#`
 * comments and the contents of single/double-quoted strings.
 */
export function assertNoYamlIndirection(raw: string): void {
  const code = raw.split(/\r?\n/).map(stripCommentsAndStrings);
  // Merge keys first: a `<<:` line is the clearest signal and is usually paired
  // with an anchor define elsewhere, so report it specifically rather than as a
  // generic anchor hit.
  const mergeLine = code.findIndex((line) => /^\s*<<\s*:/.test(line));
  if (mergeLine !== -1) {
    throw new RegistryParseError(
      `registry uses a YAML merge key (<<:) at line ${mergeLine + 1} — switch rows must be self-contained for diff-reviewability`,
    );
  }
  const anchorLine = code.findIndex((line) =>
    /(^|[\s\[\{:,])[&*][A-Za-z_][A-Za-z0-9_-]*/.test(line),
  );
  if (anchorLine !== -1) {
    throw new RegistryParseError(
      `registry uses YAML anchors/aliases (&name / *name) at line ${anchorLine + 1} — switch rows must be self-contained for diff-reviewability`,
    );
  }
}

/** Drop `#` comments and single/double-quoted string bodies from a YAML line. */
function stripCommentsAndStrings(line: string): string {
  let out = '';
  let quote: "'" | '"' | null = null;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '#') break;
    out += ch;
  }
  return out;
}

/** Format zod issues one-per-line as `<field-path>: expected <x>, received <y>`. */
function formatZodIssues(err: z.ZodError): string {
  return err.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `  ${path}: ${issue.message}`;
    })
    .join('\n');
}

/** Read, parse, and validate the registry at `path`. */
export async function loadRegistry(path: string): Promise<Registry> {
  const raw = await readFile(path, 'utf8');
  try {
    return parseRegistry(raw);
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      throw new RegistryParseError(
        `prod-switches registry "${path}" is invalid:\n${formatZodIssues(err)}`,
      );
    }
    if (err instanceof Error) {
      throw new RegistryParseError(`prod-switches registry "${path}" is invalid: ${err.message}`);
    }
    throw err;
  }
}

/** Parse + validate registry contents already in memory (FS-free). */
export function parseRegistry(raw: string): Registry {
  if (raw.trim().length === 0) {
    throw new Error('registry is empty: expected a top-level `switches:` array');
  }
  assertNoYamlIndirection(raw);
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
