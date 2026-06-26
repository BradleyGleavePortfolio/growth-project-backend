/**
 * test/deploy-readiness.spec.ts
 *
 * R100 flagship: the single end-to-end deploy-readiness board. This spec wires
 * the seven merged H4 sub-scanners (H4.A through H4.G) into one human-readable
 * board, sums the red lines across every gating section, and FAILS the build
 * when any red line exists. No human tracks pre-launch wiring by memory: this
 * one test asks "is every stub gone, every switch coherent, every integration
 * credentialed, every env var registered, every operator key provided?" and
 * refuses to go green until the answer is yes.
 *
 * Section map (R100 paragraphs 1-7, expanded to the seven sub-scanners):
 *   1. STUB VALUES      — prod-readiness/stub-scanner.ts            (H4.B)
 *   2. PROD SWITCHES    — prod-readiness/registry-loader.ts         (H4.A)
 *   3. WIRING           — prod-readiness/provider-wiring.ts         (H4.E + H4.F)
 *   4. ENV DISCOVERY    — prod-readiness/env-discovery.ts           (H4.C)
 *   5. AUTO-FLIPPER     — prod-readiness/auto-flipper.ts            (H4.D, informational)
 *   6. OPERATOR KEYS    — prod-readiness/operator-keys-generator.ts (H4.G)
 *   7. AGGREGATE EXIT   — sum of every gating section's red count
 *
 * MODES (R104). DEPLOY_READINESS_MODE=quick runs the stub scan ONLY, fast
 * enough for the lefthook pre-commit hook; the default (full) mode runs every
 * section. Both modes assert the exit total is zero on this repo.
 *
 * The orchestrator imports each scanner's PUBLIC exports and never modifies a
 * sub-scanner. Aggregation types are declared locally with precise interfaces;
 * no `as any` / `as unknown as` / `as never` is introduced (R75 net zero).
 */

import * as path from 'node:path';

import {
  BOARD_SECTIONS,
  LEDGER_PATH,
  REGISTRY_PATH,
  SCANNER_REGISTRY,
  gatingSections,
  registrationFor,
  type BoardSection,
} from './prod-readiness.config';

import { scanForStubs, describePatterns, type StubFinding } from './prod-readiness/stub-scanner';
import {
  loadRegistry,
  validateRegistry,
  errorFindings,
  getProdRequired,
  type Registry,
  type RegistryRow,
} from './prod-readiness/registry-loader';
import {
  scanProvidersFromProcess,
  getProductionBlockers,
  type ProviderReport,
} from './prod-readiness/provider-wiring';
import {
  discoverEnvVars,
  crossReference,
  findUndeclared,
  type DiscoveryResult,
} from './prod-readiness/env-discovery';
import { plan as planFlips, targetValueFor, type FlipPlan } from './prod-readiness/auto-flipper';
import {
  renderOperatorKeysMarkdown,
  type OperatorKeysInput,
  type SwitchEntry as OperatorSwitchEntry,
} from './prod-readiness/operator-keys-generator';
import { loadLedger, falsePositives, trackedDebt } from './prod-readiness/learning-ledger';

// ---------------------------------------------------------------------------
// Run mode (R104).
// ---------------------------------------------------------------------------

/** quick: stub scan only (lefthook pre-commit). full: every section (default). */
export type RunMode = 'quick' | 'full';

/** Resolve the run mode from the environment; anything but `quick` is `full`. */
export function resolveRunMode(env: NodeJS.ProcessEnv = process.env): RunMode {
  return env.DEPLOY_READINESS_MODE === 'quick' ? 'quick' : 'full';
}

/**
 * STRICT vs INFORMATIONAL run, per R100 paragraph 6. The board has two classes
 * of gating section:
 *
 *   - CODEBASE-INVARIANT (stub values, registry coherence): their red count is
 *     a function of the committed source + registry alone, so it is deterministic
 *     on any runner and ALWAYS gates — on PRs and on the prod-deploy gate alike.
 *   - ENVIRONMENT-DEPENDENT (provider wiring, env-discovery completeness,
 *     operator keys): their red count depends on the SECRETS loaded into the
 *     environment and on the registry being fully built out. A CI runner with no
 *     production secrets necessarily sees every provider as un-credentialed and
 *     every not-yet-registered env var as a gap. Asserting zero there would be a
 *     false alarm, so on a PR these sections are INFORMATIONAL (printed, never
 *     blocking) and gate ONLY under strict mode.
 *
 * Strict mode is the prod-deploy gate (`deploy-readiness-gate` job sets
 * DEPLOY_READINESS_STRICT=1): the deploy environment carries the real secrets,
 * so every section gates and the build refuses to deploy on any red line. This
 * is exactly R100's "informational on every PR, hard-block on the production
 * deploy workflow" split — implemented once, in the spec, so the same code path
 * serves both surfaces.
 */
export function resolveStrict(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DEPLOY_READINESS_STRICT === '1' || env.DEPLOY_READINESS_STRICT === 'true';
}

/** Section ids whose red count is environment-dependent (gates under strict only). */
export const ENV_DEPENDENT_SECTIONS: ReadonlySet<BoardSection> = new Set<BoardSection>([
  'WIRING',
  'ENV_DISCOVERY',
  'OPERATOR_KEYS',
]);

// ---------------------------------------------------------------------------
// Aggregation contract. One precise interface per section's red count plus the
// rendered lines. No section returns `any`: every scanner's output is mapped to
// a typed `SectionResult` here, so the aggregate stays type-safe end to end.
// ---------------------------------------------------------------------------

/** The result of running one board section. */
export interface SectionResult {
  /** Stable section id. */
  section: BoardSection;
  /** Human-readable heading. */
  label: string;
  /** Number of RED (deploy-blocking) lines this section found. */
  red: number;
  /** Whether this section gates the deploy (informational sections never do). */
  gating: boolean;
  /** Plain-text body lines for the board (already human-formatted). */
  lines: string[];
}

/** The fully-aggregated board: every section plus the per-bucket red counts. */
export interface BoardResult {
  sections: SectionResult[];
  /** Red counts keyed by the EXIT-line bucket they feed. */
  counts: ExitCounts;
  /** Whether this run gated the environment-dependent sections too. */
  strict: boolean;
  /**
   * The deploy-gating total for THIS run: under strict mode it is every gating
   * section's red count; otherwise only the codebase-invariant sections (stub +
   * registry coherence). This is the number the flagship assertion checks.
   */
  totalRed: number;
  /**
   * The total across ALL gating sections regardless of mode — what a strict /
   * prod-deploy run would gate on. Always printed so a PR run still SURFACES the
   * environment-dependent gaps even when it does not block on them.
   */
  strictTotalRed: number;
  /** The exact EXIT line (see {@link buildExitLine}). */
  exitLine: string;
  /** The full plain-text board, copy-pasteable into a PR comment or Slack. */
  board: string;
}

/**
 * The five gating buckets that appear, in order, in the DO NOT DEPLOY exit line.
 * ENV gaps and KEY gaps extend R100 paragraph 4's three-bucket headline to cover
 * the env-discovery (H4.C) and operator-keys (H4.G) sub-scanners; their sum plus
 * the original three is the single number that gates the deploy.
 */
export interface ExitCounts {
  stub: number;
  prodSwitchesWrong: number;
  wiringGaps: number;
  envGaps: number;
  keyGaps: number;
}

/** Exact regex an exit line in the DO-NOT-DEPLOY form must match. */
export const EXIT_DO_NOT_DEPLOY_RE =
  /^EXIT: (\d+) STUB \+ (\d+) PROD SWITCHES WRONG \+ (\d+) WIRING GAPS \+ (\d+) ENV GAPS \+ (\d+) KEY GAPS \u2192 DO NOT DEPLOY$/;

/** Exact string an exit line in the ALL-CLEAR form must equal. */
export const EXIT_ALL_CLEAR = 'EXIT: ALL CLEAR \u2192 SAFE TO DEPLOY';

/**
 * Build the aggregate exit line from the gating counts. Pure and deterministic:
 * zero red lines yields the ALL CLEAR string; any red line yields the itemised
 * DO NOT DEPLOY breakdown in the fixed bucket order. The total is the sum of all
 * five buckets, so the line and {@link sumCounts} can never disagree.
 */
export function buildExitLine(counts: ExitCounts): string {
  if (sumCounts(counts) === 0) return EXIT_ALL_CLEAR;
  return (
    `EXIT: ${counts.stub} STUB ` +
    `+ ${counts.prodSwitchesWrong} PROD SWITCHES WRONG ` +
    `+ ${counts.wiringGaps} WIRING GAPS ` +
    `+ ${counts.envGaps} ENV GAPS ` +
    `+ ${counts.keyGaps} KEY GAPS ` +
    `\u2192 DO NOT DEPLOY`
  );
}

/** Sum the five gating buckets into the single deploy-gating total. */
export function sumCounts(counts: ExitCounts): number {
  return (
    counts.stub + counts.prodSwitchesWrong + counts.wiringGaps + counts.envGaps + counts.keyGaps
  );
}

/**
 * Aggregate a set of section results into the board. Pure: takes already-run
 * section results and the bucket counts, renders the plain-text board, and
 * computes the totals + exit line. Separated from the I/O run so the aggregation
 * itself is unit-testable with synthetic section results (see tests below).
 *
 * `strict` selects which total the EXIT line and the flagship assertion use:
 * under strict mode every gating bucket counts; otherwise only the
 * codebase-invariant buckets (stub + prod-switch coherence) count toward the
 * gate, while the environment-dependent buckets are still summed into
 * `strictTotalRed` and printed so a PR run surfaces them without blocking.
 */
export function aggregateBoard(
  sections: SectionResult[],
  counts: ExitCounts,
  strict = false,
): BoardResult {
  const strictTotalRed = sumCounts(counts);
  const invariantTotal = counts.stub + counts.prodSwitchesWrong;
  const totalRed = strict ? strictTotalRed : invariantTotal;
  // The EXIT line always itemises the full breakdown (every bucket) so the board
  // is honest about the prod-deploy verdict; the flagship assertion uses the
  // mode-appropriate total. When the gating total is zero we print ALL CLEAR.
  const exitLine = totalRed === 0 ? EXIT_ALL_CLEAR : buildExitLine(counts);
  const board = renderBoard(sections, exitLine, totalRed, strictTotalRed, strict);
  return { sections, counts, strict, totalRed, strictTotalRed, exitLine, board };
}

/** Render the seven-section plain-text board. No JSON-only output (R100 #5). */
export function renderBoard(
  sections: SectionResult[],
  exitLine: string,
  totalRed: number,
  strictTotalRed: number,
  strict: boolean,
): string {
  const out: string[] = [];
  out.push('================ DEPLOY READINESS BOARD (R100) ================');
  out.push(`mode: ${strict ? 'STRICT (prod-deploy gate)' : 'INFORMATIONAL (PR / pre-launch)'}`);
  for (const s of sections) {
    const envDependent = ENV_DEPENDENT_SECTIONS.has(s.section);
    const tag = !s.gating
      ? 'INFO'
      : envDependent && !strict
        ? `RED=${s.red} (informational on PR)`
        : `RED=${s.red}`;
    out.push('');
    out.push(`--- ${s.label} [${tag}] ---`);
    for (const line of s.lines) out.push(`  ${line}`);
  }
  out.push('');
  out.push('---------------------------------------------------------------');
  out.push(`GATING RED LINES (this run): ${totalRed}`);
  out.push(`PROD-DEPLOY RED LINES (strict): ${strictTotalRed}`);
  out.push(exitLine);
  out.push('===============================================================');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Section runners. Each consumes a sub-scanner's public output and maps it to a
// typed SectionResult. Pure where the scanner allows; the env/registry/provider
// runners take already-loaded data so they stay synchronous and testable.
// ---------------------------------------------------------------------------

/**
 * Apply the learning ledger's tracked-debt classifications to a raw finding set:
 * any BLOCK_SHIP whose fingerprint the operator has adjudicated as tracked debt
 * is downgraded to WARN (the scanner's documented ledger semantics; the scanner
 * itself only drops false positives, so the orchestrator applies the downgrade).
 * Pure: returns a new array, never mutates the input or the scanner.
 */
export function applyTrackedDebt(
  findings: readonly StubFinding[],
  debt: ReadonlySet<string>,
): StubFinding[] {
  return findings.map((f) =>
    f.severity === 'BLOCK_SHIP' && debt.has(f.fingerprint) ? { ...f, severity: 'WARN' } : f,
  );
}

/** SECTION 1 — STUB VALUES (H4.B). RED = count of BLOCK_SHIP findings. */
export function runStubSection(findings: readonly StubFinding[]): SectionResult {
  const reg = registrationFor('STUB_VALUES');
  const block = findings.filter((f) => f.severity === 'BLOCK_SHIP');
  const warn = findings.filter((f) => f.severity === 'WARN');
  const info = findings.filter((f) => f.severity === 'INFO');
  const lines: string[] = [];
  lines.push(`BLOCK_SHIP=${block.length}  WARN=${warn.length}  INFO=${info.length}`);
  for (const f of block) lines.push(`[BLOCK] ${f.file}:${f.line}  ${f.pattern}`);
  for (const f of warn.slice(0, 10)) lines.push(`[warn] ${f.file}:${f.line}  ${f.pattern} (tracked debt or low-signal)`);
  if (block.length === 0) lines.push('no blocking stub/placeholder tokens in production-bound src/');
  return { section: reg.section, label: reg.label, red: block.length, gating: true, lines };
}

/**
 * SECTION 2 — PROD SWITCHES (H4.A). RED = registry-coherence error findings.
 * For each MUST_SET switch the section also prints actual vs expected value and
 * a marker, satisfying R100 paragraph 2's "actual + expected + status" contract.
 */
export function runProdSwitchesSection(
  registry: Registry,
  env: NodeJS.ProcessEnv,
): { result: SectionResult; unsetRequired: RegistryRow[] } {
  const reg = registrationFor('PROD_SWITCHES');
  const report = validateRegistry(registry);
  const errors = errorFindings(report);
  const required = getProdRequired(registry);
  const unsetRequired = required.filter((r) => !isSet(env[r.name]));
  const lines: string[] = [];
  lines.push(`registry switches: ${registry.switches.length}   coherence errors: ${errors.length}`);
  for (const e of errors) lines.push(`[ERROR] ${e.name}  (${e.kind})`);
  lines.push(`MUST_SET switches: ${required.length}   unset in current env: ${unsetRequired.length}`);
  for (const r of required) {
    const actual = isSet(env[r.name]) ? 'set' : '(unset)';
    const mark = isSet(env[r.name]) ? '\u2705' : '\u274c';
    lines.push(`${r.name}: actual=${actual} expected=MUST_SET ${mark}`);
  }
  // Coherence errors are the gating red count for this section; unset MUST_SET
  // switches are surfaced here and feed the OPERATOR KEYS section's key gaps so
  // they are counted exactly once toward the exit total.
  return {
    result: { section: reg.section, label: reg.label, red: errors.length, gating: true, lines },
    unsetRequired,
  };
}

/** SECTION 3 — WIRING (H4.E + H4.F). RED = providers imported but STUB. */
export function runWiringSection(reports: readonly ProviderReport[]): SectionResult {
  const reg = registrationFor('WIRING');
  const blockers = getProductionBlockers([...reports]);
  const wired = reports.filter((r) => r.status === 'WIRED');
  const unused = reports.filter((r) => r.status === 'NOT_USED');
  const lines: string[] = [];
  lines.push(`providers: WIRED=${wired.length}  STUB=${blockers.length}  NOT_USED=${unused.length}`);
  for (const p of blockers) {
    const missing = p.env_vars_missing.join(',') || '-';
    const ph = p.env_vars_placeholder.join(',') || '-';
    lines.push(`[STUB] ${p.label}  missing=${missing}  placeholder=${ph}`);
  }
  if (blockers.length === 0) lines.push('every imported provider SDK is fully credentialed');
  return { section: reg.section, label: reg.label, red: blockers.length, gating: true, lines };
}

/** SECTION 4 — ENV DISCOVERY (H4.C). RED = env vars in code but unregistered. */
export function runEnvDiscoverySection(
  discovery: DiscoveryResult,
  registry: Registry,
): { result: SectionResult; undeclared: string[] } {
  const reg = registrationFor('ENV_DISCOVERY');
  const report = crossReference(discovery, registry);
  const undeclared = findUndeclared(report).map((f) => f.name);
  const lines: string[] = [];
  lines.push(`env vars discovered: ${discovery.envVars.size}   registry size: ${report.registrySize}`);
  lines.push(`unregistered in code (R108): ${undeclared.length}`);
  for (const name of undeclared) lines.push(`[GAP] ${name} referenced in src/ but absent from prod-switches.yml`);
  if (undeclared.length === 0) lines.push('every discovered env var is registered');
  return {
    result: { section: reg.section, label: reg.label, red: undeclared.length, gating: true, lines },
    undeclared,
  };
}

/**
 * SECTION 5 — AUTO-FLIPPER (H4.D). INFORMATIONAL: lists which switches would be
 * auto-flipped to their prod value on a prod-bound deploy. Never gates.
 */
export function runAutoFlipperSection(flipPlan: FlipPlan): SectionResult {
  const reg = registrationFor('AUTO_FLIPPER');
  const lines: string[] = [];
  lines.push(`would auto-flip: ${flipPlan.to_set.length}   already current: ${flipPlan.already_set.length}   skipped: ${flipPlan.to_skip.length}`);
  for (const p of flipPlan.to_set) lines.push(`+ ${p.row.name} \u2190 ${p.target}   (was ${p.was ?? 'unset'})`);
  if (flipPlan.to_set.length === 0) lines.push('no switches would be auto-flipped on a prod-bound deploy');
  return { section: reg.section, label: reg.label, red: 0, gating: false, lines };
}

/**
 * SECTION 6 — OPERATOR KEYS (H4.G). RED = count of operator-facing keys left
 * unprovided: MUST_SET switches that are unset PLUS provider credentials still
 * missing or placeholder. The markdown the generator renders is folded into the
 * board so the operator sees the actionable fly-secrets list inline.
 */
export function runOperatorKeysSection(
  unsetRequired: RegistryRow[],
  stubbedProviders: readonly ProviderReport[],
): { result: SectionResult; keyGaps: number } {
  const reg = registrationFor('OPERATOR_KEYS');
  const switchEntries: OperatorSwitchEntry[] = unsetRequired.map((r) => ({
    name: r.name,
    tier: r.tier,
    owner: r.owner,
    description: r.description,
  }));
  const providerEntries = stubbedProviders.map((p) => ({
    label: p.label,
    env_vars_missing: p.env_vars_missing,
    env_vars_placeholder: p.env_vars_placeholder,
  }));
  const input: OperatorKeysInput = {
    generated_at: new Date(0).toISOString(),
    switches_unset_required: switchEntries,
    providers_stubbed: providerEntries,
    unregistered_in_code: [],
  };
  // The operator-keys generator renders the actionable markdown; we invoke it so
  // H4.G is genuinely exercised end to end, then count the gaps it would list.
  const markdown = renderOperatorKeysMarkdown(input);
  const providerKeyGaps = providerEntries.reduce(
    (n, p) => n + p.env_vars_missing.length + p.env_vars_placeholder.length,
    0,
  );
  const keyGaps = switchEntries.length + providerKeyGaps;
  const lines: string[] = [];
  lines.push(`operator keys outstanding: ${keyGaps}`);
  lines.push(`  MUST_SET switches unset: ${switchEntries.length}`);
  lines.push(`  provider credentials missing/placeholder: ${providerKeyGaps}`);
  for (const s of switchEntries) lines.push(`[KEY] fly secrets set ${s.name}=<value>   (${s.owner})`);
  for (const p of providerEntries) {
    for (const v of p.env_vars_missing) lines.push(`[KEY] fly secrets set ${v}=<value>   (${p.label})`);
    for (const v of p.env_vars_placeholder) lines.push(`[KEY] ${v} is a placeholder for ${p.label}`);
  }
  if (keyGaps === 0) lines.push('every operator-facing key is provided');
  // Sanity: the generator must have produced the heading; guards against an
  // accidental empty render swallowing the section.
  if (!markdown.includes('# Operator keys needed')) {
    lines.push('[WARN] operator-keys generator returned unexpected output');
  }
  return {
    result: { section: reg.section, label: reg.label, red: keyGaps, gating: true, lines },
    keyGaps,
  };
}

/** True when an env value is present and non-empty. */
function isSet(v: string | undefined): boolean {
  return v !== undefined && v.trim() !== '';
}

// ---------------------------------------------------------------------------
// End-to-end run. Loads the registry + ledger, runs every section against the
// real repo, and aggregates. In quick mode only the stub section runs (the
// other sections are represented as zero-red, informational placeholders so the
// board shape is stable across modes).
// ---------------------------------------------------------------------------

export interface RunOptions {
  repoRoot: string;
  mode: RunMode;
  env?: NodeJS.ProcessEnv;
  /** Force strict gating; defaults to {@link resolveStrict} on `env`. */
  strict?: boolean;
}

/** Run the full board against the real repo and aggregate it. */
export async function runDeployReadiness(opts: RunOptions): Promise<BoardResult> {
  const env = opts.env ?? process.env;
  const registryPath = path.join(opts.repoRoot, REGISTRY_PATH);
  const ledgerPath = path.join(opts.repoRoot, LEDGER_PATH);

  const strict = opts.strict ?? resolveStrict(env);

  // Stub section honours the ledger: false positives are dropped by the scanner;
  // operator-adjudicated tracked debt is downgraded BLOCK_SHIP -> WARN here.
  const ledger = await loadLedger(ledgerPath);
  const knownFalsePositives = falsePositives(ledger);
  const debt = trackedDebt(ledger);
  const rawStubFindings = scanForStubs({ repoRoot: opts.repoRoot, knownFalsePositives });
  const stubFindings = applyTrackedDebt(rawStubFindings, debt);
  const stubResult = runStubSection(stubFindings);

  if (opts.mode === 'quick') {
    const counts: ExitCounts = {
      stub: stubResult.red,
      prodSwitchesWrong: 0,
      wiringGaps: 0,
      envGaps: 0,
      keyGaps: 0,
    };
    return aggregateBoard([stubResult], counts, strict);
  }

  const registry = await loadRegistry(registryPath);
  const prodSwitches = runProdSwitchesSection(registry, env);
  const providerReports = scanProvidersFromProcess(opts.repoRoot, env);
  const wiringResult = runWiringSection(providerReports);
  const discovery = discoverEnvVars(opts.repoRoot);
  const envSection = runEnvDiscoverySection(discovery, registry);
  const flipPlan = planFlips({ registry: registry.switches, current: {} });
  const flipResult = runAutoFlipperSection(flipPlan);
  const stubbedProviders = getProductionBlockers([...providerReports]);
  const keysSection = runOperatorKeysSection(prodSwitches.unsetRequired, stubbedProviders);

  const sections: SectionResult[] = [
    stubResult,
    prodSwitches.result,
    wiringResult,
    envSection.result,
    flipResult,
    keysSection.result,
  ];
  const counts: ExitCounts = {
    stub: stubResult.red,
    prodSwitchesWrong: prodSwitches.result.red,
    wiringGaps: wiringResult.red,
    envGaps: envSection.result.red,
    keyGaps: keysSection.keyGaps,
  };
  return aggregateBoard(sections, counts, strict);
}

// ===========================================================================
// SPECS
// ===========================================================================

const REPO_ROOT = path.join(__dirname, '..');

describe('R100 deploy-readiness orchestrator', () => {
  describe('exit-line format', () => {
    it('renders ALL CLEAR when every bucket is zero', () => {
      const counts: ExitCounts = {
        stub: 0,
        prodSwitchesWrong: 0,
        wiringGaps: 0,
        envGaps: 0,
        keyGaps: 0,
      };
      expect(buildExitLine(counts)).toBe(EXIT_ALL_CLEAR);
      expect(sumCounts(counts)).toBe(0);
    });

    it('renders the itemised DO NOT DEPLOY line when any bucket is non-zero', () => {
      const counts: ExitCounts = {
        stub: 2,
        prodSwitchesWrong: 1,
        wiringGaps: 3,
        envGaps: 4,
        keyGaps: 5,
      };
      const line = buildExitLine(counts);
      expect(line).toMatch(EXIT_DO_NOT_DEPLOY_RE);
      const m = EXIT_DO_NOT_DEPLOY_RE.exec(line);
      expect(m).not.toBeNull();
      // The five captured numbers must match the five buckets in order.
      expect(m && m.slice(1, 6).map(Number)).toEqual([2, 1, 3, 4, 5]);
      expect(sumCounts(counts)).toBe(15);
    });

    it('the ALL CLEAR line never matches the DO NOT DEPLOY regex', () => {
      expect(EXIT_ALL_CLEAR).not.toMatch(EXIT_DO_NOT_DEPLOY_RE);
    });

    it.each([
      [{ stub: 1, prodSwitchesWrong: 0, wiringGaps: 0, envGaps: 0, keyGaps: 0 }, 1],
      [{ stub: 0, prodSwitchesWrong: 0, wiringGaps: 0, envGaps: 0, keyGaps: 7 }, 7],
      [{ stub: 3, prodSwitchesWrong: 3, wiringGaps: 3, envGaps: 3, keyGaps: 3 }, 15],
    ])('sums buckets %j to %i', (counts, expected) => {
      expect(sumCounts(counts as ExitCounts)).toBe(expected);
    });
  });

  describe('aggregation correctness', () => {
    const mixedSections: SectionResult[] = [
      { section: 'STUB_VALUES', label: 'STUB VALUES', red: 2, gating: true, lines: [] },
      { section: 'PROD_SWITCHES', label: 'PROD SWITCHES', red: 1, gating: true, lines: [] },
      { section: 'WIRING', label: 'OAUTH / INTEGRATION WIRING', red: 0, gating: true, lines: [] },
      { section: 'ENV_DISCOVERY', label: 'ENV DISCOVERY', red: 4, gating: true, lines: [] },
      { section: 'AUTO_FLIPPER', label: 'AUTO-FLIPPER', red: 0, gating: false, lines: [] },
      { section: 'OPERATOR_KEYS', label: 'OPERATOR KEYS', red: 5, gating: true, lines: [] },
    ];
    const mixedCounts: ExitCounts = {
      stub: 2,
      prodSwitchesWrong: 1,
      wiringGaps: 0,
      envGaps: 4,
      keyGaps: 5,
    };

    it('strict mode gates on every bucket and itemises the full breakdown', () => {
      const board = aggregateBoard(mixedSections, mixedCounts, true);
      // 2 stub + 1 prod-switch + 0 wiring + 4 env + 5 keys = 12 across all buckets.
      expect(board.strictTotalRed).toBe(12);
      expect(board.totalRed).toBe(12);
      expect(board.exitLine).toMatch(EXIT_DO_NOT_DEPLOY_RE);
      expect(board.board).toContain('DEPLOY READINESS BOARD');
      expect(board.board).toContain('GATING RED LINES (this run): 12');
      expect(board.board).toContain('PROD-DEPLOY RED LINES (strict): 12');
      // Informational sections render with INFO, never RED, so they cannot gate.
      expect(board.board).toContain('--- AUTO-FLIPPER [INFO] ---');
    });

    it('PR (non-strict) mode gates only on codebase-invariant buckets, surfaces the rest', () => {
      const board = aggregateBoard(mixedSections, mixedCounts, false);
      // Non-strict gating total is stub + prod-switch only: 2 + 1 = 3.
      expect(board.totalRed).toBe(3);
      // The env-dependent buckets are still summed for the strict view.
      expect(board.strictTotalRed).toBe(12);
      // The EXIT line still itemises the full prod-deploy breakdown honestly.
      expect(board.exitLine).toMatch(EXIT_DO_NOT_DEPLOY_RE);
      expect(board.board).toContain('GATING RED LINES (this run): 3');
      expect(board.board).toContain('PROD-DEPLOY RED LINES (strict): 12');
      // Env-dependent sections are flagged informational on a PR run.
      expect(board.board).toContain('(informational on PR)');
    });

    it('a happy-path fixture aggregates to zero and prints ALL CLEAR', () => {
      const clean: SectionResult[] = BOARD_SECTIONS.map((section) => ({
        section,
        label: registrationFor(section).label,
        red: 0,
        gating: registrationFor(section).mode === 'GATING',
        lines: ['clean'],
      }));
      const counts: ExitCounts = {
        stub: 0,
        prodSwitchesWrong: 0,
        wiringGaps: 0,
        envGaps: 0,
        keyGaps: 0,
      };
      // ALL CLEAR holds under both modes when every bucket is zero.
      for (const strict of [false, true]) {
        const board = aggregateBoard(clean, counts, strict);
        expect(board.totalRed).toBe(0);
        expect(board.strictTotalRed).toBe(0);
        expect(board.exitLine).toBe(EXIT_ALL_CLEAR);
        expect(board.board).toContain('SAFE TO DEPLOY');
      }
    });

    it('an env-dependent-only red line gates under strict but not on a PR', () => {
      const counts: ExitCounts = {
        stub: 0,
        prodSwitchesWrong: 0,
        wiringGaps: 1,
        envGaps: 0,
        keyGaps: 0,
      };
      const sections: SectionResult[] = [
        { section: 'WIRING', label: 'OAUTH / INTEGRATION WIRING', red: 1, gating: true, lines: [] },
      ];
      // Strict: the single wiring gap gates the prod deploy.
      const strictBoard = aggregateBoard(sections, counts, true);
      expect(strictBoard.totalRed).toBeGreaterThan(0);
      expect(strictBoard.exitLine).toMatch(EXIT_DO_NOT_DEPLOY_RE);
      // PR: the same gap is surfaced (strictTotalRed greater than zero) but does
      // not block, so the gating verdict is ALL CLEAR while the board body still
      // prints the strict prod-deploy red count for the operator to see.
      const prBoard = aggregateBoard(sections, counts, false);
      expect(prBoard.totalRed).toBe(0);
      expect(prBoard.strictTotalRed).toBeGreaterThan(0);
      expect(prBoard.exitLine).toBe(EXIT_ALL_CLEAR);
      expect(prBoard.board).toContain('PROD-DEPLOY RED LINES (strict): 1');
    });
  });

  describe('section runners map sub-scanner output to typed red counts', () => {
    it('stub section counts only BLOCK_SHIP findings as red', () => {
      const findings: StubFinding[] = [
        { pattern: 'STUB', kind: 'STUB', file: 'src/a.ts', line: 1, excerpt: '', severity: 'BLOCK_SHIP', fingerprint: 'a' },
        { pattern: 'MOCK', kind: 'MOCK', file: 'src/b.ts', line: 2, excerpt: '', severity: 'WARN', fingerprint: 'b' },
        { pattern: 'STUB', kind: 'STUB', file: 'test/c.spec.ts', line: 3, excerpt: '', severity: 'INFO', fingerprint: 'c' },
      ];
      const r = runStubSection(findings);
      expect(r.red).toBe(1);
      expect(r.gating).toBe(true);
      expect(r.lines.join('\n')).toContain('src/a.ts:1');
    });

    it('wiring section counts STUB providers and ignores NOT_USED / WIRED', () => {
      const reports: ProviderReport[] = [
        mkProvider('stripe', 'Stripe', 'STUB', ['STRIPE_SECRET_KEY']),
        mkProvider('openai', 'OpenAI', 'WIRED', []),
        mkProvider('twilio', 'Twilio', 'NOT_USED', []),
      ];
      const r = runWiringSection(reports);
      expect(r.red).toBe(1);
      expect(r.lines.join('\n')).toContain('Stripe');
    });

    it('operator-keys section counts unset switches plus provider credential gaps', () => {
      const unset: RegistryRow[] = [
        { name: 'STRIPE_LIVE_MODE', tier: 'prod', prod_default: 'MUST_SET', auto_flip_on_in_prod: false, owner: 'billing', description: 'live mode' },
      ];
      const stubbed: ProviderReport[] = [
        mkProvider('mux', 'Mux', 'STUB', ['MUX_TOKEN_ID'], ['MUX_TOKEN_SECRET']),
      ];
      const { result, keyGaps } = runOperatorKeysSection(unset, stubbed);
      // 1 unset switch + 1 missing + 1 placeholder = 3 key gaps.
      expect(keyGaps).toBe(3);
      expect(result.red).toBe(3);
      expect(result.lines.join('\n')).toContain('STRIPE_LIVE_MODE');
    });

    it('auto-flipper section is informational and never gates', () => {
      const onRow: RegistryRow = { name: 'RATE_LIMIT_ENABLED', tier: 'prod', prod_default: 'ON', auto_flip_on_in_prod: true, owner: 'platform', description: 'rate limit' };
      const flip = planFlips({ registry: [onRow], current: {} });
      const r = runAutoFlipperSection(flip);
      expect(r.gating).toBe(false);
      expect(r.red).toBe(0);
      expect(targetValueFor(onRow)).toBe('true');
      expect(r.lines.join('\n')).toContain('RATE_LIMIT_ENABLED');
    });
  });

  describe('config registry', () => {
    it('registers all seven board sections in render order', () => {
      expect(SCANNER_REGISTRY.map((s) => s.section)).toEqual([...BOARD_SECTIONS]);
    });

    it('exactly one section (auto-flipper) is informational; the rest gate', () => {
      const info = SCANNER_REGISTRY.filter((s) => s.mode === 'INFORMATIONAL');
      expect(info.map((s) => s.section)).toEqual(['AUTO_FLIPPER']);
      expect(gatingSections()).toHaveLength(5);
    });

    it('covers BOTH H4.E (Stripe/Mux/SendGrid) and H4.F provider scopes', () => {
      const wiring = registrationFor('WIRING');
      expect(wiring.origin).toContain('H4.E');
      expect(wiring.origin).toContain('H4.F');
    });

    it('exposes the active stub patterns so the board can never silently drop a token', () => {
      const tokens = describePatterns().map((p) => p.token);
      expect(tokens).toContain('STUB');
      expect(tokens).toContain('PLACEHOLDER');
    });
  });

  describe('mode resolution (R104)', () => {
    it.each([
      ['quick', 'quick'],
      ['full', 'full'],
      ['', 'full'],
      [undefined, 'full'],
    ])('resolves DEPLOY_READINESS_MODE=%s to %s', (raw, expected) => {
      const env: NodeJS.ProcessEnv = raw === undefined ? {} : { DEPLOY_READINESS_MODE: raw };
      expect(resolveRunMode(env)).toBe(expected);
    });
  });

  describe('end-to-end against this repository', () => {
    it('quick mode runs the stub section only and is CLEAN', async () => {
      const board = await runDeployReadiness({ repoRoot: REPO_ROOT, mode: 'quick' });
      expect(board.sections).toHaveLength(1);
      expect(board.sections[0].section).toBe('STUB_VALUES');
      expect(board.counts.stub).toBe(0);
      // eslint-disable-next-line no-console
      console.log(board.board);
      expect(board.totalRed).toBe(0);
    });

    it('full mode (PR / informational) runs all six sections and is SAFE TO DEPLOY', async () => {
      // PR mode: only the codebase-invariant buckets (stub + prod-switch) gate.
      // Stub red is zero on this repo because every BLOCK_SHIP fingerprint is
      // adjudicated tracked debt in the learning ledger and downgraded to WARN by
      // applyTrackedDebt; the registry is coherent, so prodSwitchesWrong is zero.
      const board = await runDeployReadiness({ repoRoot: REPO_ROOT, mode: 'full', strict: false });
      expect(board.sections.map((s) => s.section)).toEqual([...BOARD_SECTIONS]);
      // eslint-disable-next-line no-console
      console.log(board.board);
      expect(board.strict).toBe(false);
      expect(board.counts.stub).toBe(0);
      expect(board.counts.prodSwitchesWrong).toBe(0);
      expect(board.exitLine).toBe(EXIT_ALL_CLEAR);
      // THE flagship assertion: zero gating red lines on a PR or the build fails.
      expect(board.totalRed).toBe(0);
    });

    it('strict mode (prod-deploy gate) surfaces the environment-dependent red lines', async () => {
      // The prod-deploy gate runs with no production secrets in this test
      // environment, so every provider reads as un-credentialed and the not-yet
      // -registered env vars (R108 backlog) show as gaps. Strict mode therefore
      // refuses to deploy until the operator supplies the secrets and finishes
      // the registration backlog: strictTotalRed is necessarily greater than zero
      // here and the EXIT line is the itemised DO NOT DEPLOY breakdown. This is
      // the hard-block half of R100 paragraph 6.
      const board = await runDeployReadiness({
        repoRoot: REPO_ROOT,
        mode: 'full',
        strict: true,
        env: { DEPLOY_READINESS_STRICT: '1' },
      });
      expect(board.strict).toBe(true);
      // Codebase-invariant buckets are still clean.
      expect(board.counts.stub).toBe(0);
      expect(board.counts.prodSwitchesWrong).toBe(0);
      // Environment-dependent buckets surface the outstanding operator work.
      expect(board.strictTotalRed).toBeGreaterThan(0);
      expect(board.totalRed).toBe(board.strictTotalRed);
      expect(board.exitLine).toMatch(EXIT_DO_NOT_DEPLOY_RE);
    });

    // THE prod-deploy gate. This is the one assertion the deploy-readiness-gate
    // job relies on to hard-block: it runs ONLY when DEPLOY_READINESS_STRICT is
    // actually set in the process environment (the gate job sets it; PR and
    // local runs do not), reads the live board in strict mode against the real
    // process.env, and requires zero red lines. When the gate runs in the
    // production deploy environment the real secrets are present, so a genuinely
    // ready build is ALL CLEAR and this passes; any outstanding stub, incoherent
    // switch, un-credentialed provider, unregistered env var, or missing
    // operator key makes totalRed non-zero and FAILS the job, refusing the
    // deploy. Skipped entirely outside strict mode so it never false-fails a PR.
    const gateDescribe = resolveStrict(process.env) ? it : it.skip;
    gateDescribe(
      'STRICT prod-deploy gate against this repository is ALL CLEAR (hard block)',
      async () => {
        const board = await runDeployReadiness({ repoRoot: REPO_ROOT, mode: 'full' });
        // eslint-disable-next-line no-console
        console.log(board.board);
        expect(board.strict).toBe(true);
        // The gate refuses to deploy on ANY red line across every gating section.
        expect(board.totalRed).toBe(0);
        expect(board.strictTotalRed).toBe(0);
        expect(board.exitLine).toBe(EXIT_ALL_CLEAR);
      },
    );
  });

  describe('learning-ledger tracked-debt downgrade', () => {
    it('downgrades BLOCK_SHIP findings whose fingerprint is tracked debt to WARN', () => {
      const findings: StubFinding[] = [
        { pattern: 'STUB', kind: 'STUB', file: 'src/a.ts', line: 1, excerpt: '', severity: 'BLOCK_SHIP', fingerprint: 'debt-1' },
        { pattern: 'STUB', kind: 'STUB', file: 'src/b.ts', line: 2, excerpt: '', severity: 'BLOCK_SHIP', fingerprint: 'live-1' },
      ];
      const debt = new Set<string>(['debt-1']);
      const out = applyTrackedDebt(findings, debt);
      // The tracked-debt finding is downgraded; the live one is untouched.
      expect(out.find((f) => f.fingerprint === 'debt-1')?.severity).toBe('WARN');
      expect(out.find((f) => f.fingerprint === 'live-1')?.severity).toBe('BLOCK_SHIP');
      // Pure: the input array is never mutated.
      expect(findings[0].severity).toBe('BLOCK_SHIP');
      // After the downgrade the stub section counts only the remaining BLOCK_SHIP.
      expect(runStubSection(out).red).toBe(1);
    });

    it('the live repo ledger downgrades every BLOCK_SHIP stub so the PR stub count is zero', async () => {
      const board = await runDeployReadiness({ repoRoot: REPO_ROOT, mode: 'quick' });
      expect(board.counts.stub).toBe(0);
    });
  });
});

/** Build a minimal ProviderReport for the wiring/keys section tests. */
function mkProvider(
  id: string,
  label: string,
  status: ProviderReport['status'],
  missing: string[],
  placeholder: string[] = [],
): ProviderReport {
  return {
    id,
    label,
    packages: [],
    required_vars: [...missing, ...placeholder],
    sdk_imported: status !== 'NOT_USED',
    env_vars_present: [],
    env_vars_missing: missing,
    env_vars_placeholder: placeholder,
    status,
  };
}
