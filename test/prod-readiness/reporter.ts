/**
 * prod-readiness/reporter.ts
 *
 * Renders the deploy-readiness results in two formats:
 *   - console (default): a compact human-readable table for jest output
 *   - markdown: the full report consumed by `npm run readiness:report`
 *     and posted as a PR comment by the future GitHub Action.
 */

import type { EnvVarOrigin } from './env-discovery';
import type { StubFinding, StubSeverity } from './stub-scanner';
import type { ProviderReport } from './provider-wiring';
import type { FlipPlan } from './auto-flipper';
import type { SwitchEntry } from './registry-loader';

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

export function verdict(r: ReadinessReport): Verdict {
  const hardStubs = r.stubs.filter((s) => s.severity === 'BLOCK_SHIP').length;
  const stubProviders = r.providers.filter((p) => p.status === 'STUB').length;
  const unregistered = r.unregistered_in_code.length;
  if (hardStubs > 0 || unregistered > 0) return 'SHIP_BLOCKED';
  if (stubProviders > 0 || r.switches_unset_in_prod.length > 0) return 'NEEDS_OPERATOR';
  return 'CLEAN';
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
  for (const sev of ['BLOCK_SHIP', 'WARN', 'INFO'] as StubSeverity[]) {
    const arr = byS[sev];
    out.push(`### ${sev} (${arr.length})`);
    if (!arr.length) { out.push('_None._'); continue; }
    for (const f of arr) {
      out.push(`- \`${f.file}:${f.line}\` — **${f.pattern}** — \`${f.excerpt}\``);
    }
  }
  out.push('');

  out.push('## Provider wiring');
  out.push('| Provider | Status | Required vars | Missing | Placeholder |');
  out.push('|---|---|---|---|---|');
  for (const p of r.providers) {
    out.push(`| ${p.label} | \`${p.status}\` | ${p.required_vars.join(', ') || '_none_'} | ${p.env_vars_missing.join(', ') || '-'} | ${p.env_vars_placeholder.join(', ') || '-'} |`);
  }
  out.push('');

  out.push('## Switches that would auto-flip in prod (Q9 case 1)');
  if (!r.flips.length) {
    out.push('_None._');
  } else {
    out.push('| Switch | Value | Reason |');
    out.push('|---|---|---|');
    for (const f of r.flips) {
      out.push(`| \`${f.name}\` | \`${f.proposed_value}\` | ${f.reason} |`);
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
      out.push(`| \`${s.name}\` | ${s.tier} | ${s.owner} | ${s.description.slice(0, MAX_DESCRIPTION_WIDTH)} |`);
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
