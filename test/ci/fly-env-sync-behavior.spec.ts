/**
 * S-ENVTRUTH fix round (Sol B-624-1): BEHAVIOURAL tests for
 * .github/workflows/fly-env-sync.yml. Instead of matching the YAML text, this
 * spec runs the job's real `run:` scripts in order, the way the GitHub runner
 * does (`bash --noprofile --norc -eo pipefail`), against a fake `flyctl` on
 * PATH. The fake answers `secrets list --json` from staged / partial /
 * deployed JSON fixtures (the shapes flyctl's list command renders) and the
 * human `secrets list` table with flyctl's real "* " staged / "! " partial
 * name prefixes, so a post-check that parses the table fails here exactly as
 * it failed in production review.
 *
 * Central assertions:
 *   - after a successful stage, the post-check passes and the optional apply
 *     step (`deploy_staged=true`) is reached and calls `flyctl secrets deploy`;
 *   - every failure path prints what is wrong and a "Fix:" line;
 *   - no secret value and no digest ever reaches the log or a file;
 *   - (B-624-3) no byte of flyctl's own output ever reaches the log: a hostile
 *     fake echoes whitespace / newline / quoted / standalone values in its
 *     errors, and the step prints only a fixed operation, exit code, secret
 *     NAMES, an allowlisted error class and a fixed "Fix:" action.
 * No network, no real flyctl, no credentials.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import { load as parseYaml } from 'js-yaml';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..');
const WORKFLOW = path.join(ROOT, '.github/workflows/fly-env-sync.yml');
const APP = 'backend-spring-lake-3890';

// Distinctive sentinels so a leak is unambiguous.
const VALUE = 'leakcanary-value-9f8e7d6c5b4a3921';
const VALUE_2 = 'leakcanary-value-second-0a1b2c3d';
const DIGEST = 'leakcanary-digest-1a2b3c4d5e6f7a8b';

interface Step {
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
}
interface Workflow {
  jobs: Record<string, { steps: Step[] }>;
}

const steps: Step[] = Object.values(
  (parseYaml(fs.readFileSync(WORKFLOW, 'utf8')) as Workflow).jobs,
)[0].steps;

type ListMode =
  | 'staged'
  | 'partial'
  | 'deployed'
  | 'no-status'
  | 'legacy-capitalized'
  | 'missing'
  | 'not-array'
  | 'entry-without-name'
  | 'not-json';

/** What `flyctl secrets list --json` prints for each fixture (render.JSON uses 4-space indent). */
function listJson(mode: ListMode, staged: readonly string[]): string {
  const pre = { name: 'DATABASE_URL', digest: DIGEST, status: 'Deployed' };
  const row = (name: string, status: string) => ({ name, digest: DIGEST, status });
  switch (mode) {
    case 'staged':
      return JSON.stringify([pre, ...staged.map((n) => row(n, 'Staged'))], null, 4);
    case 'partial':
      return JSON.stringify([pre, ...staged.map((n) => row(n, 'Partial'))], null, 4);
    case 'deployed':
      return JSON.stringify([pre, ...staged.map((n) => row(n, 'Deployed'))], null, 4);
    case 'no-status':
      // flyctl drops status when machine release data is unavailable.
      return JSON.stringify(
        [
          { name: 'DATABASE_URL', digest: DIGEST },
          ...staged.map((n) => ({ name: n, digest: DIGEST })),
        ],
        null,
        4,
      );
    case 'legacy-capitalized':
      return JSON.stringify(
        [
          { Name: 'DATABASE_URL', Digest: DIGEST },
          ...staged.map((n) => ({ Name: n, Digest: DIGEST })),
        ],
        null,
        4,
      );
    case 'missing':
      return JSON.stringify([pre, ...staged.slice(0, 1).map((n) => row(n, 'Staged'))], null, 4);
    case 'not-array':
      return JSON.stringify({ secrets: [row(staged[0], 'Staged')] }, null, 4);
    case 'entry-without-name':
      return JSON.stringify([pre, { digest: DIGEST, status: 'Staged' }], null, 4);
    case 'not-json':
      return `NAME │ DIGEST\n* ${staged[0]} │ ${DIGEST}\n`;
  }
}

/** flyctl's human table: staged names prefixed with "* ", partial with "! ". */
function listTable(staged: readonly string[]): string {
  return [
    'NAME                 │ DIGEST                               │ STATUS',
    `DATABASE_URL         │ ${DIGEST} │ Deployed`,
    ...staged.map((n) => `* ${n.padEnd(19)}│ ${DIGEST} │ Staged`),
    '',
    `${staged.length} secrets are staged for the next deployment`,
    '',
  ].join('\n');
}

const FAKE_FLYCTL = `#!/usr/bin/env bash
# Fake flyctl for fly-env-sync-behavior.spec.ts. Logs argv NAMES only.
set -uo pipefail
sub="\${1:-} \${2:-}"
shift 2 || true
json=0; app=""; stage=0; pairs=()
while [ $# -gt 0 ]; do
  case "$1" in
    --json|-j) json=1 ;;
    -a|--app) app="$2"; shift ;;
    --stage) stage=1 ;;
    *) pairs+=("$1") ;;
  esac
  shift
done
case "$sub" in
  "secrets set")
    names=()
    for p in "\${pairs[@]}"; do names+=("\${p%%=*}"); done
    echo "secrets set stage=\${stage} app=\${app} names=\${names[*]}" >> "$FAKE_DIR/calls.log"
    if [ "\${FAKE_SET_RC:-0}" -ne 0 ]; then
      case "\${FAKE_SET_ERR:-pair}" in
        pair) echo "Error: failed to update app secrets for \${pairs[0]}" >&2 ;;
        hostile)
          # Every shape a CLI can echo a value in: NAME=VALUE, quoted pair,
          # quoted bare value, the bare value on its own line(s), and stdout.
          for p in "\${pairs[@]}"; do
            echo "Error: failed to update app secrets for \${p}" >&2
            echo "Error: could not parse \\"\${p}\\" (value '\${p#*=}')" >&2
            printf '%s\\n' "\${p#*=}" >&2
            echo "error: invalid value: \${p#*=}" >&2
            printf '%s\\n' "\${p}"
          done
          ;;
        auth) echo "Error: unauthorized (token rejected)" >&2 ;;
        app) echo "Error: Could not find App \\"\${app}\\"" >&2 ;;
        ratelimit) echo "Error: 429 Too Many Requests: rate limit exceeded" >&2 ;;
        network) echo "Error: Post \\"https://api.fly.io/graphql\\": dial tcp: lookup api.fly.io: no such host" >&2 ;;
        empty) ;;
      esac
      exit "$FAKE_SET_RC"
    fi
    # stdout carries a digest; the step discards stdout.
    echo "Secrets are staged for the first time (digest $FAKE_DIGEST)"
    ;;
  "secrets list")
    echo "secrets list json=\${json} app=\${app}" >> "$FAKE_DIR/calls.log"
    rc="\${FAKE_LIST_RC:-0}"
    if [ -f "$FAKE_DIR/deployed" ]; then rc="\${FAKE_LIST_AFTER_RC:-0}"; fi
    if [ "$rc" -ne 0 ]; then
      case "\${FAKE_LIST_ERR:-auth}" in
        auth) echo "Error: unauthorized: token is not valid for app \${app}" >&2 ;;
        raw) echo "Error: RAWFLYSTDERR-list-7c1e upstream said something" >&2 ;;
      esac
      exit "$rc"
    fi
    if [ -f "$FAKE_DIR/deployed" ] && [ -f "$FAKE_DIR/list-after.json" ]; then
      cat "$FAKE_DIR/list-after.json"
    elif [ "$json" -eq 1 ]; then cat "$FAKE_DIR/list.json"; else cat "$FAKE_DIR/list.table"; fi
    ;;
  "secrets deploy")
    echo "secrets deploy app=\${app}" >> "$FAKE_DIR/calls.log"
    if [ "\${FAKE_DEPLOY_RC:-0}" -ne 0 ]; then
      case "\${FAKE_DEPLOY_ERR:-health}" in
        health) echo "Error: machine 1234abcd failed health checks" >&2 ;;
        raw) echo "Error: RAWFLYSTDERR-deploy-5d2a upstream said something" >&2 ;;
      esac
      exit "$FAKE_DEPLOY_RC"
    fi
    touch "$FAKE_DIR/deployed"
    echo "RAWFLYSTDOUT-deploy-3b9f Updating machines with the staged secrets"
    ;;
  *)
    echo "fake flyctl: unexpected command: $sub" >&2
    exit 97
    ;;
esac
`;

interface RunOptions {
  secrets?: Record<string, string>;
  app?: string;
  confirm?: string;
  deployStaged?: boolean;
  list?: ListMode;
  setRc?: number;
  listRc?: number;
  deployRc?: number;
  /** Which error text the fake prints when `secrets set` fails. */
  setErr?: 'pair' | 'hostile' | 'auth' | 'app' | 'ratelimit' | 'network' | 'empty';
  listErr?: 'auth' | 'raw';
  deployErr?: 'health' | 'raw';
  /** Listing returned after `secrets deploy` ran (default: every name Deployed). */
  listAfter?: ListMode;
  /** Exit code of the follow-up listing after `secrets deploy`. */
  listAfterRc?: number;
}
interface StepRun {
  name: string;
  ran: boolean;
  status: number | null;
  out: string;
}
interface JobRun {
  steps: StepRun[];
  calls: string[];
  /** Concatenated stdout+stderr of every step that ran. */
  log: string;
  /** Every file left in the job working directory, by name -> content. */
  files: Record<string, string>;
  ok: boolean;
}

const DEFAULT_SECRETS: Record<string, string> = {
  FLY_API_TOKEN: 'fake-fly-token-not-a-secret',
  GOOGLE_CLIENT_IDS: VALUE,
  METRICS_AUTH_TOKEN: VALUE_2,
};
const STAGED = ['GOOGLE_CLIENT_IDS', 'METRICS_AUTH_TOKEN'];

/** Resolve `${{ secrets.X }}` / `${{ inputs.x }}` the way the runner does. */
function resolveEnv(
  env: Record<string, string> | undefined,
  secrets: Record<string, string>,
  inputs: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    const s = /^\$\{\{ secrets\.([A-Z0-9_]+) \}\}$/.exec(v);
    const i = /^\$\{\{ inputs\.([a-z_]+) \}\}$/.exec(v);
    if (s) out[k] = secrets[s[1]] ?? '';
    else if (i) out[k] = inputs[i[1]] ?? '';
    else out[k] = v;
  }
  return out;
}

function runJob(o: RunOptions = {}): JobRun {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fly-env-sync-'));
  const work = path.join(dir, 'work');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(work);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'flyctl'), FAKE_FLYCTL, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'list.json'), listJson(o.list ?? 'staged', STAGED));
  fs.writeFileSync(path.join(dir, 'list.table'), listTable(STAGED));
  fs.writeFileSync(path.join(dir, 'list-after.json'), listJson(o.listAfter ?? 'deployed', STAGED));
  const secrets = o.secrets ?? DEFAULT_SECRETS;
  const inputs = {
    app: o.app ?? APP,
    confirm: o.confirm ?? 'SET',
    deploy_staged: String(o.deployStaged ?? true),
  };
  const results: StepRun[] = [];
  let failed = false;
  for (const step of steps) {
    const name = step.name ?? step.uses ?? '(unnamed)';
    if (step.uses) {
      // setup-flyctl: the fake flyctl on PATH stands in for the installed CLI.
      results.push({ name, ran: false, status: null, out: '' });
      continue;
    }
    let wanted = !failed;
    if (step.if !== undefined) {
      if (step.if !== '${{ inputs.deploy_staged }}') {
        throw new Error(
          `fly-env-sync-behavior.spec.ts cannot evaluate if: ${step.if}. Fix: teach runJob() this expression.`,
        );
      }
      wanted = wanted && inputs.deploy_staged === 'true';
    }
    if (!wanted) {
      results.push({ name, ran: false, status: null, out: '' });
      continue;
    }
    const script = path.join(dir, `step-${results.length}.sh`);
    fs.writeFileSync(script, step.run ?? '');
    const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], {
      cwd: work,
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        HOME: dir,
        FAKE_DIR: dir,
        FAKE_DIGEST: DIGEST,
        FAKE_SET_RC: String(o.setRc ?? 0),
        FAKE_LIST_RC: String(o.listRc ?? 0),
        FAKE_DEPLOY_RC: String(o.deployRc ?? 0),
        FAKE_SET_ERR: o.setErr ?? 'pair',
        FAKE_LIST_ERR: o.listErr ?? 'auth',
        FAKE_DEPLOY_ERR: o.deployErr ?? 'health',
        FAKE_LIST_AFTER_RC: String(o.listAfterRc ?? 0),
        ...resolveEnv(step.env, secrets, inputs),
      },
    });
    results.push({ name, ran: true, status: r.status, out: `${r.stdout}${r.stderr}` });
    if (r.status !== 0) failed = true;
  }
  const callsFile = path.join(dir, 'calls.log');
  const calls = fs.existsSync(callsFile)
    ? fs.readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean)
    : [];
  const files: Record<string, string> = {};
  for (const f of fs.readdirSync(work)) files[f] = fs.readFileSync(path.join(work, f), 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  return {
    steps: results,
    calls,
    log: results.map((s) => s.out).join('\n'),
    files,
    ok: !failed,
  };
}

const step = (run: JobRun, re: RegExp): StepRun => {
  const s = run.steps.find((x) => re.test(x.name));
  if (!s) throw new Error(`no step matching ${re}`);
  return s;
};
const STAGE = /^Stage allowlisted secrets/;
const CHECK = /^Confirm staged names are listed on Fly/;
const APPLY = /^Apply staged secrets now/;

/** No secret value and no digest anywhere: log or any file left behind. */
function expectNoLeak(run: JobRun): void {
  const everything = `${run.log}\n${Object.values(run.files).join('\n')}`;
  for (const s of [VALUE, VALUE_2, DIGEST, 'leakcanary', 'RAWFLYSTD'])
    expect(everything).not.toContain(s);
}

/**
 * Every fragment of a hostile value (split on whitespace, quotes, '=' and ':'
 * — the boundaries a redaction regex would cut at) is absent from the log and
 * from every file left in the working directory.
 */
function expectNoFragment(run: JobRun, value: string): void {
  const everything = `${run.log}\n${Object.values(run.files).join('\n')}`;
  const fragments = value.split(/[\s"'=:]+/).filter((t) => t.length >= 6);
  expect(fragments.length).toBeGreaterThan(0);
  for (const f of fragments) expect([f, everything.includes(f)]).toEqual([f, false]);
}

/** The only lines a failed stage step may print: its own fixed lines. */
const STAGE_FAILURE_LINES = [
  /^skipped \(unset or empty in GitHub secrets\): /,
  /^staging: /,
  /^::error::flyctl secrets set --stage failed \(exit \d+, error class [a-z_]+\) for: /,
];

describe('fly-env-sync.yml behaviour (fake flyctl, real run: scripts)', () => {
  it('the toolchain the post-check relies on is present (ubuntu-latest ships bash and jq)', () => {
    expect(spawnSync('jq', ['--version']).status).toBe(0);
  });

  it('run: blocks never interpolate ${{ }} expressions (inputs reach the shell only via env)', () => {
    for (const s of steps)
      expect([s.name, s.run ?? '']).toEqual([s.name, expect.not.stringContaining('${{')]);
  });

  it('after a successful stage (status Staged) the post-check passes and the optional apply step runs', () => {
    const run = runJob({ list: 'staged', deployStaged: true });
    expect(step(run, STAGE)).toMatchObject({ ran: true, status: 0 });
    expect(step(run, CHECK)).toMatchObject({ ran: true, status: 0 });
    expect(step(run, CHECK).out).toContain('GOOGLE_CLIENT_IDS: Staged');
    expect(step(run, CHECK).out).toContain('METRICS_AUTH_TOKEN: Staged');
    expect(step(run, APPLY)).toMatchObject({ ran: true, status: 0 });
    expect(step(run, APPLY).out).toContain('GOOGLE_CLIENT_IDS: Deployed');
    expect(step(run, APPLY).out).toContain('METRICS_AUTH_TOKEN: Deployed');
    expect(step(run, APPLY).out).toContain('Staged secrets applied.');
    expect(step(run, APPLY).out).not.toContain('::warning::');
    expect(run.calls).toEqual([
      `secrets set stage=1 app=${APP} names=GOOGLE_CLIENT_IDS METRICS_AUTH_TOKEN`,
      `secrets list json=1 app=${APP}`,
      `secrets deploy app=${APP}`,
      `secrets list json=1 app=${APP}`,
    ]);
    expect(run.ok).toBe(true);
    expectNoLeak(run);
  });

  it.each<[ListMode, string]>([
    ['partial', 'Partial'],
    ['deployed', 'Deployed'],
    ['no-status', 'Unknown'],
    ['legacy-capitalized', 'Unknown'],
  ])('post-check accepts the %s JSON shape and the apply step is reachable', (mode, status) => {
    const run = runJob({ list: mode, deployStaged: true });
    expect(step(run, CHECK)).toMatchObject({ ran: true, status: 0 });
    expect(step(run, CHECK).out).toContain(`GOOGLE_CLIENT_IDS: ${status}`);
    expect(step(run, APPLY)).toMatchObject({ ran: true, status: 0 });
    expect(run.calls).toContain(`secrets deploy app=${APP}`);
    expectNoLeak(run);
  });

  it('deploy_staged=false: stage + post-check succeed and nothing is applied', () => {
    const run = runJob({ list: 'staged', deployStaged: false });
    expect(run.ok).toBe(true);
    expect(step(run, CHECK)).toMatchObject({ ran: true, status: 0 });
    expect(step(run, APPLY).ran).toBe(false);
    expect(run.calls.some((c) => c.startsWith('secrets deploy'))).toBe(false);
    expectNoLeak(run);
  });

  it('nothing to stage (every allowlisted secret empty): no flyctl write, apply step is a no-op', () => {
    const run = runJob({ secrets: { FLY_API_TOKEN: 'fake-fly-token-not-a-secret' } });
    expect(run.ok).toBe(true);
    expect(step(run, STAGE).out).toContain('Nothing to stage.');
    expect(step(run, APPLY).out).toContain('Nothing was staged; skipping fly secrets deploy.');
    expect(run.calls).toEqual([]);
  });

  it('a staged name missing from the listing fails the post-check by name, with a fix, and blocks apply', () => {
    const run = runJob({ list: 'missing', deployStaged: true });
    const check = step(run, CHECK);
    expect(check.status).toBe(1);
    expect(check.out).toContain(
      'These names were staged but are not listed on Fly: METRICS_AUTH_TOKEN.',
    );
    expect(check.out).toContain('Fix: re-run this workflow');
    expect(step(run, APPLY).ran).toBe(false);
    expect(run.calls.some((c) => c.startsWith('secrets deploy'))).toBe(false);
    expectNoLeak(run);
  });

  it.each<[ListMode, string]>([
    ['not-array', 'ENVSYNC_NOT_ARRAY'],
    ['entry-without-name', 'ENVSYNC_ENTRY_NO_NAME'],
    ['not-json', 'ENVSYNC_INVALID_JSON'],
  ])('an unexpected --json shape (%s) fails closed with code %s and a fix', (mode, code) => {
    const run = runJob({ list: mode, deployStaged: true });
    const check = step(run, CHECK);
    expect(check.status).toBe(1);
    expect(check.out).toContain(`(${code})`);
    expect(check.out).toContain('Fix: the installed flyctl changed its JSON output');
    expect(step(run, APPLY).ran).toBe(false);
    expectNoLeak(run);
  });

  it('flyctl secrets list failing is reported with its exit code, an error class and a fix, never flyctl text', () => {
    const run = runJob({ listRc: 1 });
    const check = step(run, CHECK);
    expect(check.status).toBe(1);
    expect(check.out).toContain(
      `flyctl secrets list --json failed (exit 1, error class auth) for ${APP}`,
    );
    expect(check.out).toContain("flyctl's own error text is withheld from this log.");
    expect(check.out).toContain(
      'Fix: flyctl reported an authorization error; check that FLY_API_TOKEN is a valid token',
    );
    expect(check.out).not.toContain('token is not valid for app');
    expect(check.out).not.toMatch(/^Error/m);
    expect(step(run, APPLY).ran).toBe(false);
    // The EXIT trap removed the stderr / jq / status scratch files on the failure path.
    expect(Object.keys(run.files)).toEqual(['staged-names.txt']);
    expectNoLeak(run);
  });

  it('B-624-3: flyctl secrets list raw stderr never reaches the log (unclassified text)', () => {
    const run = runJob({ listRc: 2, listErr: 'raw' });
    const check = step(run, CHECK);
    expect(check.status).toBe(1);
    expect(check.out).toContain(
      `flyctl secrets list --json failed (exit 2, error class unclassified) for ${APP}`,
    );
    expect(check.out).toContain('Fix: check that FLY_API_TOKEN is a valid token');
    expect(Object.keys(run.files)).toEqual(['staged-names.txt']);
    expectNoLeak(run);
  });

  it('flyctl secrets set failing names the secrets, never prints flyctl text, and gives a fix', () => {
    const run = runJob({ setRc: 1 });
    const stage = step(run, STAGE);
    expect(stage.status).toBe(1);
    expect(stage.out).toContain(
      'flyctl secrets set --stage failed (exit 1, error class unclassified) for: GOOGLE_CLIENT_IDS METRICS_AUTH_TOKEN.',
    );
    expect(stage.out).toContain('Nothing was applied to running machines.');
    expect(stage.out).toContain(
      "flyctl's own error text is withheld from this log because it can echo secret values.",
    );
    expect(stage.out).toContain('Fix: check that FLY_API_TOKEN is a valid token');
    expect(stage.out).toContain('Staging the same values again is safe.');
    expect(stage.out).not.toContain('failed to update app secrets');
    expect(stage.out).not.toContain('<redacted>');
    expect(step(run, CHECK).ran).toBe(false);
    expect(step(run, APPLY).ran).toBe(false);
    expect(Object.keys(run.files)).toEqual([]);
    expectNoLeak(run);
  });

  // Sol B-624-3 reproduction plus every hostile value shape. The fake echoes
  // each NAME=VALUE pair, a quoted pair, a quoted bare value, the bare value
  // on its own line(s) (standalone), the value inside an "error:" line, and
  // the pair on stdout.
  it.each<[string, string]>([
    ['whitespace (Sol B-624-3 repro)', 'PREFIX_CANARY WHITESPACE_SECRET_FRAGMENT'],
    ['whitespace, several pieces', 'Kq7wsHEAD Kq7wsMIDDLE\tKq7wsTAIL'],
    ['newline (second line starts with Error)', 'Kq7nlHEAD\nError: Kq7nlTAIL\nerror Kq7nlLAST'],
    ['double and single quotes', `"Kq7qtHEAD" 'Kq7qtMIDDLE' Kq7qtTAIL"`],
    ['embedded = and :', 'Kq7eqHEAD=Kq7eqTAIL:Kq7coTAIL'],
    ['standalone token', 'Kq7STANDALONEVALUE'],
  ])(
    'B-624-3: a hostile flyctl set error with a %s value prints no value fragment',
    (_label, hostile) => {
      const run = runJob({
        secrets: {
          FLY_API_TOKEN: 'fake-fly-token-not-a-secret',
          GOOGLE_CLIENT_IDS: VALUE,
          METRICS_AUTH_TOKEN: hostile,
        },
        setRc: 42,
        setErr: 'hostile',
      });
      const stage = step(run, STAGE);
      expect(stage.status).toBe(1);
      expect(stage.out).toContain(
        'flyctl secrets set --stage failed (exit 42, error class unclassified) for: GOOGLE_CLIENT_IDS METRICS_AUTH_TOKEN.',
      );
      // Nothing but the step's own fixed lines was printed.
      for (const line of stage.out.split('\n').filter(Boolean))
        expect([line, STAGE_FAILURE_LINES.some((re) => re.test(line))]).toEqual([line, true]);
      expect(step(run, CHECK).ran).toBe(false);
      expect(step(run, APPLY).ran).toBe(false);
      // No artifact left behind: the stderr scratch file was removed by the EXIT trap.
      expect(Object.keys(run.files)).toEqual([]);
      expectNoFragment(run, hostile);
      expectNoLeak(run);
    },
  );

  it.each<[NonNullable<RunOptions['setErr']>, string, string]>([
    ['auth', 'auth', 'Fix: flyctl reported an authorization error'],
    ['app', 'app_not_found', `Fix: flyctl could not find ${APP}`],
    ['ratelimit', 'rate_limited', 'Fix: the Fly API is rate limiting this token'],
    ['network', 'network', 'Fix: the Fly API could not be reached'],
    ['empty', 'no_output', 'Fix: check that FLY_API_TOKEN is a valid token'],
  ])(
    'B-624-3: flyctl set error text %s maps to the allowlisted class %s with its fix',
    (setErr, cls, fix) => {
      const run = runJob({ setRc: 1, setErr });
      const stage = step(run, STAGE);
      expect(stage.status).toBe(1);
      expect(stage.out).toContain(
        `(exit 1, error class ${cls}) for: GOOGLE_CLIENT_IDS METRICS_AUTH_TOKEN.`,
      );
      expect(stage.out).toContain(fix);
      expect(stage.out).not.toMatch(
        /unauthorized|Could not find App|Too Many Requests|no such host/,
      );
      for (const line of stage.out.split('\n').filter(Boolean))
        expect([line, STAGE_FAILURE_LINES.some((re) => re.test(line))]).toEqual([line, true]);
      expectNoLeak(run);
    },
  );

  it('flyctl secrets deploy failing says the secrets stay staged and how to apply them', () => {
    const run = runJob({ deployRc: 1 });
    const apply = step(run, APPLY);
    expect(apply.status).toBe(1);
    expect(apply.out).toContain(
      `flyctl secrets deploy failed (exit 1, error class machine_health) for ${APP}.`,
    );
    expect(apply.out).toContain('The secrets stay staged and the next fly deploy applies them.');
    expect(apply.out).toContain('Fix: check machine health');
    expect(apply.out).not.toContain('failed health checks');
    expect(Object.keys(run.files)).toEqual(['staged-names.txt']);
    expectNoLeak(run);
  });

  it('B-624-3: flyctl secrets deploy raw stderr and stdout never reach the log', () => {
    const run = runJob({ deployRc: 3, deployErr: 'raw' });
    const apply = step(run, APPLY);
    expect(apply.status).toBe(1);
    expect(apply.out).toContain(
      `flyctl secrets deploy failed (exit 3, error class unclassified) for ${APP}.`,
    );
    expect(apply.out).toContain('re-run this workflow with deploy_staged=true');
    expectNoLeak(run);
    // Success path: the fake's deploy stdout canary is discarded too.
    const ok = runJob({});
    expect(step(ok, APPLY).status).toBe(0);
    expectNoLeak(ok);
  });

  it('after apply, a name not yet reported Deployed is a warning naming it, not a failure', () => {
    const run = runJob({ listAfter: 'staged' });
    const apply = step(run, APPLY);
    expect(apply.status).toBe(0);
    expect(apply.out).toContain('GOOGLE_CLIENT_IDS: Staged');
    expect(apply.out).toContain(
      `::warning::flyctl secrets deploy succeeded for ${APP}, but these names are not reported as Deployed yet: GOOGLE_CLIENT_IDS METRICS_AUTH_TOKEN.`,
    );
    expect(apply.out).toContain(`Fix: run 'fly status -a ${APP}'`);
    expectNoLeak(run);
  });

  it('after apply, a failed follow-up listing warns with its class and a fix, never flyctl text', () => {
    const run = runJob({ listAfterRc: 1 });
    const apply = step(run, APPLY);
    expect(apply.status).toBe(0);
    expect(apply.out).toContain(
      `::warning::flyctl secrets deploy succeeded for ${APP}, but the follow-up listing failed (flyctl exit 1, error class auth; jq exit 0)`,
    );
    expect(apply.out).toContain(`Fix: run 'fly secrets list -a ${APP}' from a trusted terminal`);
    expect(apply.out).not.toContain('token is not valid for app');
    expect(Object.keys(run.files)).toEqual(['staged-names.txt']);
    expectNoLeak(run);
  });

  it.each<[string, RunOptions, RegExp]>([
    [
      'a non-allowlisted app',
      { app: 'some-other-app' },
      /Fix: re-run with -f app=backend-spring-lake-3890/,
    ],
    ['confirm other than SET', { confirm: 'yes' }, /Fix: re-run with -f confirm=SET/],
    [
      'an empty FLY_API_TOKEN',
      { secrets: { GOOGLE_CLIENT_IDS: VALUE } },
      /Fix: create a deploy token with 'fly tokens create deploy -a backend-spring-lake-3890'/,
    ],
  ])('guards: %s stops before any flyctl call, with a fix', (_label, opts, fix) => {
    const run = runJob(opts);
    expect(run.ok).toBe(false);
    expect(run.log).toMatch(fix);
    expect(run.calls).toEqual([]);
    expect(step(run, STAGE).ran).toBe(false);
    expectNoLeak(run);
  });

  it('only staged-names.txt (names only) is left in the working directory', () => {
    const run = runJob({ list: 'staged' });
    expect(Object.keys(run.files)).toEqual(['staged-names.txt']);
    expect(run.files['staged-names.txt']).toBe('GOOGLE_CLIENT_IDS\nMETRICS_AUTH_TOKEN\n');
  });
});
