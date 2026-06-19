/**
 * prod-readiness/reporter.ts
 *
 * Renders the deploy-readiness results in two formats:
 *   - console (default): a compact human-readable table for jest output
 *   - markdown: the full report consumed by `npm run readiness:report`
 *     and posted as a PR comment by the future GitHub Action.
 *
 * This module is intentionally self-contained: it owns the `ReadinessReport`
 * structural contract rather than importing concrete result types from the
 * individual scanners. The orchestrator (and every scanner) only has to
 * produce a value that is *shape-compatible* with `ReadinessReport`; nothing
 * here imports from `stub-scanner`, `provider-wiring`, `auto-flipper`, or
 * `env-discovery`, so the reporter can land and be reviewed independently of
 * those modules. The single shared dependency that already exists on main is
 * the registry row, modelled below by `SwitchEntry`.
 */

/**
 * Severity buckets a stub/placeholder finding can fall into.
 *
 * - `BLOCK_SHIP` — a real placeholder in production code; deploy must not
 *   proceed until it is resolved.
 * - `WARN` — suspicious but tolerated (e.g. a known-tracked debt entry).
 * - `INFO` — informational only; surfaced but never gates a ship.
 */
export type StubSeverity = 'BLOCK_SHIP' | 'WARN' | 'INFO';

/**
 * One placeholder/stub hit found in `src/` by the stub scanner. Modelled
 * structurally so the reporter never imports the scanner itself.
 */
export interface StubFinding {
  /** Repo-relative path of the file containing the hit. */
  file: string;
  /** 1-based line number of the hit. */
  line: number;
  /** The matched pattern label (e.g. the token family that tripped). */
  pattern: string;
  /** A short excerpt of the offending line, used verbatim in the report. */
  excerpt: string;
  /** Severity assigned after applying any learning-ledger downgrades. */
  severity: StubSeverity;
}

/** Wiring status the provider scanner assigns to each external provider. */
export type ProviderStatus = 'WIRED' | 'STUB' | 'NOT_USED';

/**
 * Result of inspecting a single external provider (payment, storage, email …):
 * which env vars it requires and which are missing or still placeholders.
 */
export interface ProviderReport {
  /** Human-readable provider name shown in tables. */
  label: string;
  /** Overall wiring verdict for this provider. */
  status: ProviderStatus;
  /** Every env var this provider needs to be considered fully wired. */
  required_vars: string[];
  /** Required vars with no value in the inspected environment. */
  env_vars_missing: string[];
  /** Required vars whose value is a recognised placeholder/stub. */
  env_vars_placeholder: string[];
}

/**
 * A switch the auto-flipper would change to its production value on deploy.
 */
export interface FlipPlan {
  /** Registry switch name (UPPER_SNAKE_CASE). */
  name: string;
  /** The value the switch would be flipped to in production. */
  proposed_value: string;
  /** Human-readable justification, surfaced verbatim in the report. */
  reason: string;
}

/**
 * The registry-derived view of a single switch the reporter needs. A subset of
 * H4.A's `RegistryRow`; declared locally so the reporter does not couple to the
 * full Zod-inferred row type.
 */
export interface SwitchEntry {
  /** Registry switch name (UPPER_SNAKE_CASE). */
  name: string;
  /** Lifecycle tier: hard | prod | feature | optional. */
  tier: string;
  /** Owning domain/team for the switch. */
  owner: string;
  /** One-line human description of what the switch controls. */
  description: string;
}

/**
 * The aggregated, scanner-agnostic result the orchestrator (H4.H) assembles
 * and hands to the reporter. Every field is a plain data shape so any producer
 * — real scanner or test fixture — can satisfy it without importing this file.
 *
 * Field contract:
 * - `generated_at` — ISO-8601 timestamp the report was produced.
 * - `target_env` — the environment the readiness run targeted (e.g. `prod`).
 * - `registry_size` — number of switches in `prod-switches.yml`.
 * - `env_var_count` — number of distinct env vars discovered in `src/`.
 * - `unregistered_in_code` — env var names referenced in code but absent from
 *   the registry (an R108 violation); sorted by the producer.
 * - `ledger_dead_entries` — learning-ledger fingerprints that no longer match
 *   any source line and should be pruned.
 * - `switches_unset_in_prod` — MUST_SET switches with no value in the env.
 * - `stubs` — every stub/placeholder finding, severity already resolved.
 * - `providers` — per-provider wiring reports.
 * - `flips` — switches the auto-flipper would change on deploy.
 */
export interface ReadinessReport {
  generated_at: string;
  target_env: string;
  registry_size: number;
  env_var_count: number;
  unregistered_in_code: string[];
  ledger_dead_entries: string[];
  switches_unset_in_prod: SwitchEntry[];
  stubs: StubFinding[];
  providers: ProviderReport[];
  flips: FlipPlan[];
}

/**
 * Top-level ship verdict.
 * - `SHIP_BLOCKED` — at least one BLOCK_SHIP stub or unregistered var.
 * - `NEEDS_OPERATOR` — clean of blockers but operator action still required.
 * - `CLEAN` — safe to deploy.
 */
export type Verdict = 'CLEAN' | 'NEEDS_OPERATOR' | 'SHIP_BLOCKED';

// ---- Console-rendering tunables (F-B11) ----
// Named so the truncation behaviour is documented and adjustable in one place
// rather than scattered as bare literals through the render functions.

/** Max unregistered vars / BLOCK_SHIP stubs listed in the console summary before eliding. */
export const MAX_STUB_FINDINGS_DISPLAYED = 10;
/** Max characters of a stub excerpt shown inline in the console table. */
export const MAX_EXCERPT_WIDTH = 80;
/** Max characters of a switch description shown in the markdown table. */
export const MAX_DESCRIPTION_WIDTH = 80;

/** Ordered severities, highest-gating first; drives all severity iteration. */
export const SEVERITY_ORDER: readonly StubSeverity[] = ['BLOCK_SHIP', 'WARN', 'INFO'];

export function verdict(r: ReadinessReport): Verdict {
  const hardStubs = r.stubs.filter((s) => s.severity === 'BLOCK_SHIP').length;
  const stubProviders = r.providers.filter((p) => p.status === 'STUB').length;
  const unregistered = r.unregistered_in_code.length;
  if (hardStubs > 0 || unregistered > 0) return 'SHIP_BLOCKED';
  if (stubProviders > 0 || r.switches_unset_in_prod.length > 0) return 'NEEDS_OPERATOR';
  return 'CLEAN';
}

/**
 * One-line summary used in CI titles and PR-comment headers. Format is stable
 * and parseable: `R100: <blockers> blockers, <warnings> warnings, <green> green`.
 */
export function summaryLine(r: ReadinessReport): string {
  const blockers =
    r.stubs.filter((s) => s.severity === 'BLOCK_SHIP').length + r.unregistered_in_code.length;
  const warnings =
    r.stubs.filter((s) => s.severity === 'WARN').length +
    r.providers.filter((p) => p.status === 'STUB').length +
    r.switches_unset_in_prod.length;
  const green = r.providers.filter((p) => p.status === 'WIRED').length;
  return `R100: ${blockers} blockers, ${warnings} warnings, ${green} green`;
}

export function renderConsole(r: ReadinessReport): string {
  const lines: string[] = [];
  lines.push('===== Deploy Readiness =====');
  lines.push(`env: ${r.target_env}   registry: ${r.registry_size}   env vars discovered: ${r.env_var_count}`);
  lines.push(`verdict: ${verdict(r)}`);
  lines.push('');
  lines.push(`Unregistered vars (R108): ${r.unregistered_in_code.length}`);
  if (r.unregistered_in_code.length) {
    for (const n of r.unregistered_in_code.slice(0, MAX_STUB_FINDINGS_DISPLAYED)) lines.push(`  - ${n}`);
    if (r.unregistered_in_code.length > MAX_STUB_FINDINGS_DISPLAYED) {
      lines.push(`  … ${r.unregistered_in_code.length - MAX_STUB_FINDINGS_DISPLAYED} more`);
    }
  }
  lines.push('');
  const bySeverity: Record<StubSeverity, number> = { BLOCK_SHIP: 0, WARN: 0, INFO: 0 };
  for (const s of r.stubs) bySeverity[s.severity]++;
  lines.push(`Stub findings: BLOCK_SHIP=${bySeverity.BLOCK_SHIP}  WARN=${bySeverity.WARN}  INFO=${bySeverity.INFO}`);
  for (const s of r.stubs.filter((x) => x.severity === 'BLOCK_SHIP').slice(0, MAX_STUB_FINDINGS_DISPLAYED)) {
    lines.push(`  [BLOCK] ${s.file}:${s.line}  ${s.pattern}  "${s.excerpt.slice(0, MAX_EXCERPT_WIDTH)}"`);
  }
  lines.push('');
  const wired = r.providers.filter((p) => p.status === 'WIRED').length;
  const stubbed = r.providers.filter((p) => p.status === 'STUB').length;
  const unused = r.providers.filter((p) => p.status === 'NOT_USED').length;
  lines.push(`Providers: WIRED=${wired}  STUB=${stubbed}  NOT_USED=${unused}`);
  for (const p of r.providers.filter((x) => x.status === 'STUB')) {
    lines.push(`  [STUB] ${p.label}  missing=${p.env_vars_missing.join(',') || '-'}  placeholder=${p.env_vars_placeholder.join(',') || '-'}`);
  }
  lines.push('');
  lines.push(`Switches that would auto-flip in prod: ${r.flips.length}`);
  for (const f of r.flips) lines.push(`  + ${f.name} ← ${f.proposed_value}   (${f.reason})`);
  return lines.join('\n');
}

export function renderMarkdown(r: ReadinessReport): string {
  const v = verdict(r);
  const out: string[] = [];
  out.push(`# Deploy Readiness Report`);
  out.push('');
  out.push(`- **Generated:** ${r.generated_at}`);
  out.push(`- **Target env:** \`${r.target_env}\``);
  out.push(`- **Registry switches:** ${r.registry_size}`);
  out.push(`- **Env vars discovered:** ${r.env_var_count}`);
  out.push(`- **Verdict:** \`${v}\``);
  out.push('');

  out.push('## R108 — Unregistered env vars');
  if (r.unregistered_in_code.length === 0) {
    out.push('_None. Registry is complete._');
  } else {
    out.push('These env vars are referenced in `src/` but not in `prod-switches.yml`. R108 requires they be registered before merge.');
    out.push('');
    for (const n of r.unregistered_in_code) out.push(`- \`${n}\``);
  }
  out.push('');

  out.push('## Stub / placeholder findings');
  const byS = r.stubs.reduce<Record<StubSeverity, StubFinding[]>>((acc, f) => {
    (acc[f.severity] ||= []).push(f);
    return acc;
  }, { BLOCK_SHIP: [], WARN: [], INFO: [] });
  for (const sev of SEVERITY_ORDER) {
    const arr = byS[sev];
    out.push(`### ${sev} (${arr.length})`);
    if (!arr.length) { out.push('_None._'); continue; }
    for (const f of arr) {
      out.push(`- \`${f.file}:${f.line}\` — **${f.pattern}** — \`${escapeCell(f.excerpt)}\``);
    }
  }
  out.push('');

  out.push('## Provider wiring');
  out.push('| Provider | Status | Required vars | Missing | Placeholder |');
  out.push('|---|---|---|---|---|');
  for (const p of r.providers) {
    out.push(`| ${escapeCell(p.label)} | \`${p.status}\` | ${p.required_vars.join(', ') || '_none_'} | ${p.env_vars_missing.join(', ') || '-'} | ${p.env_vars_placeholder.join(', ') || '-'} |`);
  }
  out.push('');

  out.push('## Switches that would auto-flip in prod (Q9 case 1)');
  if (!r.flips.length) {
    out.push('_None._');
  } else {
    out.push('| Switch | Value | Reason |');
    out.push('|---|---|---|');
    for (const f of r.flips) {
      out.push(`| \`${f.name}\` | \`${f.proposed_value}\` | ${escapeCell(f.reason)} |`);
    }
  }
  out.push('');

  out.push('## Switches with `prod_default: MUST_SET` that are unset in current env');
  if (!r.switches_unset_in_prod.length) {
    out.push('_None._');
  } else {
    out.push('| Switch | Tier | Owner | Description |');
    out.push('|---|---|---|---|');
    for (const s of r.switches_unset_in_prod) {
      out.push(`| \`${s.name}\` | ${s.tier} | ${s.owner} | ${escapeCell(s.description.slice(0, MAX_DESCRIPTION_WIDTH))} |`);
    }
  }
  out.push('');

  if (r.ledger_dead_entries.length) {
    out.push('## Stale learning-ledger entries');
    out.push('These fingerprints no longer match any source line; prune them from `test/prod-readiness/__fixtures__/learning-ledger.json`.');
    for (const fp of r.ledger_dead_entries) out.push(`- \`${fp}\``);
    out.push('');
  }
  return out.join('\n');
}

/**
 * Escape characters that would break a markdown table cell. Pipes are
 * backslash-escaped and embedded newlines collapsed to spaces so a single
 * finding can never spill across rows.
 */
function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
