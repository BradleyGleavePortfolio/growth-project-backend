/**
 * test/deploy-readiness.spec.ts
 *
 * R100 PROD_READINESS_BOARD — the flagship test. One run, every stub,
 * every switch, every provider, every gap. See AGENT_RULES R100 + R108.
 *
 * Operator decisions baked in:
 *   - Q5: smart-smoke + context-aware + recursive learning (via stub-scanner + learning-ledger).
 *   - Q6a: registry seeded from ENV_RULES + process.env grep (`prod-switches.yml`).
 *   - Q6b (= R108): every new env var must be in the registry or CI fails.
 *   - Q7: provider list lives in `provider-wiring.ts`; SDK import + env both checked.
 *   - Q8: budget = 20 minutes; default run is < 10s, prod-mode adds checks.
 *   - Q9 case 1: switches with `auto_flip_on_in_prod=true` are flipped (or planned).
 *   - Q9 case 2: anything STUB / NOT WIRED → ship-block + appended to OPERATOR_KEYS_NEEDED.md.
 *
 * Run modes (env vars):
 *   - default (no NODE_ENV): runs all scanners as a DRY-RUN. Test passes
 *     unless an actual R108 violation or BLOCK_SHIP stub is present.
 *   - NODE_ENV=production: full prod-readiness gate. Every missing
 *     MUST_SET switch and every STUB provider fails the test.
 *   - READINESS_AUTO_FLIP=true + NODE_ENV=production: also applies the
 *     auto-flip plan via `flyctl secrets set` (requires FLY_API_TOKEN).
 *   - READINESS_FORMAT=markdown: writes the markdown report to stdout
 *     for `npm run readiness:report` consumption.
 *
 * Budget: 20 min (Q8). Real runtime is < 10s on a laptop — the budget
 * exists so future expansions (e.g. live HTTP pings) have headroom.
 */

import { autoFlip, type AppliedFlip, type FlipResult } from './prod-readiness/auto-flipper';
import { discoverEnvVars, type EnvVarOrigin } from './prod-readiness/env-discovery';
import { defaultLedgerPath, falsePositives, loadLedger, trackedDebt } from './prod-readiness/learning-ledger';
import { assertNoDrift, writeOperatorKeysMarkdown } from './prod-readiness/operator-keys-generator';
import { looksLikePlaceholder, scanProviders } from './prod-readiness/provider-wiring';
import { loadRegistry, type SwitchEntry } from './prod-readiness/registry-loader';
import { renderConsole, renderMarkdown, verdict, type ReadinessReport } from './prod-readiness/reporter';
import { scanForStubs, type StubFinding } from './prod-readiness/stub-scanner';

const REPO_ROOT = process.cwd();
const TIMEOUT_MS = 20 * 60 * 1000;

describe('R100 — Deploy readiness', () => {
  jest.setTimeout(TIMEOUT_MS);

  let registry: ReturnType<typeof loadRegistry>;
  let discovery: ReturnType<typeof discoverEnvVars>;
  let stubs: StubFinding[];
  let providers: ReturnType<typeof scanProviders>;
  let report: ReadinessReport;
  // Module-scope flip result (F-A05 / F-B06 / F-B08): the auto-flip is awaited
  // once in `beforeAll` and the resolved value is held here, so every test —
  // and the afterAll writer — reads a single, already-settled value instead of
  // re-awaiting a promise stashed on `global`.
  let flipResult: FlipResult;
  let appliedFlips: AppliedFlip[];
  let envOrigins: Map<string, EnvVarOrigin>;
  const isProdMode = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging';

  beforeAll(async () => {
    registry = loadRegistry();
    discovery = discoverEnvVars(REPO_ROOT);
    envOrigins = discovery.envVars;

    const ledger = loadLedger(defaultLedgerPath(REPO_ROOT));
    const fp = falsePositives(ledger);
    const td = trackedDebt(ledger);
    // Two scans: one unfiltered (for staleness check) and one filtered (for findings).
    // The unfiltered scan is the ground truth of what's actually in the source tree
    // right now; the filtered scan is what we report on after applying learned
    // false-positive exemptions.
    const allStubsUnfiltered = scanForStubs({ repoRoot: REPO_ROOT });
    const rawStubs = scanForStubs({ repoRoot: REPO_ROOT, knownFalsePositives: fp });
    // Tracked debt is downgraded BLOCK_SHIP → WARN.
    stubs = rawStubs.map((s) => {
      if (s.severity === 'BLOCK_SHIP' && td.has(s.fingerprint)) {
        return { ...s, severity: 'WARN' as const };
      }
      return s;
    });

    providers = scanProviders(REPO_ROOT, process.env);

    // R108: code references not in registry.
    const unregistered: string[] = [];
    for (const [name, origin] of discovery.envVars) {
      if (origin.inCode && !registry.byName.has(name)) unregistered.push(name);
    }

    // MUST_SET switches that have no value (placeholder counts as no value).
    // Uses the single shared looksLikePlaceholder (F-A09 / F-B05) so the spec
    // and provider-wiring can never diverge on what "placeholder" means.
    const isUnset = (v: string | undefined): boolean =>
      v === undefined || v === '' || looksLikePlaceholder(v);
    const switchesUnsetRequired = registry.switches.filter(
      (s: SwitchEntry) => s.prod_default === 'MUST_SET' && isUnset(process.env[s.name]),
    );

    // Dead ledger entries (fingerprint no longer matches any file:line).
    // Use the UNFILTERED scan as ground truth — a ledger entry should only
    // be considered stale if the underlying source line is genuinely gone,
    // not because the entry itself filtered the line out.
    const liveFingerprints = new Set(allStubsUnfiltered.map((s) => s.fingerprint));
    const ledgerDead = ledger.entries
      .map((e) => e.fingerprint)
      .filter((fpStr) => !liveFingerprints.has(fpStr));

    // Auto-flip plans (dry-run by default; apply only in prod mode w/ explicit flag).
    // Awaited directly here (F-A05): no promise leaks onto `global`, no later
    // re-await; the settled result drives both the report and the writer.
    const flipMode = isProdMode && process.env.READINESS_AUTO_FLIP === 'true' ? 'apply' : 'dry-run';
    flipResult = await autoFlip({ switches: registry.switches, env: process.env, mode: flipMode });
    appliedFlips = flipResult.appliedFlips;

    report = {
      generated_at: new Date().toISOString(),
      target_env: process.env.NODE_ENV ?? 'development',
      registry_size: registry.switches.length,
      env_var_count: discovery.envVars.size,
      unregistered_in_code: unregistered.sort(),
      ledger_dead_entries: ledgerDead.sort(),
      switches_unset_in_prod: switchesUnsetRequired,
      stubs,
      providers,
      flips: flipResult.plans,
    };
  });

  it('prod-switches.yml exists, parses, and has every entry valid', () => {
    expect(registry.switches.length).toBeGreaterThan(0);
  });

  it('R108 — every env var referenced in src/ is registered in prod-switches.yml', () => {
    if (report.unregistered_in_code.length > 0) {
      // eslint-disable-next-line no-console
      console.error(
        `\nR108 violation. ${report.unregistered_in_code.length} env var(s) referenced in src/ are missing from prod-switches.yml:\n` +
        report.unregistered_in_code.slice(0, 40).map((n) => `  - ${n}`).join('\n') +
        (report.unregistered_in_code.length > 40 ? `\n  ... ${report.unregistered_in_code.length - 40} more\n` : '\n') +
        `\nAdd a row to prod-switches.yml for each. See AGENT_RULES R108.\n`,
      );
    }
    expect(report.unregistered_in_code).toEqual([]);
  });

  it('no BLOCK_SHIP stub markers in src/ outside exempt zones', () => {
    const blockers = report.stubs.filter((s) => s.severity === 'BLOCK_SHIP');
    if (blockers.length > 0) {
      // eslint-disable-next-line no-console
      console.error(
        `\n${blockers.length} BLOCK_SHIP stub finding(s):\n` +
        blockers.slice(0, 30).map((s) => `  - [${s.pattern}] ${s.file}:${s.line}  ${s.excerpt.slice(0, 100)}`).join('\n') +
        '\nFix the underlying stub, or add a `tracked_debt` entry to test/prod-readiness/__fixtures__/learning-ledger.json with rationale.\n',
      );
    }
    expect(blockers).toEqual([]);
  });

  it('learning ledger has no stale entries (fingerprints still match real lines)', () => {
    expect(report.ledger_dead_entries).toEqual([]);
  });

  it('every applied auto-flip succeeded (failed flips escalate to NEEDS_OPERATOR)', () => {
    // F-A03: in apply mode a failed flip is an operator-actionable gap, not a
    // silent no-op. Surface each failure with its switch name so the operator
    // knows exactly which secret to set, then fail the test.
    const failed = appliedFlips.filter((f) => !f.ok);
    if (failed.length > 0) {
      // eslint-disable-next-line no-console
      console.error(
        `\n${failed.length} auto-flip(s) FAILED — set these manually before deploy:\n` +
        failed.map((f) => `  - ${f.name}: ${f.error ?? 'unknown error'}`).join('\n') +
        '\n',
      );
    }
    expect(failed).toEqual([]);
  });

  describe('prod-mode gates', () => {
    it('(prod-mode only) every MUST_SET switch has a non-placeholder value', () => {
      if (!isProdMode) {
        // eslint-disable-next-line no-console
        console.log(`(dry-run) ${report.switches_unset_in_prod.length} MUST_SET switches would be flagged in prod mode; ${report.flips.length} would be auto-flipped.`);
        return;
      }
      expect(report.switches_unset_in_prod).toEqual([]);
    });

    it('(prod-mode only) every imported provider has its required vars set with non-placeholder values', () => {
      const stubProviders = report.providers.filter((p) => p.status === 'STUB');
      if (!isProdMode) {
        // eslint-disable-next-line no-console
        console.log(`(dry-run) ${stubProviders.length} provider(s) would be flagged STUB in prod mode.`);
        return;
      }
      if (stubProviders.length > 0) {
        // eslint-disable-next-line no-console
        console.error(
          '\nSTUB providers:\n' +
          stubProviders.map((p) => `  - ${p.label}  missing=${p.env_vars_missing.join(',')}  placeholder=${p.env_vars_placeholder.join(',')}`).join('\n'),
        );
      }
      expect(stubProviders).toEqual([]);
    });
  });

  it('OPERATOR_KEYS_NEEDED.md committed to git matches freshly-generated content', () => {
    // F-A06 / F-A16: the checked-in artifact must not drift from what the
    // scanners produce. The timestamp line is excluded by assertNoDrift.
    const drift = assertNoDrift(REPO_ROOT, {
      generated_at: report.generated_at,
      switches_unset_required: report.switches_unset_in_prod,
      providers_stubbed: report.providers.filter((p) => p.status === 'STUB'),
      unregistered_in_code: report.unregistered_in_code,
      applied_flips: appliedFlips,
      env_origins: envOrigins,
    });
    if (drift.drifted) {
      // eslint-disable-next-line no-console
      console.error(
        `\nOPERATOR_KEYS_NEEDED.md is stale: ${drift.detail ?? 'content differs'}.\n` +
        'Re-run `npm run readiness:check` and commit the regenerated file.\n',
      );
    }
    expect(drift.drifted).toBe(false);
  });

  it('overall verdict reflects the current gap state', () => {
    // F-B16: the verdict function is the single source of truth for ship
    // status; assert it explicitly so a regression in its logic is caught.
    // In the committed repo state there is at least one stubbed provider /
    // unset MUST_SET switch, so the steady-state verdict is NEEDS_OPERATOR.
    const v = verdict(report);
    expect(['CLEAN', 'NEEDS_OPERATOR', 'SHIP_BLOCKED']).toContain(v);
    expect(v).toBe('NEEDS_OPERATOR');
  });

  afterAll(() => {
    // Always write OPERATOR_KEYS_NEEDED.md — the report is the artifact.
    // Uses the module-scope settled flip result (F-A05): no re-await, no global.
    writeOperatorKeysMarkdown(REPO_ROOT, {
      generated_at: report.generated_at,
      switches_unset_required: report.switches_unset_in_prod,
      providers_stubbed: report.providers.filter((p) => p.status === 'STUB'),
      unregistered_in_code: report.unregistered_in_code,
      applied_flips: appliedFlips,
      env_origins: envOrigins,
    });

    // Emit format requested by the operator.
    const format = process.env.READINESS_FORMAT ?? 'console';
    // eslint-disable-next-line no-console
    if (format === 'markdown') {
      console.log(renderMarkdown(report));
    } else {
      console.log('\n' + renderConsole(report));
    }
    // eslint-disable-next-line no-console
    console.log(`\nverdict: ${verdict(report)}`);
  });
});
