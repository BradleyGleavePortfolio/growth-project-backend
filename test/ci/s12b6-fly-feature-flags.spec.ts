// S12-B6 / S9 review closure (S12B6-SOL-B1, S12B6-SOL-B2, S9A584-B1, S9A584-B2,
// S9B-584-A1, S9B-584-B1..B3, S9A2-584-B1, S9-B2 C1): workflow tests for
// .github/workflows/fly-feature-flags-set.yml.
//
// What this file proves, and how:
//  - Structural invariants of the YAML (dispatch-only; EVERY input is a closed
//    `type: choice` with a fixed option list and a default drawn from it — no
//    free-text input exists (S9A2-584-B1); no allowlist input; allowlist only
//    from the GitHub secret; shell: bash; permissions; production environment;
//    no inline `${{ inputs.* }}` in run: blocks; the deadline options and the
//    validators' closed sets are one and the same list).
//  - `clear` unsets FEATURE_SCOUT_PILOT_COACH_IDS via `flyctl secrets unset`
//    (S9-B2 C1) before the single `secrets set`, and verification requires an
//    unset name to be ABSENT and a set name to be present.
//  - EVERY shell step of the job is extracted from the parsed YAML and
//    executed under `bash --noprofile --norc -eo pipefail <file>` — the exact
//    invocation the Actions runner uses for `shell: bash` (S9B-584-B3) — with
//    synthetic env vars standing in for the `${{ inputs.* }}` /
//    `${{ secrets.* }}` values. `flyctl` is a stub on PATH that records its
//    argv to a file and can replay a canned `secrets list --json` body; it
//    never prints its argv. Nothing here talks to Fly or GitHub.
//  - Differential specs: the real "Validate pilot coach allowlist" step and
//    the app's real parsePilotCoachAllowlist run over ONE shared case table,
//    and the real "Validate scout run deadline" step runs against the app's
//    grammar of ScoutLifecycleService.readDeadlineMs (regex literal read from
//    its source, see below). The invariant asserted is
//    "workflow accepts ⇒ app admits every entry / honours the value"; the
//    workflow may be stricter (harmless direction) but never looser.
//  - Value redaction: the synthetic UUIDs and secret-ish strings used here
//    never appear in any step's stdout/stderr. Assertions are made on names,
//    counts and the recorded argv array, not on printed values.
//
// What this file does NOT prove: anything about the rendered public Actions
// log (GitHub prints non-secret `env:` values there — the reason the
// allowlist is a secret, not an input, and the reason every input is a closed
// choice), GitHub's server-side rejection of a dispatch value outside a
// choice's option list (HTTP 422 — the in-job validators re-check the closed
// sets regardless), the production environment approval gate, real Fly API
// behaviour, or real flyctl output. Those need a real, owner-approved
// dispatch and are out of scope for a test file. Never dispatch the real
// workflow against production as a test.

import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { load as parseYaml } from 'js-yaml';
import { tmpdir } from 'os';
import { join } from 'path';
import { parsePilotCoachAllowlist } from '../../src/common/feature-flag/pilot-coach-allowlist';

// ScoutLifecycleService.readDeadlineMs is the app's deadline grammar. Its
// module pulls in the generated Prisma client, so instead of importing it
// (which would tie this workflow spec to `prisma generate`) the exact regex
// literal is read out of readDeadlineMs's source and re-evaluated here. The
// textual assertion below fails if that line ever changes shape.
const LIFECYCLE_SRC = readFileSync(join(__dirname, '..', '..', 'src/scout/lifecycle/lifecycle.service.ts'), 'utf8');
const APP_DEADLINE_RE_SRC = (() => {
  const m = LIFECYCLE_SRC.match(/static readDeadlineMs\(raw: string \| undefined\): number \{\s*\n\s*if \(raw === undefined \|\| !\/(.+?)\/\.test\(raw\)\) return SCOUT_RUN_DEADLINE_MS_DEFAULT;/);
  if (!m) throw new Error('readDeadlineMs regex literal not found in lifecycle.service.ts');
  return m[1];
})();
const APP_DEADLINE_DEFAULT = 300_000;
/** Same semantics as ScoutLifecycleService.readDeadlineMs, using the app's own regex text. */
function appReadDeadlineMs(raw: string | undefined): number {
  if (raw === undefined || !new RegExp(APP_DEADLINE_RE_SRC).test(raw)) return APP_DEADLINE_DEFAULT;
  return Number(raw);
}

const ROOT = join(__dirname, '..', '..');
const WORKFLOW_PATH = join(ROOT, '.github/workflows/fly-feature-flags-set.yml');

type Step = { name?: string; run?: string; env?: Record<string, string>; uses?: string };
type Job = { steps?: Step[]; environment?: unknown; defaults?: { run?: { shell?: string } } };
type Doc = {
  on?: {
    workflow_dispatch?: {
      inputs?: Record<string, { default?: unknown; required?: unknown; type?: unknown; options?: unknown }>;
    };
  };
  jobs?: Record<string, Job>;
};

const STEP = {
  target: 'Validate Fly app target',
  confirm: 'Confirm operator intent',
  flags: 'Validate flag values (unchanged = leave alone, S12B6-SOL-B1)',
  deadline: 'Validate scout run deadline (unchanged = leave alone)',
  allowlist: 'Validate pilot coach allowlist (from secret; never an input)',
  token: 'Check Fly token configuration',
  push: 'Push feature flags to Fly (only inputs explicitly set this dispatch)',
  verify: 'Verify pushed names are present on Fly',
} as const;

const APP = 'backend-spring-lake-3890';
const FLAG_INPUTS = ['feature_scout_ingest', 'feature_extension_pairing', 'feature_scout_reconstruct'] as const;
// The closed deadline choices (ms). Must stay identical to the YAML options,
// the deadline validator's case list and the push step's case list — asserted
// structurally below.
const DEADLINE_CHOICES = ['300000', '900000', '1800000', '3600000'];
// Synthetic, syntactically valid UUIDs. Never real coach ids.
const U1 = '11111111-1111-1111-1111-111111111111';
const U2 = '22222222-2222-2222-2222-222222222222';
const U3 = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
const SECRETISH = 'sk-super-secret-token-should-not-appear-9f8e7d6c';

function loadDoc(): Doc {
  return parseYaml(readFileSync(WORKFLOW_PATH, 'utf8')) as Doc;
}

function loadJob(): Job {
  const job = loadDoc().jobs?.['fly-feature-flags-set'];
  if (!job?.steps) throw new Error('fly-feature-flags-set job/steps not found');
  return job;
}

function findStep(name: string): Step {
  const step = loadJob().steps!.find((s) => s.name === name);
  if (!step?.run) throw new Error(`step not found or has no run: block: ${name}`);
  return step;
}

type FlyStub = {
  /** Canned stdout for `flyctl secrets list ... --json`. */
  listJson?: string;
  /** Exit code for `flyctl secrets list`. Default 0. */
  listExit?: number;
  /** Exit code for `flyctl secrets set`. Default 0. */
  setExit?: number;
  /** Exit code for `flyctl secrets unset`. Default 0. */
  unsetExit?: number;
};

type RunResult = {
  code: number | null;
  out: string;
  /** argv of every flyctl invocation, in order (each element is one argv array). */
  flyctlCalls: string[][];
  /** Lines appended to $GITHUB_ENV by the step. */
  githubEnv: string[];
};

/**
 * Executes one step's `run:` block exactly as the runner does for
 * `shell: bash`: the script is written to a file and run with
 * `bash --noprofile --norc -eo pipefail <file>`. The environment is ONLY what
 * the step would see: PATH (with the flyctl stub first), HOME, GITHUB_ENV, and
 * the supplied synthetic env: values. Unspecified vars are absent, not empty.
 */
function runStep(step: Step, env: Record<string, string>, fly: FlyStub = {}): RunResult {
  const dir = mkdtempSync(join(tmpdir(), 's12b6-'));
  const script = join(dir, 'step.sh');
  writeFileSync(script, step.run as string);
  const githubEnv = join(dir, 'github_env');
  writeFileSync(githubEnv, '');
  const binDir = join(dir, 'bin');
  mkdirSync(binDir);
  const argvLog = join(dir, 'flyctl-argv.log');
  const listBody = join(dir, 'list.json');
  writeFileSync(listBody, fly.listJson ?? '[]');
  // The stub records argv NUL-separated (one record per call, terminated by
  // a record separator) and prints nothing derived from its arguments.
  writeFileSync(
    join(binDir, 'flyctl'),
    [
      '#!/usr/bin/env bash',
      'printf "%s\\0" "$@" >> "${STUB_ARGV_LOG}"',
      'printf "\\x1e" >> "${STUB_ARGV_LOG}"',
      'if [ "${1:-}" = "secrets" ] && [ "${2:-}" = "list" ]; then',
      '  cat "${STUB_LIST_BODY}"',
      '  exit "${STUB_LIST_EXIT}"',
      'fi',
      'if [ "${1:-}" = "secrets" ] && [ "${2:-}" = "set" ]; then',
      '  echo "stub: Machine 000000000000 [app] update succeeded"',
      '  exit "${STUB_SET_EXIT}"',
      'fi',
      'if [ "${1:-}" = "secrets" ] && [ "${2:-}" = "unset" ]; then',
      '  echo "stub: Machine 000000000000 [app] update succeeded"',
      '  exit "${STUB_UNSET_EXIT}"',
      'fi',
      'echo "stub: unexpected flyctl subcommand" >&2',
      'exit 99',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], {
    encoding: 'utf8',
    env: {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      HOME: process.env.HOME ?? '/tmp',
      GITHUB_ENV: githubEnv,
      STUB_ARGV_LOG: argvLog,
      STUB_LIST_BODY: listBody,
      STUB_LIST_EXIT: String(fly.listExit ?? 0),
      STUB_SET_EXIT: String(fly.setExit ?? 0),
      STUB_UNSET_EXIT: String(fly.unsetExit ?? 0),
      ...env,
    },
  });
  const flyctlCalls = existsSync(argvLog)
    ? readFileSync(argvLog, 'utf8')
        .split('\x1e')
        .filter((rec) => rec.length > 0)
        .map((rec) => rec.split('\0').filter((_, i, arr) => i < arr.length - 1))
    : [];
  return {
    code: r.status,
    out: `${r.stdout ?? ''}\n${r.stderr ?? ''}`,
    flyctlCalls,
    githubEnv: readFileSync(githubEnv, 'utf8').split('\n').filter((l) => l.length > 0),
  };
}

/** No synthetic UUID / secret-ish value may ever reach a step's stdout/stderr. */
function expectNoValueLeak(out: string, extra: string[] = []) {
  for (const v of [U1, U2, U3, U3.toLowerCase(), SECRETISH, ...extra]) {
    if (v.length === 0) continue;
    expect(out).not.toContain(v);
  }
}

// Every input at its default: nothing selected for change.
const PUSH_ENV_EMPTY = {
  APP,
  FLY_API_TOKEN: 'stub-token',
  SCOUT: 'unchanged',
  RECONSTRUCT: 'unchanged',
  PAIRING: 'unchanged',
  DEADLINE: 'unchanged',
  ALLOWLIST_MODE: 'unchanged',
  COACH_IDS: '',
};
const UNSET_ARGV = ['secrets', 'unset', '-a', APP, 'FEATURE_SCOUT_PILOT_COACH_IDS'];

// A `flyctl secrets list --json` body in the shape flyctl renders
// (internal/command/secrets/list.go: SecretWithStatus{name,digest,status}).
function listJson(rows: Array<{ name: string; status?: string }>): string {
  return JSON.stringify(
    rows.map((r, i) => ({ name: r.name, digest: `d1g3st${String(i).padStart(10, '0')}`, ...(r.status ? { status: r.status } : {}) })),
  );
}

// ---------------------------------------------------------------------------

describe('fly-feature-flags-set.yml — structural invariants (S12-B6 / S9B-584-A1)', () => {
  const yml = readFileSync(WORKFLOW_PATH, 'utf8');

  it('is workflow_dispatch only, never push/pull_request/schedule', () => {
    const on = yml.slice(yml.indexOf('\non:'), yml.indexOf('\npermissions:'));
    expect(on).toMatch(/workflow_dispatch:/);
    expect(on).not.toMatch(/^\s+push:/m);
    expect(on).not.toMatch(/pull_request/);
    expect(on).not.toMatch(/schedule/);
  });

  it('S9A2-584-B1: EVERY workflow_dispatch input is a closed type: choice — string options only, default drawn from them; no free-text input exists', () => {
    const inputs = loadDoc().on?.workflow_dispatch?.inputs ?? {};
    expect(Object.keys(inputs).sort()).toEqual(
      ['app', 'confirm', 'feature_extension_pairing', 'feature_scout_ingest', 'feature_scout_reconstruct', 'pilot_allowlist', 'scout_run_deadline_ms'].sort(),
    );
    for (const [name, spec] of Object.entries(inputs)) {
      expect([name, spec.type]).toEqual([name, 'choice']);
      expect(Array.isArray(spec.options)).toBe(true);
      const options = spec.options as unknown[];
      expect(options.length).toBeGreaterThanOrEqual(1);
      // Options like true/false/300000 must be quoted in the YAML so they stay
      // strings (an unquoted `true` would parse as a YAML boolean).
      for (const o of options) expect(typeof o).toBe('string');
      expect(new Set(options).size).toBe(options.length);
      expect(typeof spec.default).toBe('string');
      expect(options).toContain(spec.default);
    }
  });

  it('S12B6-SOL-B1: every flag and the deadline input is [unchanged, ...] defaulting to unchanged (no default-on mutation)', () => {
    const inputs = loadDoc().on?.workflow_dispatch?.inputs ?? {};
    for (const name of FLAG_INPUTS) {
      expect(inputs[name].options).toEqual(['unchanged', 'true', 'false']);
      expect(inputs[name].default).toBe('unchanged');
      expect(inputs[name].required).toBe(false);
    }
    expect(inputs['scout_run_deadline_ms'].options).toEqual(['unchanged', ...DEADLINE_CHOICES]);
    expect(inputs['scout_run_deadline_ms'].default).toBe('unchanged');
    expect(inputs['scout_run_deadline_ms'].required).toBe(false);
  });

  it('S9A2-584-B1: app is a one-option choice; confirm is [no, SET] defaulting to the non-confirming no', () => {
    const inputs = loadDoc().on?.workflow_dispatch?.inputs ?? {};
    expect(inputs['app'].options).toEqual([APP]);
    expect(inputs['app'].default).toBe(APP);
    expect(inputs['app'].required).toBe(true);
    expect(inputs['confirm'].options).toEqual(['no', 'SET']);
    expect(inputs['confirm'].default).toBe('no');
    expect(inputs['confirm'].required).toBe(true);
  });

  it('the deadline choice list, the deadline validator and the push step agree on exactly the same closed set, all within the app grammar', () => {
    const inputs = loadDoc().on?.workflow_dispatch?.inputs ?? {};
    const yamlChoices = (inputs['scout_run_deadline_ms'].options as string[]).filter((o) => o !== 'unchanged');
    expect(yamlChoices).toEqual(DEADLINE_CHOICES);
    // Literal bash `case` alternative list `300000|900000|1800000|3600000` (pipes escaped for the regex).
    const caseList = DEADLINE_CHOICES.join('\\|');
    // The validator: a `case` with exactly this alternative list.
    expect(findStep(STEP.deadline).run).toMatch(new RegExp(`^\\s*${caseList}\\) ;;$`, 'm'));
    // The push step re-checks the same list before building the argument.
    expect(findStep(STEP.push).run).toMatch(new RegExp(`^\\s*${caseList}\\)$`, 'm'));
    for (const c of DEADLINE_CHOICES) {
      expect(new RegExp(APP_DEADLINE_RE_SRC).test(c)).toBe(true);
      expect(appReadDeadlineMs(c)).toBe(Number(c));
    }
    expect(DEADLINE_CHOICES).toContain(String(APP_DEADLINE_DEFAULT));
  });

  it('S9B-584-A1: the allowlist VALUE is not a workflow input; pilot_allowlist is a closed choice defaulting to unchanged', () => {
    const inputs = loadDoc().on?.workflow_dispatch?.inputs ?? {};
    expect(inputs['feature_scout_pilot_coach_ids']).toBeUndefined();
    for (const name of Object.keys(inputs)) expect(name).not.toMatch(/coach_ids|allowlist_value/);
    expect(inputs['pilot_allowlist']).toBeDefined();
    expect(inputs['pilot_allowlist'].type).toBe('choice');
    expect(inputs['pilot_allowlist'].default).toBe('unchanged');
    expect(inputs['pilot_allowlist'].options).toEqual(['unchanged', 'push-from-secret', 'clear']);
  });

  it('S9B-584-A1: COACH_IDS reaches shell only from the FEATURE_SCOUT_PILOT_COACH_IDS secret, never from inputs.*', () => {
    const steps = loadJob().steps ?? [];
    let seen = 0;
    for (const st of steps) {
      for (const [k, v] of Object.entries(st.env ?? {})) {
        const val = String(v);
        if (k === 'COACH_IDS' || /COACH_IDS/.test(val)) {
          seen += 1;
          expect(val.replace(/\s+/g, '')).toBe('${{secrets.FEATURE_SCOUT_PILOT_COACH_IDS}}');
        }
        if (/inputs\./.test(val)) expect(val).not.toMatch(/coach|allowlist_value/i);
      }
    }
    expect(seen).toBeGreaterThanOrEqual(2); // validator + push
    // and the push step is the only step that hands the value to flyctl
    const push = findStep(STEP.push);
    expect(push.env?.COACH_IDS).toBeDefined();
    expect(push.run).toMatch(/FEATURE_SCOUT_PILOT_COACH_IDS=\$\{COACH_IDS\}/);
  });

  it('does not claim values are withheld from the log (GitHub renders non-secret env: values)', () => {
    expect(yml).not.toMatch(/Value withheld from this log/);
  });

  it('S9B-584-B3: every step runs under shell: bash (runner = bash --noprofile --norc -eo pipefail)', () => {
    expect(loadJob().defaults?.run?.shell).toBe('bash');
    for (const st of loadJob().steps ?? []) if (st.run) expect((st as { shell?: string }).shell ?? 'bash').toBe('bash');
  });

  it('permissions is contents: read only; bound to the production environment', () => {
    expect(yml).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(yml).toMatch(/^\s+environment: production$/m);
    expect(loadJob().environment).toBe('production');
  });

  it('no step run: block interpolates inputs.* or secrets.* directly (all go through env:)', () => {
    const inline = /\$\{\{\s*(github\.event\.)?(inputs|secrets)\./;
    for (const st of loadJob().steps ?? []) if (st.run) expect(st.run).not.toMatch(inline);
  });

  it('never runs a destructive or deploying flyctl command; only secrets set/list, plus one literal unset of FEATURE_SCOUT_PILOT_COACH_IDS (S9-B2 C1)', () => {
    const mutate = /flyctl\s+(machines?\s+(start|stop|restart|destroy|kill|update)|deploy|scale)\b/;
    const unsetLines: string[] = [];
    for (const st of loadJob().steps ?? []) {
      if (!st.run) continue;
      expect(st.run).not.toMatch(mutate);
      const code = st.run
        .split('\n')
        .filter((l) => !/^\s*#/.test(l))
        .join('\n');
      for (const m of code.matchAll(/flyctl\s+(\S+)\s+(\S+)/g)) {
        expect(m[1]).toBe('secrets');
        expect(['set', 'list', 'unset']).toContain(m[2]);
      }
      for (const line of code.split('\n')) if (/flyctl\s+secrets\s+unset/.test(line)) unsetLines.push(line.trim());
    }
    // Exactly one unset, in the push step, with a fixed literal name (never a variable).
    expect(unsetLines).toEqual(['flyctl secrets unset -a "${APP}" FEATURE_SCOUT_PILOT_COACH_IDS']);
    expect(findStep(STEP.push).run).toContain(unsetLines[0]);
  });

  it('all eight shell steps exist in the expected order, with the app-target guard before any credentialed step', () => {
    const names = (loadJob().steps ?? []).filter((s) => s.run).map((s) => s.name);
    expect(names).toEqual([STEP.target, STEP.confirm, STEP.flags, STEP.deadline, STEP.allowlist, STEP.token, STEP.push, STEP.verify]);
    const steps = loadJob().steps ?? [];
    const firstCredentialed = steps.findIndex((st) => /FLY_API_TOKEN/.test(JSON.stringify(st.env ?? {})));
    expect(steps.findIndex((st) => st.name === STEP.target)).toBeLessThan(firstCredentialed);
  });
});

// ---------------------------------------------------------------------------

describe('"Validate Fly app target" step (executed)', () => {
  it('accepts the one allowed production app', () => {
    const r = runStep(findStep(STEP.target), { APP });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/App target allowed/);
  });

  it.each(['', 'backend-spring-lake-3890 ', 'backend-spring-lake-3891', 'other-app', '*', 'backend-spring-lake-3890;evil'])(
    'rejects %j with exit 1 before anything else',
    (app) => {
      const r = runStep(findStep(STEP.target), { APP: app });
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/::error::app input is not an allowed Fly app target/);
      expect(r.flyctlCalls).toEqual([]);
    },
  );
});

describe('"Confirm operator intent" step (executed)', () => {
  it('accepts exactly SET', () => {
    const r = runStep(findStep(STEP.confirm), { CONFIRM: 'SET' });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Operator confirmed/);
  });

  it.each(['no', '', 'set', 'SET ', ' SET', 'yes', 'true', SECRETISH])('rejects %j (incl. the default `no`) with exit 1 and does not echo it', (confirm) => {
    const r = runStep(findStep(STEP.confirm), { CONFIRM: confirm });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/::error::confirm input must be the literal string 'SET'/);
    expectNoValueLeak(r.out);
  });
});

describe('"Check Fly token configuration" step (executed)', () => {
  it('fails closed when the FLY_API_TOKEN secret is empty', () => {
    const r = runStep(findStep(STEP.token), { FLY_API_TOKEN: '' });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/::error::FLY_API_TOKEN secret is not set/);
  });

  it('fails closed when the FLY_API_TOKEN secret is absent entirely', () => {
    const r = runStep(findStep(STEP.token), {});
    expect(r.code).toBe(1);
  });

  it('passes when configured and never prints the token', () => {
    const r = runStep(findStep(STEP.token), { FLY_API_TOKEN: SECRETISH });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/FLY_API_TOKEN is configured/);
    expectNoValueLeak(r.out);
  });
});

// ---------------------------------------------------------------------------

describe('"Validate flag values" step (executed, S12B6-SOL-B1 / B2)', () => {
  const step = () => findStep(STEP.flags);

  it('accepts all three flags at unchanged (nothing selected) with exit 0', () => {
    const r = runStep(step(), { SCOUT: 'unchanged', RECONSTRUCT: 'unchanged', PAIRING: 'unchanged' });
    expect(r.code).toBe(0);
    expect(r.out.match(/unchanged, leaving current Fly value untouched/g)).toHaveLength(3);
  });

  it('accepts a mix of unchanged and valid true/false with exit 0', () => {
    const r = runStep(step(), { SCOUT: 'true', RECONSTRUCT: 'unchanged', PAIRING: 'false' });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/feature_scout_ingest: valid boolean/);
    expect(r.out).toMatch(/feature_scout_reconstruct: unchanged/);
    expect(r.out).toMatch(/feature_extension_pairing: valid boolean/);
  });

  it('rejects a value outside the closed set with exit 1 and does not echo the value itself', () => {
    const r = runStep(step(), { SCOUT: SECRETISH, RECONSTRUCT: 'unchanged', PAIRING: 'unchanged' });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/::error::feature_scout_ingest must be exactly 'true', 'false', or 'unchanged'/);
    expectNoValueLeak(r.out);
  });

  it('reports every offending input, not just the first', () => {
    const r = runStep(step(), { SCOUT: 'yes', RECONSTRUCT: 'true', PAIRING: 'no' });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/::error::feature_scout_ingest must be/);
    expect(r.out).toMatch(/::error::feature_extension_pairing must be/);
    expect(r.out).not.toMatch(/::error::feature_scout_reconstruct/);
  });

  it.each(['', 'TRUE', 'False', '1', '0', ' true', 'true ', 'true\n', 'on', 'Unchanged', 'unchanged '])(
    'rejects %j as not exactly one of the choice options (empty included: the choice type never yields it)',
    (bad) => {
      const r = runStep(step(), { SCOUT: bad, RECONSTRUCT: 'unchanged', PAIRING: 'unchanged' });
      expect(r.code).toBe(1);
    },
  );
});

// ---------------------------------------------------------------------------

describe('"Validate scout run deadline" step (executed) — differential against the app\'s readDeadlineMs grammar', () => {
  const step = () => findStep(STEP.deadline);

  it('unchanged means unchanged (exit 0, no value)', () => {
    const r = runStep(step(), { DEADLINE: 'unchanged' });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/scout_run_deadline_ms: unchanged, leaving current Fly value untouched/);
  });

  it.each(DEADLINE_CHOICES)('accepts the choice option %j, which the app honours exactly', (value) => {
    const r = runStep(step(), { DEADLINE: value });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(new RegExp(`scout_run_deadline_ms: valid choice \\(${value} ms\\), will be set`));
    expect(appReadDeadlineMs(value)).toBe(Number(value));
  });

  // [value, appHonours]. The app honours /^[1-9][0-9]{0,9}$/ (positive
  // integer, no leading zeros, at most 10 digits) and silently falls back to
  // the 300000 ms default for anything else. None of these is a choice
  // option, so the workflow rejects ALL of them — those the app would honour
  // are the deliberate stricter-in-the-harmless-direction cases (the closed
  // dropdown is the point, S9A2-584-B1); the rest the app would ignore anyway.
  const REJECTED: Array<[string, boolean]> = [
    ['1', true],
    ['60000', true],
    ['240000', true],
    ['9999999999', true],
    ['10000000000', false],
    ['0', false],
    ['-1', false],
    ['01', false],
    ['1.5', false],
    ['1e3', false],
    ['abc', false],
    ['', false],
    [' 300000', false],
    ['300000 ', false],
    ['300000\n', false],
    ['300000ms', false],
    ['+300000', false],
    ['１', false],
    ['Unchanged', false],
    [SECRETISH, false],
  ];

  it.each(REJECTED)('rejects the non-option %j (app would honour it: %s) without echoing it', (value, appHonours) => {
    expect(DEADLINE_CHOICES).not.toContain(value);
    // The app's oracle is its regex: a match is honoured verbatim, anything
    // else falls back to the default. (Number(' 300000') happens to equal the
    // default, so equality with Number(value) is NOT a usable oracle.)
    expect(new RegExp(APP_DEADLINE_RE_SRC).test(value)).toBe(appHonours);
    if (appHonours) expect(appReadDeadlineMs(value)).toBe(Number(value));
    else expect(appReadDeadlineMs(value)).toBe(APP_DEADLINE_DEFAULT);
    const r = runStep(step(), { DEADLINE: value });
    expect(r.code).toBe(1);
    const optionsText = `${DEADLINE_CHOICES.join(', ')}, or 'unchanged'`;
    expect(r.out).toContain(`::error::scout_run_deadline_ms must be one of ${optionsText}`);
    expect(r.out).not.toMatch(/will be set/);
    // The error names the options, so the non-leak assertion can only cover
    // values that are not a substring of that fixed option text (e.g. 60000
    // is inside 3600000).
    const trimmed = value.trim();
    expectNoValueLeak(r.out, trimmed.length >= 4 && !optionsText.includes(trimmed) ? [trimmed] : []);
  });

  it('invariant: workflow accepts ⇒ app honours, over every value exercised here', () => {
    for (const value of [...DEADLINE_CHOICES, ...REJECTED.map(([v]) => v)]) {
      const r = runStep(step(), { DEADLINE: value });
      if (r.code === 0) {
        expect(new RegExp(APP_DEADLINE_RE_SRC).test(value)).toBe(true);
        expect(appReadDeadlineMs(value)).toBe(Number(value));
      }
    }
  });

  it('the workflow still re-checks the app grammar textually as in readDeadlineMs (defence in depth), and the default is 300000', () => {
    expect(APP_DEADLINE_RE_SRC).toBe('^[1-9][0-9]{0,9}$');
    expect(LIFECYCLE_SRC).toMatch(/export const SCOUT_RUN_DEADLINE_MS_DEFAULT = 300_000;/);
    expect(step().run).toMatch(/=~ \^\[1-9\]\[0-9\]\{0,9\}\$/);
    // Bash ERE and JS RegExp agree on this grammar for every case above.
    for (const value of [...DEADLINE_CHOICES, ...REJECTED.map(([v]) => v)]) {
      expect(new RegExp(APP_DEADLINE_RE_SRC).test(value)).toBe(/^[1-9][0-9]{0,9}$/.test(value));
    }
  });
});

// ---------------------------------------------------------------------------

describe('"Validate pilot coach allowlist" step (executed) — modes', () => {
  const step = () => findStep(STEP.allowlist);

  it('unchanged: exit 0, does not touch or mention the secret value (even if one is configured)', () => {
    const r = runStep(step(), { ALLOWLIST_MODE: 'unchanged', COACH_IDS: U1 });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/pilot_allowlist: unchanged/);
    expectNoValueLeak(r.out);
  });

  it('clear: exit 0 and described as an UNSET that goes dark', () => {
    const r = runStep(step(), { ALLOWLIST_MODE: 'clear', COACH_IDS: '' });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/will UNSET FEATURE_SCOUT_PILOT_COACH_IDS on Fly \(pilot surface goes dark/);
  });

  it('push-from-secret with the secret empty: exit 1 naming the secret and the gh command', () => {
    const r = runStep(step(), { ALLOWLIST_MODE: 'push-from-secret', COACH_IDS: '' });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/::error::pilot_allowlist=push-from-secret but the GitHub Actions secret FEATURE_SCOUT_PILOT_COACH_IDS is empty or not configured/);
    expect(r.out).toMatch(/gh secret set FEATURE_SCOUT_PILOT_COACH_IDS --env production/);
  });

  it('push-from-secret with the secret absent entirely: exit 1', () => {
    const r = runStep(step(), { ALLOWLIST_MODE: 'push-from-secret' });
    expect(r.code).toBe(1);
  });

  it.each(['', 'push', 'clear ', 'UNCHANGED', '__CLEAR__', U1])('rejects an unknown mode %j with exit 1 and does not echo it', (mode) => {
    const r = runStep(step(), { ALLOWLIST_MODE: mode, COACH_IDS: U1 });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/::error::pilot_allowlist must be one of unchanged, push-from-secret, clear/);
    expectNoValueLeak(r.out);
  });

  it('push-from-secret reports the entry COUNT only', () => {
    const r = runStep(step(), { ALLOWLIST_MODE: 'push-from-secret', COACH_IDS: `${U1},${U2}, ${U3}` });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/push-from-secret — 3 entr\(y\/ies\) validated with the app's grammar; will be set/);
    expectNoValueLeak(r.out);
  });
});

describe('"Validate pilot coach allowlist" step — differential against parsePilotCoachAllowlist (S9A584-B1 / S9B-584-B2)', () => {
  const step = () => findStep(STEP.allowlist);

  // [label, value, workflowAccepts]. The invariant checked for EVERY row:
  //   workflow accepts ⇒ app admits every entry (rejectedPositions=[] and
  //   ids.size === number of comma segments).
  // Rows where the app admits but the workflow rejects are the deliberate
  // stricter-in-the-harmless-direction cases and are marked appStricterOk.
  type Row = { label: string; value: string; accepts: boolean; appStricterOk?: boolean };
  const ROWS: Row[] = [
    { label: 'single uuid', value: U1, accepts: true },
    { label: 'two uuids comma', value: `${U1},${U2}`, accepts: true },
    { label: 'two uuids comma+space', value: `${U1}, ${U2}`, accepts: true },
    { label: 'padded with spaces', value: `  ${U1}  ,  ${U2}  `, accepts: true },
    { label: 'uppercase uuid (app is case-insensitive)', value: U3, accepts: true },
    { label: 'three mixed', value: `${U1},${U3},${U2}`, accepts: true },
    // Divergences found by reviewers A/B at 32db4bc2 — the old validator accepted all of these:
    { label: 'single-quoted uuid', value: `'${U1}'`, accepts: false },
    { label: 'double-quoted uuid', value: `"${U1}"`, accepts: false },
    { label: 'uuid, newline, junk', value: `${U1}\nnot-a-uuid`, accepts: false },
    { label: 'newline-separated uuids', value: `${U1}\n${U2}`, accepts: false },
    { label: 'backslash inside', value: '1111111\\1-1111-1111-1111-111111111111', accepts: false },
    { label: 'CRLF-separated uuids', value: `${U1}\r\n${U2}`, accepts: false },
    { label: 'second entry quoted', value: `${U1},"${U2}"`, accepts: false },
    // Plain junk / non-canonical forms (the S12-B1 decision names these as junk):
    { label: 'star', value: '*', accepts: false },
    { label: 'true', value: 'true', accepts: false },
    { label: 'email', value: 'coach@example.com', accepts: false },
    { label: 'brace-wrapped', value: `{${U1}}`, accepts: false },
    { label: 'un-hyphenated', value: U1.replace(/-/g, ''), accepts: false },
    { label: 'truncated', value: U1.slice(0, -1), accepts: false },
    { label: 'one extra hex', value: `${U1}1`, accepts: false },
    { label: 'space-separated (no comma)', value: `${U1} ${U2}`, accepts: false },
    { label: 'semicolon-separated', value: `${U1};${U2}`, accepts: false },
    { label: 'interior space', value: '11111111-1111-1111-1111-1111 1111111', accepts: false },
    { label: 'non-hex char', value: '11111111-1111-1111-1111-11111111111g', accepts: false },
    { label: 'secret-ish token', value: SECRETISH, accepts: false },
    { label: 'good then junk', value: `${U1},${SECRETISH}`, accepts: false },
    { label: 'spaces only', value: '   ', accepts: false },
    { label: 'comma only', value: ',', accepts: false },
    // Stricter than the app in the harmless direction (app would drop the empty segment / trim):
    { label: 'trailing comma', value: `${U1},`, accepts: false, appStricterOk: true },
    { label: 'leading comma', value: `,${U1}`, accepts: false, appStricterOk: true },
    { label: 'double comma', value: `${U1},,${U2}`, accepts: false, appStricterOk: true },
    { label: 'trailing newline', value: `${U1}\n`, accepts: false, appStricterOk: true },
    { label: 'CR before a comma (app trims it)', value: `${U1}\r,${U2}`, accepts: false, appStricterOk: true },
    { label: 'tab before a comma (app trims it)', value: `${U1}\t,${U2}`, accepts: false, appStricterOk: true },
    { label: 'NBSP padding', value: `\u00a0${U1}\u00a0`, accepts: false, appStricterOk: true },
  ];

  it.each(ROWS.map((r) => [r.label, r] as const))('%s', (_label, row) => {
    const r = runStep(step(), { ALLOWLIST_MODE: 'push-from-secret', COACH_IDS: row.value });
    const app = parsePilotCoachAllowlist(row.value);
    const segments = row.value.split(',').length;

    expect(r.code).toBe(row.accepts ? 0 : 1);
    // THE invariant: the workflow never passes what the app would reject.
    if (r.code === 0) {
      expect(app.rejectedPositions).toEqual([]);
      expect(app.ids.size).toBe(segments);
      expect(r.out).toMatch(new RegExp(`${segments} entr\\(y/ies\\) validated`));
    } else {
      expect(r.out).toMatch(/::error::FEATURE_SCOUT_PILOT_COACH_IDS secret (has an entry that is not a canonical UUID|contains a newline, carriage return, tab, quote or backslash)/);
      expect(r.out).toMatch(/Nothing was pushed/);
      if (!row.appStricterOk) {
        // For every non-stricter reject row the app also rejects or admits nobody.
        expect(app.rejectedPositions.length > 0 || app.ids.size === 0).toBe(true);
      } else {
        expect(app.rejectedPositions).toEqual([]);
      }
    }
    // Never print the value, in either outcome.
    expectNoValueLeak(r.out, [row.value.trim()].filter((v) => v.length >= 4));
  });

  it('cross-check: for every row, app admits-all ⇒ (workflow accepts or row is a declared stricter case)', () => {
    for (const row of ROWS) {
      const app = parsePilotCoachAllowlist(row.value);
      const appAdmitsAll = app.rejectedPositions.length === 0 && app.ids.size > 0;
      if (appAdmitsAll && !row.accepts) expect(row.appStricterOk).toBe(true);
      if (!appAdmitsAll) expect(row.accepts).toBe(false);
    }
  });

  it('the shell UUID grammar is the app\'s canonical 8-4-4-4-12 hex form (case-insensitive)', () => {
    const app = readFileSync(join(ROOT, 'src/common/feature-flag/pilot-coach-allowlist.ts'), 'utf8');
    expect(app).toMatch(/\/\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\$\/i/);
    expect(step().run).toMatch(/uuid_re='\^\[0-9a-fA-F\]\{8\}-\[0-9a-fA-F\]\{4\}-\[0-9a-fA-F\]\{4\}-\[0-9a-fA-F\]\{4\}-\[0-9a-fA-F\]\{12\}\$'/);
    const code = (step().run as string)
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    expect(code).not.toMatch(/xargs/);
    expect(code).not.toMatch(/read -r?a/);
  });
});

// ---------------------------------------------------------------------------

describe('"Push feature flags to Fly" step (executed with flyctl stubbed, S12B6-SOL-B1)', () => {
  const step = () => findStep(STEP.push);

  it('refuses to run (exit 1) when nothing is set — never a silent no-op push', () => {
    const r = runStep(step(), PUSH_ENV_EMPTY);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/::error::No flag, allowlist or deadline input was set this dispatch/);
    expect(r.flyctlCalls).toEqual([]);
    expect(r.githubEnv).toEqual([]);
  });

  it('pushes ONLY the one explicitly-set flag in one flyctl secrets set call, and records exactly that name', () => {
    const r = runStep(step(), { ...PUSH_ENV_EMPTY, RECONSTRUCT: 'false' });
    expect(r.code).toBe(0);
    expect(r.flyctlCalls).toEqual([['secrets', 'set', '-a', APP, 'FEATURE_SCOUT_RECONSTRUCT=false']]);
    expect(r.githubEnv).toEqual(['PUSHED_NAMES=FEATURE_SCOUT_RECONSTRUCT']);
    expect(r.out).toMatch(/Pushing 1 name\(s\): FEATURE_SCOUT_RECONSTRUCT/);
  });

  it.each(DEADLINE_CHOICES)('pushes only the deadline (%s) when only it is set', (value) => {
    const r = runStep(step(), { ...PUSH_ENV_EMPTY, DEADLINE: value });
    expect(r.code).toBe(0);
    expect(r.flyctlCalls).toEqual([['secrets', 'set', '-a', APP, `SCOUT_RUN_DEADLINE_MS=${value}`]]);
    expect(r.githubEnv).toEqual(['PUSHED_NAMES=SCOUT_RUN_DEADLINE_MS']);
  });

  it('S9-B2 C1: clear maps to ONE `flyctl secrets unset` of the literal name, no `secrets set`, records UNSET_NAMES only', () => {
    const r = runStep(step(), { ...PUSH_ENV_EMPTY, ALLOWLIST_MODE: 'clear', COACH_IDS: U1 });
    expect(r.code).toBe(0);
    expect(r.flyctlCalls).toEqual([UNSET_ARGV]);
    expect(r.githubEnv).toEqual(['UNSET_NAMES=FEATURE_SCOUT_PILOT_COACH_IDS']);
    expect(r.out).toMatch(/Unsetting 1 name\(s\): FEATURE_SCOUT_PILOT_COACH_IDS/);
    expect(r.out).not.toMatch(/Pushing/);
    expectNoValueLeak(r.out);
  });

  it('clear + a flag: unset FIRST, then one secrets set without the allowlist name; both env lines recorded in that order', () => {
    const r = runStep(step(), { ...PUSH_ENV_EMPTY, SCOUT: 'true', DEADLINE: '900000', ALLOWLIST_MODE: 'clear' });
    expect(r.code).toBe(0);
    expect(r.flyctlCalls).toEqual([UNSET_ARGV, ['secrets', 'set', '-a', APP, 'FEATURE_SCOUT_INGEST=true', 'SCOUT_RUN_DEADLINE_MS=900000']]);
    expect(r.githubEnv).toEqual(['UNSET_NAMES=FEATURE_SCOUT_PILOT_COACH_IDS', 'PUSHED_NAMES=FEATURE_SCOUT_INGEST SCOUT_RUN_DEADLINE_MS']);
    for (const argv of r.flyctlCalls) if (argv[1] === 'set') expect(argv.join(' ')).not.toMatch(/FEATURE_SCOUT_PILOT_COACH_IDS/);
  });

  it('a failing unset stops the step (bash -e) before any secrets set and records nothing', () => {
    const r = runStep(step(), { ...PUSH_ENV_EMPTY, SCOUT: 'true', ALLOWLIST_MODE: 'clear' }, { unsetExit: 5 });
    expect(r.code).toBe(5);
    expect(r.flyctlCalls).toEqual([UNSET_ARGV]);
    expect(r.githubEnv).toEqual([]);
  });

  it('a failing set after a successful unset leaves UNSET_NAMES recorded and PUSHED_NAMES absent (red, truthful)', () => {
    const r = runStep(step(), { ...PUSH_ENV_EMPTY, SCOUT: 'true', ALLOWLIST_MODE: 'clear' }, { setExit: 7 });
    expect(r.code).toBe(7);
    expect(r.flyctlCalls).toHaveLength(2);
    expect(r.githubEnv).toEqual(['UNSET_NAMES=FEATURE_SCOUT_PILOT_COACH_IDS']);
  });

  it('the push step never emits `FEATURE_SCOUT_PILOT_COACH_IDS=` (empty value) for clear', () => {
    expect(step().run).not.toMatch(/FEATURE_SCOUT_PILOT_COACH_IDS="\)/);
    expect(step().run).not.toMatch(/FEATURE_SCOUT_PILOT_COACH_IDS=\$\{COACH_IDS:-\}/);
  });

  const OUTSIDE_SETS: Array<[string, Record<string, string>]> = [
    ['flag empty string', { SCOUT: '' }],
    ['flag outside the set', { PAIRING: 'yes' }],
    ['flag case variant', { RECONSTRUCT: 'True' }],
    ['deadline empty string', { DEADLINE: '' }],
    ['deadline in app grammar but not a choice option', { DEADLINE: '60000' }],
    ['deadline padded option', { DEADLINE: '300000 ' }],
  ];
  it.each(OUTSIDE_SETS)('S9A2-584-B1 defence in depth: push re-checks the closed sets — %s → exit 1, no flyctl call, nothing recorded', (_label, override) => {
    const r = runStep(step(), { ...PUSH_ENV_EMPTY, SCOUT: 'true', ...override });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/::error::.*Nothing was pushed/);
    expect(r.flyctlCalls).toEqual([]);
    expect(r.githubEnv).toEqual([]);
  });

  it('unchanged omits the allowlist name even when the secret is configured', () => {
    const r = runStep(step(), { ...PUSH_ENV_EMPTY, SCOUT: 'true', ALLOWLIST_MODE: 'unchanged', COACH_IDS: U1 });
    expect(r.code).toBe(0);
    expect(r.flyctlCalls).toEqual([['secrets', 'set', '-a', APP, 'FEATURE_SCOUT_INGEST=true']]);
    expectNoValueLeak(r.out);
  });

  it('push-from-secret hands the secret value to flyctl byte-for-byte as one argv element, prints only names/count, never the value', () => {
    const value = `${U1}, ${U2}`;
    const r = runStep(step(), { ...PUSH_ENV_EMPTY, ALLOWLIST_MODE: 'push-from-secret', COACH_IDS: value });
    expect(r.code).toBe(0);
    expect(r.flyctlCalls).toHaveLength(1);
    const argv = r.flyctlCalls[0];
    expect(argv.slice(0, 4)).toEqual(['secrets', 'set', '-a', APP]);
    expect(argv).toHaveLength(5);
    expect(argv[4]).toBe(`FEATURE_SCOUT_PILOT_COACH_IDS=${value}`);
    expect(r.githubEnv).toEqual(['PUSHED_NAMES=FEATURE_SCOUT_PILOT_COACH_IDS']);
    expectNoValueLeak(r.out);
    expect(r.out).not.toContain(value);
  });

  it('push-from-secret with an empty secret fails closed with no flyctl call', () => {
    const r = runStep(step(), { ...PUSH_ENV_EMPTY, SCOUT: 'true', ALLOWLIST_MODE: 'push-from-secret', COACH_IDS: '' });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/::error::pilot_allowlist=push-from-secret but the FEATURE_SCOUT_PILOT_COACH_IDS secret is empty/);
    expect(r.flyctlCalls).toEqual([]);
    expect(r.githubEnv).toEqual([]);
  });

  it('an unknown allowlist mode fails closed with no flyctl call', () => {
    const r = runStep(step(), { ...PUSH_ENV_EMPTY, SCOUT: 'true', ALLOWLIST_MODE: '__CLEAR__' });
    expect(r.code).toBe(1);
    expect(r.flyctlCalls).toEqual([]);
  });

  it('pushes all five names in ONE call when all are set; every element is NAME=value with a fixed name', () => {
    const r = runStep(step(), {
      ...PUSH_ENV_EMPTY,
      SCOUT: 'true',
      RECONSTRUCT: 'false',
      PAIRING: 'true',
      DEADLINE: '300000',
      ALLOWLIST_MODE: 'push-from-secret',
      COACH_IDS: U1,
    });
    expect(r.code).toBe(0);
    expect(r.flyctlCalls).toHaveLength(1);
    const argv = r.flyctlCalls[0];
    expect(argv.slice(0, 4)).toEqual(['secrets', 'set', '-a', APP]);
    const names = argv.slice(4).map((a) => a.split('=')[0]);
    expect(names).toEqual([
      'FEATURE_SCOUT_INGEST',
      'FEATURE_SCOUT_RECONSTRUCT',
      'FEATURE_EXTENSION_PAIRING',
      'SCOUT_RUN_DEADLINE_MS',
      'FEATURE_SCOUT_PILOT_COACH_IDS',
    ]);
    for (const a of argv.slice(4)) expect(a).toMatch(/^[A-Z_]+=/);
    expect(r.githubEnv).toEqual([
      'PUSHED_NAMES=FEATURE_SCOUT_INGEST FEATURE_SCOUT_RECONSTRUCT FEATURE_EXTENSION_PAIRING SCOUT_RUN_DEADLINE_MS FEATURE_SCOUT_PILOT_COACH_IDS',
    ]);
    expectNoValueLeak(r.out);
  });

  it('a failing flyctl secrets set fails the step (bash -e) and records no PUSHED_NAMES', () => {
    const r = runStep(step(), { ...PUSH_ENV_EMPTY, SCOUT: 'true' }, { setExit: 7 });
    expect(r.code).toBe(7);
    expect(r.flyctlCalls).toHaveLength(1);
    expect(r.githubEnv).toEqual([]);
  });

  it('never calls secrets unset unless pilot_allowlist=clear', () => {
    for (const mode of ['unchanged', 'push-from-secret']) {
      const r = runStep(step(), { ...PUSH_ENV_EMPTY, SCOUT: 'true', ALLOWLIST_MODE: mode, COACH_IDS: U1 });
      expect(r.code).toBe(0);
      expect(r.flyctlCalls.filter((c) => c[1] === 'unset')).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------

describe('"Verify pushed names are present on Fly" step (executed with flyctl stubbed, S9B-584-B1)', () => {
  const step = () => findStep(STEP.verify);
  const env = (pushed: string, unset?: string) => ({
    APP,
    FLY_API_TOKEN: 'stub-token',
    PUSHED_NAMES: pushed,
    ...(unset === undefined ? {} : { UNSET_NAMES: unset }),
  });
  const OTHER_ROWS = [
    { name: 'DATABASE_URL', status: 'Deployed' },
    { name: 'JWT_SECRET', status: 'Deployed' },
    { name: 'STRIPE_WEBHOOK_SECRET', status: 'Deployed' },
  ];

  it('calls flyctl secrets list --json for the app (not the human table)', () => {
    const r = runStep(step(), env('FEATURE_SCOUT_INGEST'), { listJson: listJson([...OTHER_ROWS, { name: 'FEATURE_SCOUT_INGEST', status: 'Deployed' }]) });
    expect(r.code).toBe(0);
    expect(r.flyctlCalls).toEqual([['secrets', 'list', '-a', APP, '--json']]);
  });

  it('passes when every pushed name is present and Deployed; prints only pushed names + status, no digests, no other names', () => {
    const body = listJson([
      ...OTHER_ROWS,
      { name: 'FEATURE_SCOUT_INGEST', status: 'Deployed' },
      { name: 'FEATURE_SCOUT_PILOT_COACH_IDS', status: 'Deployed' },
    ]);
    const r = runStep(step(), env('FEATURE_SCOUT_INGEST FEATURE_SCOUT_PILOT_COACH_IDS'), { listJson: body });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^FEATURE_SCOUT_INGEST: present on Fly \(status: Deployed\)$/m);
    expect(r.out).toMatch(/^FEATURE_SCOUT_PILOT_COACH_IDS: present on Fly \(status: Deployed\)$/m);
    expect(r.out).toMatch(/Every name pushed this run \(FEATURE_SCOUT_INGEST FEATURE_SCOUT_PILOT_COACH_IDS\) is present on Fly/);
    expect(r.out).not.toMatch(/::warning::/);
    expect(r.out).not.toMatch(/d1g3st/);
    for (const o of OTHER_ROWS) expect(r.out).not.toContain(o.name);
  });

  it('fails (exit 1) naming the missing pushed name — the negative the old awk/grep parser could never distinguish', () => {
    const r = runStep(step(), env('FEATURE_SCOUT_INGEST FEATURE_EXTENSION_PAIRING'), {
      listJson: listJson([...OTHER_ROWS, { name: 'FEATURE_SCOUT_INGEST', status: 'Deployed' }]),
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^FEATURE_EXTENSION_PAIRING: MISSING on Fly$/m);
    expect(r.out).toMatch(/::error::Names pushed this run did not appear on Fly after set: FEATURE_EXTENSION_PAIRING$/m);
    expect(r.out).not.toMatch(/FEATURE_SCOUT_INGEST: MISSING/);
  });

  it('a name present but Staged: passes (presence is what is certified) with a ::warning:: naming it', () => {
    const r = runStep(step(), env('FEATURE_SCOUT_INGEST FEATURE_EXTENSION_PAIRING'), {
      listJson: listJson([...OTHER_ROWS, { name: 'FEATURE_SCOUT_INGEST', status: 'Staged' }, { name: 'FEATURE_EXTENSION_PAIRING', status: 'Deployed' }]),
    });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^FEATURE_SCOUT_INGEST: present on Fly \(status: Staged\)$/m);
    expect(r.out).toMatch(/::warning::Present on Fly but Fly does not yet report status Deployed for: FEATURE_SCOUT_INGEST\./);
  });

  it('older flyctl JSON without a status field: reports status unknown and passes on presence', () => {
    const r = runStep(step(), env('SCOUT_RUN_DEADLINE_MS'), { listJson: listJson([...OTHER_ROWS.map(({ name }) => ({ name })), { name: 'SCOUT_RUN_DEADLINE_MS' }]) });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^SCOUT_RUN_DEADLINE_MS: present on Fly \(status: unknown\)$/m);
  });

  it('does not match a name by prefix/substring', () => {
    const r = runStep(step(), env('FEATURE_SCOUT_INGEST'), { listJson: listJson([{ name: 'FEATURE_SCOUT_INGEST_OLD', status: 'Deployed' }, { name: 'XFEATURE_SCOUT_INGEST', status: 'Deployed' }]) });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FEATURE_SCOUT_INGEST: MISSING on Fly/);
  });

  it('the human table format flyctl prints without --json (rows start with "*" and box-drawing columns) is rejected, not silently treated as absent', () => {
    // Real shape captured from run 29031011035 of this workflow.
    const table = [
      ' NAME                                 │ DIGEST           │ STATUS ',
      ' * FEATURE_SCOUT_INGEST                │ d8c5ac2e11c8e492 │ Staged ',
      ' * FEATURE_EXTENSION_PAIRING           │ d8c5ac2e11c8e492 │ Staged ',
      '',
    ].join('\n');
    const r = runStep(step(), env('FEATURE_SCOUT_INGEST'), { listJson: table });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/::error::flyctl secrets list --json did not return a JSON array/);
    expect(r.out).not.toMatch(/d8c5ac2e11c8e492/);
  });

  it('a failing flyctl secrets list fails the step (bash -e), never a false "present"', () => {
    const r = runStep(step(), env('FEATURE_SCOUT_INGEST'), { listJson: '', listExit: 3 });
    expect(r.code).not.toBe(0);
    expect(r.out).not.toMatch(/present on Fly/);
  });

  it('refuses to verify when PUSHED_NAMES and UNSET_NAMES are both empty or absent', () => {
    for (const e of [env(''), env('', ''), { APP, FLY_API_TOKEN: 'stub-token' }]) {
      const r = runStep(step(), e, { listJson: listJson(OTHER_ROWS) });
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/::error::PUSHED_NAMES and UNSET_NAMES are both empty/);
      expect(r.flyctlCalls).toEqual([]);
    }
  });

  describe('unset names (S9-B2 C1): an unset name must be ABSENT', () => {
    it('passes when the unset name is absent from the listing, with PUSHED_NAMES absent entirely (clear-only dispatch)', () => {
      const r = runStep(step(), { APP, FLY_API_TOKEN: 'stub-token', UNSET_NAMES: 'FEATURE_SCOUT_PILOT_COACH_IDS' }, { listJson: listJson(OTHER_ROWS) });
      expect(r.code).toBe(0);
      expect(r.flyctlCalls).toEqual([['secrets', 'list', '-a', APP, '--json']]);
      expect(r.out).toMatch(/^FEATURE_SCOUT_PILOT_COACH_IDS: absent on Fly \(unset confirmed\)$/m);
      expect(r.out).toMatch(/Every name unset this run \(FEATURE_SCOUT_PILOT_COACH_IDS\) is absent from Fly/);
      expect(r.out).not.toMatch(/present on Fly/);
      expect(r.out).not.toMatch(/Every name pushed/);
      expect(r.out).not.toMatch(/::warning::/);
      for (const o of OTHER_ROWS) expect(r.out).not.toContain(o.name);
    });

    it('fails (exit 1) when the unset name is STILL PRESENT — never a false "cleared"', () => {
      const r = runStep(step(), env('', 'FEATURE_SCOUT_PILOT_COACH_IDS'), {
        listJson: listJson([...OTHER_ROWS, { name: 'FEATURE_SCOUT_PILOT_COACH_IDS', status: 'Deployed' }]),
      });
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/^FEATURE_SCOUT_PILOT_COACH_IDS: STILL PRESENT on Fly after unset$/m);
      expect(r.out).toMatch(/::error::Names unset this run are still present on Fly: FEATURE_SCOUT_PILOT_COACH_IDS$/m);
      expect(r.out).not.toMatch(/absent from Fly/);
      expect(r.out).not.toMatch(/d1g3st/);
    });

    it('still-present is judged by exact name, not prefix/substring', () => {
      const r = runStep(step(), env('', 'FEATURE_SCOUT_PILOT_COACH_IDS'), {
        listJson: listJson([{ name: 'FEATURE_SCOUT_PILOT_COACH_IDS_OLD', status: 'Deployed' }, { name: 'XFEATURE_SCOUT_PILOT_COACH_IDS', status: 'Deployed' }]),
      });
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/absent on Fly \(unset confirmed\)/);
    });

    it('mixed dispatch: set names present AND unset name absent → pass; both summary lines printed, only touched names named', () => {
      const r = runStep(step(), env('FEATURE_SCOUT_INGEST SCOUT_RUN_DEADLINE_MS', 'FEATURE_SCOUT_PILOT_COACH_IDS'), {
        listJson: listJson([...OTHER_ROWS, { name: 'FEATURE_SCOUT_INGEST', status: 'Deployed' }, { name: 'SCOUT_RUN_DEADLINE_MS', status: 'Deployed' }]),
      });
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/^FEATURE_SCOUT_INGEST: present on Fly \(status: Deployed\)$/m);
      expect(r.out).toMatch(/^SCOUT_RUN_DEADLINE_MS: present on Fly \(status: Deployed\)$/m);
      expect(r.out).toMatch(/^FEATURE_SCOUT_PILOT_COACH_IDS: absent on Fly \(unset confirmed\)$/m);
      expect(r.out).toMatch(/Every name pushed this run \(FEATURE_SCOUT_INGEST SCOUT_RUN_DEADLINE_MS\) is present on Fly/);
      expect(r.out).toMatch(/Every name unset this run \(FEATURE_SCOUT_PILOT_COACH_IDS\) is absent from Fly/);
      for (const o of OTHER_ROWS) expect(r.out).not.toContain(o.name);
    });

    it('mixed dispatch: a missing set name AND a still-present unset name both fail, both reported', () => {
      const r = runStep(step(), env('FEATURE_SCOUT_INGEST', 'FEATURE_SCOUT_PILOT_COACH_IDS'), {
        listJson: listJson([...OTHER_ROWS, { name: 'FEATURE_SCOUT_PILOT_COACH_IDS', status: 'Deployed' }]),
      });
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/FEATURE_SCOUT_INGEST: MISSING on Fly/);
      expect(r.out).toMatch(/FEATURE_SCOUT_PILOT_COACH_IDS: STILL PRESENT on Fly after unset/);
      expect(r.out).toMatch(/::error::Names pushed this run did not appear on Fly after set: FEATURE_SCOUT_INGEST/);
    });

    it('a non-array body is rejected loudly for unset verification too, never a false "absent"', () => {
      const r = runStep(step(), env('', 'FEATURE_SCOUT_PILOT_COACH_IDS'), { listJson: 'not json' });
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/::error::flyctl secrets list --json did not return a JSON array/);
      expect(r.out).not.toMatch(/absent/);
    });
  });
});

// ---------------------------------------------------------------------------

describe('end-to-end step sequence with flyctl stubbed (every run: block, runner shell semantics)', () => {
  const FULL_LISTING = [
    { name: 'FEATURE_SCOUT_INGEST', status: 'Deployed' },
    { name: 'FEATURE_SCOUT_RECONSTRUCT', status: 'Deployed' },
    { name: 'FEATURE_EXTENSION_PAIRING', status: 'Deployed' },
    { name: 'SCOUT_RUN_DEADLINE_MS', status: 'Deployed' },
    { name: 'FEATURE_SCOUT_PILOT_COACH_IDS', status: 'Deployed' },
  ];

  // Inputs default to each choice's YAML default (confirm is forced to SET
  // unless a test overrides it, so the sequence gets past the confirm step).
  function runSequence(
    inputs: { app?: string; confirm?: string; scout?: string; reconstruct?: string; pairing?: string; deadline?: string; allowlist?: string },
    secret: string,
    listing: Array<{ name: string; status?: string }> = FULL_LISTING,
  ) {
    const steps = loadJob().steps!.filter((s) => s.run);
    const inputEnv = {
      APP: inputs.app ?? APP,
      CONFIRM: inputs.confirm ?? 'SET',
      SCOUT: inputs.scout ?? 'unchanged',
      RECONSTRUCT: inputs.reconstruct ?? 'unchanged',
      PAIRING: inputs.pairing ?? 'unchanged',
      DEADLINE: inputs.deadline ?? 'unchanged',
      ALLOWLIST_MODE: inputs.allowlist ?? 'unchanged',
      COACH_IDS: secret,
      FLY_API_TOKEN: 'stub-token',
    };
    const results: Array<{ name: string; r: RunResult }> = [];
    let carried: Record<string, string> = {};
    for (const st of steps) {
      // Only the env: keys the step declares are visible to it (plus GITHUB_ENV carry-over), as on the runner.
      const visible: Record<string, string> = {};
      for (const k of Object.keys(st.env ?? {})) visible[k] = (inputEnv as Record<string, string>)[k] ?? '';
      const r = runStep(st, { ...carried, ...visible }, { listJson: listJson(listing) });
      results.push({ name: st.name ?? '?', r });
      for (const line of r.githubEnv) {
        const i = line.indexOf('=');
        carried = { ...carried, [line.slice(0, i)]: line.slice(i + 1) };
      }
      if (r.code !== 0) break;
    }
    return results;
  }

  it('happy path: allowlist from secret + deadline → every step exits 0, exactly one secrets set with both names, no unset, values never printed', () => {
    const res = runSequence({ allowlist: 'push-from-secret', deadline: '900000' }, `${U1},${U2}`);
    expect(res.map((x) => x.name)).toEqual(Object.values(STEP));
    for (const x of res) expect(x.r.code).toBe(0);
    const mutations = res.flatMap((x) => x.r.flyctlCalls).filter((c) => c[1] !== 'list');
    expect(mutations).toEqual([['secrets', 'set', '-a', APP, 'SCOUT_RUN_DEADLINE_MS=900000', `FEATURE_SCOUT_PILOT_COACH_IDS=${U1},${U2}`]]);
    expectNoValueLeak(res.map((x) => x.r.out).join('\n'));
  });

  it('the default dispatch (every choice at its default, confirm=no) stops at the confirm step: nothing validated, nothing called', () => {
    const res = runSequence({ confirm: 'no' }, U1);
    expect(res.map((x) => x.name)).toEqual([STEP.target, STEP.confirm]);
    expect(res[1].r.code).toBe(1);
    expect(res.flatMap((x) => x.r.flyctlCalls)).toEqual([]);
  });

  it('clear + a flag (S9-B2 C1): unset runs before set; verify passes only because the unset name is ABSENT from the listing', () => {
    const listingWithoutAllowlist = FULL_LISTING.filter((r) => r.name !== 'FEATURE_SCOUT_PILOT_COACH_IDS');
    const res = runSequence({ allowlist: 'clear', scout: 'false' }, U1, listingWithoutAllowlist);
    expect(res.map((x) => x.name)).toEqual(Object.values(STEP));
    for (const x of res) expect(x.r.code).toBe(0);
    const mutations = res.flatMap((x) => x.r.flyctlCalls).filter((c) => c[1] !== 'list');
    expect(mutations).toEqual([UNSET_ARGV, ['secrets', 'set', '-a', APP, 'FEATURE_SCOUT_INGEST=false']]);
    const verify = res[res.length - 1].r.out;
    expect(verify).toMatch(/FEATURE_SCOUT_PILOT_COACH_IDS: absent on Fly \(unset confirmed\)/);
    expect(verify).toMatch(/FEATURE_SCOUT_INGEST: present on Fly/);
    expectNoValueLeak(res.map((x) => x.r.out).join('\n'));
  });

  it('clear where Fly still lists the name afterwards: every step up to verify passes, verify fails — never a false "cleared"', () => {
    const res = runSequence({ allowlist: 'clear' }, U1, FULL_LISTING);
    expect(res.map((x) => x.name)).toEqual(Object.values(STEP));
    expect(res[res.length - 1].r.code).toBe(1);
    expect(res[res.length - 1].r.out).toMatch(/::error::Names unset this run are still present on Fly: FEATURE_SCOUT_PILOT_COACH_IDS/);
    const mutations = res.flatMap((x) => x.r.flyctlCalls).filter((c) => c[1] !== 'list');
    expect(mutations).toEqual([UNSET_ARGV]);
  });

  it('a value the app parser would reject stops at the allowlist validator; flyctl is never invoked', () => {
    const res = runSequence({ allowlist: 'push-from-secret', scout: 'true' }, `"${U1}"`);
    expect(res[res.length - 1].name).toBe(STEP.allowlist);
    expect(res[res.length - 1].r.code).toBe(1);
    expect(res.flatMap((x) => x.r.flyctlCalls)).toEqual([]);
    expectNoValueLeak(res.map((x) => x.r.out).join('\n'));
  });

  it('confirm not SET stops before any validator or flyctl call', () => {
    const res = runSequence({ confirm: 'no', scout: 'true' }, U1);
    expect(res.map((x) => x.name)).toEqual([STEP.target, STEP.confirm]);
    expect(res.flatMap((x) => x.r.flyctlCalls)).toEqual([]);
  });

  it('wrong app target stops at the first step', () => {
    const res = runSequence({ app: 'some-other-app', scout: 'true' }, U1);
    expect(res.map((x) => x.name)).toEqual([STEP.target]);
    expect(res.flatMap((x) => x.r.flyctlCalls)).toEqual([]);
  });

  it.each(['0', '60000', ''])('a deadline outside the closed choices (%j) stops at the deadline validator, even one the app would honour', (deadline) => {
    const res = runSequence({ deadline }, '');
    expect(res[res.length - 1].name).toBe(STEP.deadline);
    expect(res[res.length - 1].r.code).toBe(1);
    expect(res.flatMap((x) => x.r.flyctlCalls)).toEqual([]);
  });

  const OUTSIDE_CHOICES: Array<[string, Parameters<typeof runSequence>[0], string]> = [
    ['flag', { scout: 'yes' }, STEP.flags],
    ['flag (empty)', { pairing: '' }, STEP.flags],
    ['app', { app: '' }, STEP.target],
    ['confirm (empty)', { confirm: '' }, STEP.confirm],
  ];
  it.each(OUTSIDE_CHOICES)('a %s value outside its closed choices stops at its validator with no flyctl call', (_label, inputs, stopAt) => {
    const res = runSequence(inputs, '');
    expect(res[res.length - 1].name).toBe(stopAt);
    expect(res[res.length - 1].r.code).toBe(1);
    expect(res.flatMap((x) => x.r.flyctlCalls)).toEqual([]);
  });

  it('nothing set at all: every validator passes, the push step refuses, flyctl is never invoked', () => {
    const res = runSequence({}, '');
    expect(res[res.length - 1].name).toBe(STEP.push);
    expect(res[res.length - 1].r.code).toBe(1);
    expect(res.flatMap((x) => x.r.flyctlCalls)).toEqual([]);
  });
});
