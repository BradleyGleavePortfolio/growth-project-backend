/**
 * B-FLAGS-2 (T4): BEHAVIOURAL tests for .github/workflows/fly-env-sync.yml,
 * the manifest-driven plan -> apply -> verify path. Instead of matching the
 * YAML text, this spec runs the job's real `run:` scripts in order, the way
 * the GitHub runner does (`bash --noprofile --norc -eo pipefail`, cwd =
 * GITHUB_WORKSPACE), against a stateful fake `flyctl` on PATH:
 *   - `secrets list --json` renders the fake app's secrets (name, digest,
 *     status) the way flyctl does; the human table is never requested;
 *   - `secrets set --stage` / `secrets unset --stage` change the listing only
 *     (status Staged / name gone), like Fly;
 *   - `secrets deploy` copies the listing into the fake machine env (one
 *     rolling restart) and marks every name Deployed;
 *   - `ssh console -C <cmd>` runs <cmd> with the fake machine env, so the real
 *     in-machine check program answers match / differs / absent / present.
 *
 * Central assertions: plan never writes; apply writes exactly the planned
 * names; an apply with nothing to change writes nothing and never restarts;
 * rollback (unset) is proven absent in the machine; preconditions and empty
 * sources fail before any write; every failure has a "Fix:"; no secret value,
 * Fly digest or byte of flyctl's own output ever reaches the log, the job
 * summary or a scratch file (B-624-3, B-633-1/2, C-633-1/2/3).
 * No network, no real flyctl, no credentials.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import { load as parseYaml } from 'js-yaml';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..');
const WORKFLOW = path.join(ROOT, '.github/workflows/fly-env-sync.yml');
const MANIFEST_REL = '.github/fly-env-desired-state.json';
const APP = 'backend-spring-lake-3890';

// Distinctive sentinels so a leak is unambiguous.
const VALUE = 'leakcanary-ids-9f8e7d6c5b4a3921.apps.googleusercontent.com';
const OLD_VALUE = 'leakcanary-oldvalue-0a1b2c3d4e5f';
const DIGEST = 'leakcanary-digest-1a2b3c4d5e6f7a8b';
const LOCK_SECRET = 'ab'.repeat(32);

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

const FAKE_FLYCTL = `#!/usr/bin/env node
// Fake flyctl for fly-env-sync-behavior.spec.ts. Logs argv NAMES only.
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const dir = process.env.FAKE_DIR;
const statePath = path.join(dir, 'fly.json');
const machinePath = path.join(dir, 'machine-env.json');
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const machine = JSON.parse(fs.readFileSync(machinePath, 'utf8'));
const argv = process.argv.slice(2);
const sub = argv.slice(0, 2).join(' ');
const rest = argv.slice(2);
let app = '';
let stage = false;
let json = false;
let command = null;
const pos = [];
for (let i = 0; i < rest.length; i += 1) {
  const a = rest[i];
  if (a === '-a' || a === '--app') app = rest[++i];
  else if (a === '--stage') stage = true;
  else if (a === '--json' || a === '-j') json = true;
  else if (a === '-C' || a === '--command') command = rest[++i];
  else pos.push(a);
}
const log = (line) => fs.appendFileSync(path.join(dir, 'calls.log'), line + '\\n');
const save = () => {
  fs.writeFileSync(statePath, JSON.stringify(state));
  fs.writeFileSync(machinePath, JSON.stringify(machine));
};
const env = (k, d) => (process.env[k] === undefined ? d : process.env[k]);
const deployed = fs.existsSync(path.join(dir, 'deployed'));
function failWith(kind, values) {
  const err = {
    hostile: () => {
      for (const v of values) {
        process.stderr.write('Error: failed to update app secrets for ' + v + '\\n');
        process.stderr.write('Error: could not parse "' + v + '" (value \\'' + v + '\\')\\n');
        process.stderr.write(v + '\\n');
        process.stdout.write(v + '\\n');
      }
    },
    auth: () => process.stderr.write('Error: unauthorized: token is not valid for app ' + app + '\\n'),
    network: () => process.stderr.write('Error: dial tcp: lookup api.fly.io: no such host\\n'),
    health: () => process.stderr.write('Error: machine 1234abcd failed health checks\\n'),
    raw: () => process.stderr.write('Error: RAWFLYSTDERR-' + sub.replace(' ', '-') + ' upstream said something\\n'),
    empty: () => {},
  }[kind || 'raw'];
  err();
}
if (app !== '${APP}') {
  process.stderr.write('fake flyctl: wrong app\\n');
  process.exit(96);
}
switch (sub) {
  case 'secrets list': {
    log('secrets list json=' + (json ? 1 : 0));
    const rc = Number(deployed ? env('FAKE_LIST_AFTER_RC', '0') : env('FAKE_LIST_RC', '0'));
    if (rc !== 0) {
      failWith(env('FAKE_LIST_ERR', 'raw'), []);
      process.exit(rc);
    }
    if (!json) {
      process.stdout.write('NAME | DIGEST\\n* GOOGLE_CLIENT_IDS | ${DIGEST}\\n');
      break;
    }
    if (env('FAKE_LIST_SHAPE', '') === 'not-array') {
      process.stdout.write(JSON.stringify({ secrets: [] }));
      break;
    }
    const rows = Object.keys(state).map((name) =>
      env('FAKE_NO_STATUS', '') === '1'
        ? { name, digest: '${DIGEST}' }
        : { name, digest: '${DIGEST}', status: state[name].status },
    );
    process.stdout.write(JSON.stringify(rows, null, 4) + '\\n');
    break;
  }
  case 'secrets set': {
    const names = pos.map((p) => p.split('=')[0]);
    log('secrets set stage=' + (stage ? 1 : 0) + ' names=' + names.join(' '));
    if (Number(env('FAKE_SET_RC', '0')) !== 0) {
      failWith(env('FAKE_SET_ERR', 'raw'), pos);
      process.exit(Number(env('FAKE_SET_RC', '0')));
    }
    if (env('FAKE_SET_NOOP', '') !== '1') {
      for (const p of pos) {
        const i = p.indexOf('=');
        state[p.slice(0, i)] = { value: p.slice(i + 1), status: stage ? 'Staged' : 'Deployed' };
        if (!stage) machine[p.slice(0, i)] = p.slice(i + 1);
      }
    }
    save();
    process.stdout.write('RAWFLYSTDOUT-set staged ${DIGEST}\\n');
    break;
  }
  case 'secrets unset': {
    log('secrets unset stage=' + (stage ? 1 : 0) + ' names=' + pos.join(' '));
    if (Number(env('FAKE_UNSET_RC', '0')) !== 0) {
      failWith(env('FAKE_UNSET_ERR', 'raw'), []);
      process.exit(Number(env('FAKE_UNSET_RC', '0')));
    }
    for (const n of pos) {
      delete state[n];
      if (!stage) delete machine[n];
    }
    save();
    break;
  }
  case 'secrets deploy': {
    log('secrets deploy');
    if (Number(env('FAKE_DEPLOY_RC', '0')) !== 0) {
      failWith(env('FAKE_DEPLOY_ERR', 'health'), []);
      process.exit(Number(env('FAKE_DEPLOY_RC', '0')));
    }
    fs.writeFileSync(path.join(dir, 'deployed'), '');
    if (env('FAKE_DEPLOY_NOOP', '') !== '1') {
      for (const k of Object.keys(machine)) delete machine[k];
      for (const [k, v] of Object.entries(state)) {
        machine[k] = v.value;
        if (env('FAKE_DEPLOY_KEEP_STAGED', '') !== '1') v.status = 'Deployed';
      }
    }
    save();
    process.stdout.write('RAWFLYSTDOUT-deploy Updating machines ${DIGEST}\\n');
    break;
  }
  case 'ssh console': {
    log('ssh console');
    const rc = Number(deployed ? env('FAKE_SSH_AFTER_RC', '0') : env('FAKE_SSH_RC', '0'));
    if (rc !== 0) {
      failWith(env('FAKE_SSH_ERR', 'raw'), Object.values(machine));
      process.exit(rc);
    }
    process.stderr.write('Connecting to fdaa:0:1::2... complete RAWFLYSTDERR-ssh\\n');
    const r = cp.spawnSync('sh', ['-c', command], {
      env: { PATH: process.env.PATH, ...machine },
      encoding: 'utf8',
    });
    process.stdout.write(r.stdout);
    process.exit(r.status === null ? 1 : r.status);
  }
  default:
    process.stderr.write('fake flyctl: unexpected command: ' + sub + '\\n');
    process.exit(97);
}
`;

interface FlySecret {
  value: string;
  status: 'Deployed' | 'Staged' | 'Partial' | 'Unknown';
}
interface RunOptions {
  mode?: 'plan' | 'apply';
  confirm?: string;
  deployStaged?: boolean;
  app?: string;
  /** Use the checked-in manifest as is (default: the production-today baseline). */
  checkedIn?: boolean;
  /** One-line manifest edits: section.NAME -> value. */
  edits?: Record<string, string>;
  /** Fly's listing (and, for Deployed names, the machine env). */
  fly?: Record<string, FlySecret>;
  /** Extra machine-only env (staged unsets that are still live). */
  machineExtra?: Record<string, string>;
  /** Machine values that differ from the listing's (value drift). */
  machineOverride?: Record<string, string>;
  secrets?: Record<string, string>;
  fakeEnv?: Record<string, string>;
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
  log: string;
  summary: string;
  /** Every scratch file (RUNNER_TEMP) before the cleanup step, name -> content. */
  scratch: Record<string, string>;
  scratchAfter: string[];
  fly: Record<string, FlySecret>;
  machine: Record<string, string>;
  ok: boolean;
}

/** Production today (fly-secrets-list run 36885057965): what the manifest asserts. */
const PROD: Record<string, FlySecret> = {
  DATABASE_URL: { value: OLD_VALUE, status: 'Deployed' },
  GOOGLE_OAUTH_CLIENT_ID: { value: OLD_VALUE, status: 'Deployed' },
  GOOGLE_OAUTH_CLIENT_SECRET: { value: OLD_VALUE, status: 'Deployed' },
  GOOGLE_OAUTH_REDIRECT_URI: { value: OLD_VALUE, status: 'Deployed' },
  FEATURE_SCOUT_INGEST: { value: 'false', status: 'Deployed' },
};
const DEFAULT_SECRETS: Record<string, string> = {
  FLY_API_TOKEN: 'fake-fly-token-not-a-secret',
  GOOGLE_CLIENT_IDS: VALUE,
};

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

/** Evaluate the step `if:` expressions this workflow uses (and nothing else). */
function wants(cond: string | undefined, inputs: Record<string, string>, failed: boolean): boolean {
  if (cond === undefined) return !failed;
  if (cond === '${{ always() }}') return true;
  if (cond === "${{ inputs.mode == 'apply' }}") return !failed && inputs.mode === 'apply';
  if (cond === "${{ inputs.mode == 'apply' && inputs.deploy_staged }}")
    return !failed && inputs.mode === 'apply' && inputs.deploy_staged === 'true';
  throw new Error(
    `fly-env-sync-behavior.spec.ts cannot evaluate if: ${cond}. Fix: teach wants() this expression.`,
  );
}

/**
 * Production today: every flag unset and no GitHub-sourced secret, so these
 * cases do not depend on which one-line flips the checked-in manifest has.
 */
function baseline(text: string): string {
  const section = (t: string, name: string, fn: (block: string) => string) =>
    t.replace(new RegExp(`^  "${name}": \\{[\\s\\S]*?^  \\},?$`, 'm'), fn);
  let out = section(text, 'flags', (b) => b.replace(/^( {4}"[A-Z0-9_]+": )"[^"]*"/gm, '$1"unset"'));
  out = section(out, 'secrets', (b) =>
    b.replace(/^( {4}"[A-Z0-9_]+": )"github-secret"/gm, '$1"unset"'),
  );
  return out;
}

function applyEdits(text: string, edits: Record<string, string>): string {
  let out = text;
  for (const [key, value] of Object.entries(edits)) {
    const [section, name] = key.split('.');
    const re = new RegExp(`^( {4}"${name}": )"[^"]*"(,?)$`, 'm');
    const block = new RegExp(`^  "${section}": \\{[\\s\\S]*?^  \\},?$`, 'm');
    const m = block.exec(out);
    if (!m || !re.test(m[0])) throw new Error(`no ${key} line in the manifest`);
    out = out.replace(m[0], m[0].replace(re, `$1"${value}"$2`));
  }
  return out;
}

function runJob(o: RunOptions = {}): JobRun {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fly-env-sync-'));
  const ws = path.join(dir, 'ws');
  const bin = path.join(dir, 'bin');
  const temp = path.join(dir, 'runner-temp');
  for (const d of [
    bin,
    temp,
    path.join(ws, '.github'),
    path.join(ws, 'scripts/fly-env'),
    path.join(ws, 'src/common'),
  ])
    fs.mkdirSync(d, { recursive: true });
  for (const f of ['scripts/fly-env/fly-env-manifest.js', 'src/common/env-validation.ts'])
    fs.copyFileSync(path.join(ROOT, f), path.join(ws, f));
  fs.writeFileSync(
    path.join(ws, MANIFEST_REL),
    applyEdits(
      o.checkedIn
        ? fs.readFileSync(path.join(ROOT, MANIFEST_REL), 'utf8')
        : baseline(fs.readFileSync(path.join(ROOT, MANIFEST_REL), 'utf8')),
      o.edits ?? {},
    ),
  );
  fs.writeFileSync(path.join(bin, 'flyctl'), FAKE_FLYCTL, { mode: 0o755 });
  const fly = o.fly ?? PROD;
  fs.writeFileSync(path.join(dir, 'fly.json'), JSON.stringify(fly));
  const machine: Record<string, string> = {};
  for (const [k, v] of Object.entries(fly)) if (v.status === 'Deployed') machine[k] = v.value;
  Object.assign(machine, o.machineExtra ?? {}, o.machineOverride ?? {});
  fs.writeFileSync(path.join(dir, 'machine-env.json'), JSON.stringify(machine));
  const summaryFile = path.join(dir, 'summary.md');
  const secrets = o.secrets ?? DEFAULT_SECRETS;
  const inputs = {
    app: o.app ?? APP,
    mode: o.mode ?? 'plan',
    confirm: o.confirm ?? (o.mode === 'apply' ? 'SET' : ''),
    deploy_staged: String(o.deployStaged ?? false),
  };
  const results: StepRun[] = [];
  let failed = false;
  let scratch: Record<string, string> = {};
  for (const step of steps) {
    const name = step.name ?? step.uses ?? '(unnamed)';
    if (step.uses) {
      // checkout / setup-node / setup-flyctl: the copied workspace, the test's
      // node and the fake flyctl on PATH stand in for them.
      results.push({ name, ran: false, status: null, out: '' });
      continue;
    }
    if (!wants(step.if, inputs, failed)) {
      results.push({ name, ran: false, status: null, out: '' });
      continue;
    }
    if (step.if === '${{ always() }}') {
      const sd = path.join(temp, 'fly-env-sync');
      scratch = {};
      if (fs.existsSync(sd))
        for (const f of fs.readdirSync(sd)) scratch[f] = fs.readFileSync(path.join(sd, f), 'utf8');
    }
    const script = path.join(dir, `step-${results.length}.sh`);
    fs.writeFileSync(script, step.run ?? '');
    const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], {
      cwd: ws,
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        HOME: dir,
        FAKE_DIR: dir,
        GITHUB_WORKSPACE: ws,
        RUNNER_TEMP: temp,
        GITHUB_STEP_SUMMARY: summaryFile,
        ...(o.fakeEnv ?? {}),
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
  const sd = path.join(temp, 'fly-env-sync');
  const run: JobRun = {
    steps: results,
    calls,
    log: results.map((s) => s.out).join('\n'),
    summary: fs.existsSync(summaryFile) ? fs.readFileSync(summaryFile, 'utf8') : '',
    scratch,
    scratchAfter: fs.existsSync(sd) ? fs.readdirSync(sd) : [],
    fly: JSON.parse(fs.readFileSync(path.join(dir, 'fly.json'), 'utf8')) as Record<
      string,
      FlySecret
    >,
    machine: JSON.parse(fs.readFileSync(path.join(dir, 'machine-env.json'), 'utf8')) as Record<
      string,
      string
    >,
    ok: !failed,
  };
  fs.rmSync(dir, { recursive: true, force: true });
  return run;
}

const step = (run: JobRun, re: RegExp): StepRun => {
  const s = run.steps.find((x) => re.test(x.name));
  if (!s) throw new Error(`no step matching ${re}`);
  return s;
};
const PLAN = /^Plan \(names, status and actions only\)$/;
const STAGE = /^Stage the planned changes/;
const VERIFY = /^Verify Fly matches the manifest/;
const DEPLOY = /^Apply staged changes now/;
const VALIDATE = /^Validate the desired-state manifest/;
const writes = (run: JobRun): string[] =>
  run.calls.filter((c) => /^secrets (set|unset|deploy)/.test(c));
const planRow = (run: JobRun, name: string): string =>
  step(run, PLAN)
    .out.split('\n')
    .find((l) => l.startsWith(`${name} | `)) ?? '';

/** No secret value, Fly digest or flyctl output anywhere: log, summary, scratch files. */
function expectNoLeak(run: JobRun, extra: readonly string[] = []): void {
  const everything = [run.log, run.summary, ...Object.values(run.scratch)].join('\n');
  for (const s of [VALUE, OLD_VALUE, DIGEST, LOCK_SECRET, 'leakcanary', 'RAWFLYSTD', ...extra])
    expect([s, everything.includes(s)]).toEqual([s, false]);
}

/** Every line printed with ::error:: or ::warning:: carries a Fix: (B-633-2). */
function expectFixOnEveryProblem(run: JobRun): void {
  for (const line of run.log.split('\n').filter((l) => /::(error|warning)::/.test(l)))
    expect([line, /Fix: /.test(line)]).toEqual([line, true]);
}

describe('fly-env-sync.yml behaviour (fake flyctl, real run: scripts)', () => {
  it('the toolchain the steps rely on is present (ubuntu-latest ships bash, jq and node)', () => {
    expect(spawnSync('jq', ['--version']).status).toBe(0);
    expect(spawnSync('node', ['--version']).status).toBe(0);
  });

  it('run: blocks never interpolate ${{ }} expressions (inputs reach the shell only via env)', () => {
    for (const s of steps)
      expect([s.name, s.run ?? '']).toEqual([s.name, expect.not.stringContaining('${{')]);
  });

  describe('plan mode (default)', () => {
    it('on production as it is today: every row keeps, nothing is written, the summary has the table', () => {
      const run = runJob();
      expect(run.ok).toBe(true);
      expect(writes(run)).toEqual([]);
      expect(run.calls).toEqual(['secrets list json=1', 'ssh console']);
      const plan = step(run, PLAN).out;
      expect(plan).toMatch(
        /^Desired state: \.github\/fly-env-desired-state\.json sha256 [0-9a-f]{64}$/m,
      );
      expect(plan).toContain(
        'Plan: 0 to set, 0 to unset, 0 staged earlier and waiting for a deploy',
      );
      expect(plan).toContain(
        'Fly already matches the manifest: apply would write nothing and restart nothing.',
      );
      expect(planRow(run, 'FEATURE_AI_CONSENT_LEDGER_ENABLED')).toBe(
        'FEATURE_AI_CONSENT_LEDGER_ENABLED | flag | unset | absent | absent | keep | absent, as declared',
      );
      expect(planRow(run, 'GOOGLE_OAUTH_CLIENT_SECRET')).toBe(
        'GOOGLE_OAUTH_CLIENT_SECRET | secret | present | Deployed | present | keep | present and deployed; value owned outside this manifest',
      );
      expect(run.summary).toContain('## Fly env sync plan');
      expect(run.summary).toContain('FEATURE_DUNNING_V2 | flag | unset | absent');
      expect(step(run, STAGE).ran).toBe(false);
      expect(step(run, VERIFY).ran).toBe(false);
      expect(step(run, DEPLOY).ran).toBe(false);
      expect(run.scratchAfter).toEqual([]);
      expectNoLeak(run);
    });

    it('the checked-in manifest, as is, plans cleanly against production and writes nothing', () => {
      const run = runJob({
        checkedIn: true,
        secrets: { ...DEFAULT_SECRETS, MWB_AUTOSAVE_LOCK_TOKEN_SECRET: LOCK_SECRET },
      });
      expect(run.ok).toBe(true);
      expect(writes(run)).toEqual([]);
      expect(step(run, PLAN).out).toMatch(/^Plan: \d+ to set, \d+ to unset, /m);
      expectNoLeak(run);
    });

    it('a flip PR shows exactly one set and still writes nothing in plan mode', () => {
      const run = runJob({ edits: { 'flags.FEATURE_AI_CONSENT_LEDGER_ENABLED': 'true' } });
      expect(run.ok).toBe(true);
      expect(writes(run)).toEqual([]);
      expect(planRow(run, 'FEATURE_AI_CONSENT_LEDGER_ENABLED')).toBe(
        'FEATURE_AI_CONSENT_LEDGER_ENABLED | flag | true | absent | absent | set | not on Fly',
      );
      expect(step(run, PLAN).out).toContain('Plan: 1 to set, 0 to unset');
    });

    it('C-633-2: a flag already Deployed with the declared value is kept, not re-set', () => {
      const run = runJob({
        edits: { 'flags.FEATURE_AI_CONSENT_LEDGER_ENABLED': 'true' },
        fly: { ...PROD, FEATURE_AI_CONSENT_LEDGER_ENABLED: { value: 'true', status: 'Deployed' } },
      });
      expect(planRow(run, 'FEATURE_AI_CONSENT_LEDGER_ENABLED')).toBe(
        'FEATURE_AI_CONSENT_LEDGER_ENABLED | flag | true | Deployed | match | keep | deployed and the machine holds the declared value',
      );
    });

    it('lists secrets staged by other workflows that deploy_staged would also apply', () => {
      const run = runJob({
        fly: { ...PROD, RECENT_AUTH_SECRET: { value: OLD_VALUE, status: 'Staged' } },
      });
      expect(step(run, PLAN).out).toContain(
        'Not managed here but staged on Fly (deploy_staged=true would apply these too): RECENT_AUTH_SECRET.',
      );
      expectNoLeak(run);
    });

    it('rejects deploy_staged=true in plan mode before any flyctl call', () => {
      const run = runJob({ deployStaged: true });
      expect(run.ok).toBe(false);
      expect(run.calls).toEqual([]);
      expect(step(run, /^Confirm operator intent$/).out).toContain(
        'Fix: re-run with -f mode=apply',
      );
    });
  });

  describe('apply mode', () => {
    it('stages exactly the planned flip with --stage, verifies it, and does not deploy by default', () => {
      const run = runJob({
        mode: 'apply',
        edits: { 'flags.FEATURE_AI_CONSENT_LEDGER_ENABLED': 'true' },
      });
      expect(run.ok).toBe(true);
      expect(writes(run)).toEqual(['secrets set stage=1 names=FEATURE_AI_CONSENT_LEDGER_ENABLED']);
      expect(run.fly.FEATURE_AI_CONSENT_LEDGER_ENABLED).toEqual({
        value: 'true',
        status: 'Staged',
      });
      expect(run.machine.FEATURE_AI_CONSENT_LEDGER_ENABLED).toBeUndefined();
      expect(step(run, VERIFY).out).toContain(
        'Verified: every managed name is present or absent on Fly exactly as declared.',
      );
      expect(step(run, DEPLOY).ran).toBe(false);
      expectNoLeak(run);
    });

    it('deploy_staged=true: one deploy, then the running machine is proven to hold the value', () => {
      const run = runJob({
        mode: 'apply',
        deployStaged: true,
        edits: {
          'flags.FEATURE_AI_CONSENT_LEDGER_ENABLED': 'true',
          'flags.BOOKING_REMINDERS_ENABLED': 'on',
        },
      });
      expect(run.ok).toBe(true);
      expect(writes(run)).toEqual([
        'secrets set stage=1 names=FEATURE_AI_CONSENT_LEDGER_ENABLED BOOKING_REMINDERS_ENABLED',
        'secrets deploy',
      ]);
      expect(run.machine.BOOKING_REMINDERS_ENABLED).toBe('on');
      expect(step(run, DEPLOY).out).toContain(
        'Verified after deploy: every managed name is present or absent exactly as declared, and the running machine matches.',
      );
      expectNoLeak(run);
    });

    it('idempotent: re-applying a manifest Fly already matches writes nothing and never restarts', () => {
      const run = runJob({
        mode: 'apply',
        deployStaged: true,
        edits: { 'flags.FEATURE_AI_CONSENT_LEDGER_ENABLED': 'true' },
        fly: { ...PROD, FEATURE_AI_CONSENT_LEDGER_ENABLED: { value: 'true', status: 'Deployed' } },
      });
      expect(run.ok).toBe(true);
      expect(writes(run)).toEqual([]);
      expect(step(run, STAGE).out).toContain('Nothing to stage: Fly already matches the manifest.');
      expect(step(run, DEPLOY).out).toContain(
        'flyctl secrets deploy was skipped and no machine restarts.',
      );
    });

    it('a deployed value that differs in the machine is re-set', () => {
      const run = runJob({
        mode: 'apply',
        edits: { 'flags.SIGNUP_ROLE_CHOICE_ENABLED': 'true' },
        fly: { ...PROD, SIGNUP_ROLE_CHOICE_ENABLED: { value: 'false', status: 'Deployed' } },
      });
      expect(planRow(run, 'SIGNUP_ROLE_CHOICE_ENABLED')).toContain('| Deployed | differs | set |');
      expect(writes(run)).toEqual(['secrets set stage=1 names=SIGNUP_ROLE_CHOICE_ENABLED']);
    });

    it('rollback: a name declared unset is unset with --stage, and after deploy it is gone from the machine (C-633-1: one restart)', () => {
      const run = runJob({
        mode: 'apply',
        deployStaged: true,
        fly: { ...PROD, FEATURE_DUNNING_V2: { value: 'true', status: 'Deployed' } },
      });
      expect(run.ok).toBe(true);
      expect(planRow(run, 'FEATURE_DUNNING_V2')).toBe(
        'FEATURE_DUNNING_V2 | flag | unset | Deployed | present | unset | declared unset; Fly lists it (Deployed)',
      );
      expect(writes(run)).toEqual([
        'secrets unset stage=1 names=FEATURE_DUNNING_V2',
        'secrets deploy',
      ]);
      expect(run.machine.FEATURE_DUNNING_V2).toBeUndefined();
    });

    it('an unset staged earlier but still live in the machine is reported pending and deployed without another write', () => {
      const run = runJob({
        mode: 'apply',
        deployStaged: true,
        machineExtra: { FEATURE_DUNNING_V2: 'true' },
      });
      expect(planRow(run, 'FEATURE_DUNNING_V2')).toContain(
        '| absent | present | keep | unset is staged on Fly',
      );
      expect(writes(run)).toEqual(['secrets deploy']);
      expect(run.machine.FEATURE_DUNNING_V2).toBeUndefined();
      expect(run.ok).toBe(true);
    });

    it('a Staged or Partial managed value is staged again (it cannot be read back), without a restart', () => {
      const run = runJob({
        mode: 'apply',
        edits: { 'flags.FEATURE_DUNNING_V2': 'true' },
        fly: { ...PROD, FEATURE_DUNNING_V2: { value: 'true', status: 'Partial' } },
      });
      expect(planRow(run, 'FEATURE_DUNNING_V2')).toContain('| Partial |');
      expect(writes(run)).toEqual(['secrets set stage=1 names=FEATURE_DUNNING_V2']);
    });

    it('copies a github-secret source without printing it; the set call carries the value only in argv', () => {
      const run = runJob({
        mode: 'apply',
        deployStaged: true,
        edits: { 'secrets.GOOGLE_CLIENT_IDS': 'github-secret' },
      });
      expect(run.ok).toBe(true);
      expect(planRow(run, 'GOOGLE_CLIENT_IDS')).toBe(
        'GOOGLE_CLIENT_IDS | secret | github-secret | absent | absent | set | not on Fly',
      );
      expect(writes(run)).toEqual([
        'secrets set stage=1 names=GOOGLE_CLIENT_IDS',
        'secrets deploy',
      ]);
      expect(run.machine.GOOGLE_CLIENT_IDS).toBe(VALUE);
      expectNoLeak(run);
    });

    it('MWB autosave with its lock secret: both staged together', () => {
      const run = runJob({
        mode: 'apply',
        edits: {
          'flags.FEATURE_MWB_AUTOSAVE_UNDO': 'true',
          'secrets.MWB_AUTOSAVE_LOCK_TOKEN_SECRET': 'github-secret',
        },
        secrets: { ...DEFAULT_SECRETS, MWB_AUTOSAVE_LOCK_TOKEN_SECRET: LOCK_SECRET },
      });
      expect(run.ok).toBe(true);
      expect(writes(run)).toEqual([
        'secrets set stage=1 names=FEATURE_MWB_AUTOSAVE_UNDO MWB_AUTOSAVE_LOCK_TOKEN_SECRET',
      ]);
      expectNoLeak(run);
    });
  });

  describe('fails closed with a specific message and a Fix, before any write', () => {
    it('precondition: MWB autosave without its lock secret fails validation with no Fly call at all', () => {
      const run = runJob({ mode: 'apply', edits: { 'flags.FEATURE_MWB_AUTOSAVE_UNDO': 'true' } });
      expect(run.ok).toBe(false);
      expect(run.calls).toEqual([]);
      expect(step(run, VALIDATE).out).toContain('precondition mwb-autosave-needs-lock-secret');
      expect(step(run, VALIDATE).out).toContain('Fix: create the GitHub secret');
      expectFixOnEveryProblem(run);
    });

    it('precondition: a community surface flag without FEATURE_COMMUNITY_API fails validation', () => {
      const run = runJob({ edits: { 'flags.FEATURE_COMMUNITY_POSTS': 'true' } });
      expect(run.ok).toBe(false);
      expect(step(run, VALIDATE).out).toContain('precondition community-subflag-needs-api');
      expectFixOnEveryProblem(run);
    });

    it('a value outside the closed set (BOOKING_REMINDERS_ENABLED=true) fails validation', () => {
      const run = runJob({ edits: { 'flags.BOOKING_REMINDERS_ENABLED': 'true' } });
      expect(run.ok).toBe(false);
      expect(step(run, VALIDATE).out).toContain(
        'flags.BOOKING_REMINDERS_ENABLED is "true", which its code does not read as a distinct value. Fix: use one of "on", "off" or "unset".',
      );
    });

    it('github-secret with an empty GitHub secret fails the plan, nothing written', () => {
      const run = runJob({
        mode: 'apply',
        edits: { 'secrets.METRICS_AUTH_TOKEN': 'github-secret' },
      });
      expect(run.ok).toBe(false);
      expect(writes(run)).toEqual([]);
      expect(step(run, PLAN).out).toContain(
        'METRICS_AUTH_TOKEN is declared "github-secret" but the GitHub Actions secret METRICS_AUTH_TOKEN is empty or not set for this workflow. Fix: create it with \'gh secret set METRICS_AUTH_TOKEN\'',
      );
      expect(step(run, STAGE).ran).toBe(false);
      expectFixOnEveryProblem(run);
    });

    it('GOOGLE_CLIENT_IDS with an empty entry fails its shape check without printing the value', () => {
      const bad = 'leakcanary-a.apps.googleusercontent.com,,leakcanary-b';
      const run = runJob({
        mode: 'apply',
        edits: { 'secrets.GOOGLE_CLIENT_IDS': 'github-secret' },
        secrets: { ...DEFAULT_SECRETS, GOOGLE_CLIENT_IDS: bad },
      });
      expect(run.ok).toBe(false);
      expect(writes(run)).toEqual([]);
      expect(step(run, PLAN).out).toContain('fails its shape check (empty-client-id-entry)');
      expectNoLeak(run, [bad]);
    });

    it('a secret declared present that Fly does not list fails the plan', () => {
      const fly = { ...PROD };
      delete (fly as Record<string, FlySecret | undefined>).GOOGLE_OAUTH_REDIRECT_URI;
      const run = runJob({ mode: 'apply', fly });
      expect(run.ok).toBe(false);
      expect(writes(run)).toEqual([]);
      expect(step(run, PLAN).out).toContain(
        'GOOGLE_OAUTH_REDIRECT_URI is declared "present" (its value is owned outside this manifest) but Fly does not list it. Fix:',
      );
    });

    it.each<[string, RunOptions, string]>([
      [
        'a non-production app',
        { app: 'some-other-app' },
        'Fix: re-run with -f app=backend-spring-lake-3890.',
      ],
      [
        'apply without confirm=SET',
        { mode: 'apply', confirm: 'yes' },
        'Fix: re-run with -f confirm=SET',
      ],
      [
        'an empty FLY_API_TOKEN',
        { secrets: { FLY_API_TOKEN: '' } },
        "Fix: create a deploy token with 'fly tokens create deploy",
      ],
    ])('guards: %s stops before any flyctl call', (_label, o, fix) => {
      const run = runJob(o);
      expect(run.ok).toBe(false);
      expect(run.calls).toEqual([]);
      expect(run.log).toContain(fix);
    });
  });

  describe('flyctl failures: fixed messages only (B-624-3)', () => {
    it('listing failure: exit code, error class and a Fix; no flyctl text; nothing written', () => {
      const run = runJob({ mode: 'apply', fakeEnv: { FAKE_LIST_RC: '1', FAKE_LIST_ERR: 'auth' } });
      expect(run.ok).toBe(false);
      expect(writes(run)).toEqual([]);
      expect(step(run, PLAN).out).toContain(
        'flyctl secrets list --json failed (exit 1, error class auth) for backend-spring-lake-3890, so nothing could be planned and nothing was changed.',
      );
      expect(run.log).not.toContain('unauthorized');
      expectFixOnEveryProblem(run);
      expectNoLeak(run);
    });

    it('listing that is not a JSON array fails with its fixed code', () => {
      const run = runJob({ fakeEnv: { FAKE_LIST_SHAPE: 'not-array' } });
      expect(run.ok).toBe(false);
      expect(step(run, PLAN).out).toContain('(ENVSYNC_NOT_ARRAY)');
      expectFixOnEveryProblem(run);
    });

    it('a listing without status (machine data unavailable) reads as Unknown and re-stages declared values', () => {
      const run = runJob({
        mode: 'apply',
        edits: { 'flags.FEATURE_AI_CONSENT_LEDGER_ENABLED': 'true' },
        fly: { ...PROD, FEATURE_AI_CONSENT_LEDGER_ENABLED: { value: 'true', status: 'Deployed' } },
        fakeEnv: { FAKE_NO_STATUS: '1' },
      });
      expect(planRow(run, 'FEATURE_AI_CONSENT_LEDGER_ENABLED')).toContain('| Unknown |');
      expect(writes(run)).toEqual(['secrets set stage=1 names=FEATURE_AI_CONSENT_LEDGER_ENABLED']);
    });

    it('ssh unavailable: a warning with a Fix, values unproven and staged again, hostile ssh output withheld', () => {
      const run = runJob({
        mode: 'apply',
        edits: { 'flags.FEATURE_AI_CONSENT_LEDGER_ENABLED': 'true' },
        fly: { ...PROD, FEATURE_AI_CONSENT_LEDGER_ENABLED: { value: 'true', status: 'Deployed' } },
        fakeEnv: { FAKE_SSH_RC: '1', FAKE_SSH_ERR: 'hostile' },
      });
      expect(run.ok).toBe(true);
      expect(step(run, PLAN).out).toContain(
        '::warning::flyctl ssh console failed (exit 1, error class unclassified), so the in-machine value check did not run',
      );
      expect(planRow(run, 'FEATURE_AI_CONSENT_LEDGER_ENABLED')).toContain(
        '| unavailable | set | deployed, but the in-machine check did not run',
      );
      expect(writes(run)).toEqual(['secrets set stage=1 names=FEATURE_AI_CONSENT_LEDGER_ENABLED']);
      expectFixOnEveryProblem(run);
      expectNoLeak(run);
    });

    it.each<[string, string]>([
      ['whitespace', 'Kq7wsHEAD Kq7wsMIDDLE\tKq7wsTAIL'],
      ['newline', 'Kq7nlHEAD\nError: Kq7nlTAIL'],
      ['quotes', `"Kq7qtHEAD" 'Kq7qtMIDDLE'`],
      ['= and :', 'Kq7eqHEAD=Kq7eqTAIL:Kq7coTAIL'],
    ])('a hostile flyctl set error with a %s value prints no fragment of it', (_label, hostile) => {
      const run = runJob({
        mode: 'apply',
        edits: { 'secrets.METRICS_AUTH_TOKEN': 'github-secret' },
        secrets: { ...DEFAULT_SECRETS, METRICS_AUTH_TOKEN: hostile },
        fakeEnv: { FAKE_SET_RC: '42', FAKE_SET_ERR: 'hostile' },
      });
      expect(run.ok).toBe(false);
      expect(step(run, STAGE).out).toContain(
        'flyctl secrets set --stage failed (exit 42, error class unclassified) for: METRICS_AUTH_TOKEN.',
      );
      const everything = [run.log, run.summary, ...Object.values(run.scratch)].join('\n');
      for (const f of hostile.split(/[\s"'=:]+/).filter((t) => t.length >= 6))
        expect([f, everything.includes(f)]).toEqual([f, false]);
      expect(step(run, VERIFY).ran).toBe(false);
      expectFixOnEveryProblem(run);
      expectNoLeak(run);
    });

    it('unset failure: fixed message with a Fix, flyctl text withheld', () => {
      const run = runJob({
        mode: 'apply',
        fly: { ...PROD, FEATURE_DUNNING_V2: { value: 'true', status: 'Deployed' } },
        fakeEnv: { FAKE_UNSET_RC: '1' },
      });
      expect(run.ok).toBe(false);
      expect(step(run, STAGE).out).toContain(
        'flyctl secrets unset --stage failed (exit 1, error class unclassified) for: FEATURE_DUNNING_V2.',
      );
      expectFixOnEveryProblem(run);
      expectNoLeak(run);
    });

    it('deploy failure: the changes stay staged, with a Fix; flyctl text withheld', () => {
      const run = runJob({
        mode: 'apply',
        deployStaged: true,
        edits: { 'flags.FEATURE_AI_CONSENT_LEDGER_ENABLED': 'true' },
        fakeEnv: { FAKE_DEPLOY_RC: '1', FAKE_DEPLOY_ERR: 'raw' },
      });
      expect(run.ok).toBe(false);
      expect(step(run, DEPLOY).out).toContain(
        'flyctl secrets deploy failed (exit 1, error class unclassified) for backend-spring-lake-3890. The changes stay staged',
      );
      expectFixOnEveryProblem(run);
      expectNoLeak(run);
    });
  });

  describe('verification is exact (B-633-1: no false green)', () => {
    it('a set that did not stick fails the staged verification by name', () => {
      const run = runJob({
        mode: 'apply',
        edits: { 'flags.FEATURE_AI_CONSENT_LEDGER_ENABLED': 'true' },
        fakeEnv: { FAKE_SET_NOOP: '1' },
      });
      expect(run.ok).toBe(false);
      expect(step(run, VERIFY).out).toContain(
        'These names are declared with a value but Fly does not list them: FEATURE_AI_CONSENT_LEDGER_ENABLED. Fix:',
      );
    });

    it('a machine that does not pick up the deploy fails the deployed verification', () => {
      const run = runJob({
        mode: 'apply',
        deployStaged: true,
        edits: { 'flags.FEATURE_AI_CONSENT_LEDGER_ENABLED': 'true' },
        fakeEnv: { FAKE_DEPLOY_NOOP: '1' },
      });
      expect(run.ok).toBe(false);
      expect(step(run, DEPLOY).out).toContain(
        'After flyctl secrets deploy the running machine does not match the manifest for: FEATURE_AI_CONSENT_LEDGER_ENABLED (absent). Fix:',
      );
      expectFixOnEveryProblem(run);
    });

    it('names still Staged after deploy are a warning with a Fix, not a failure', () => {
      const run = runJob({
        mode: 'apply',
        deployStaged: true,
        edits: { 'flags.FEATURE_AI_CONSENT_LEDGER_ENABLED': 'true' },
        fakeEnv: { FAKE_DEPLOY_KEEP_STAGED: '1' },
      });
      expect(run.ok).toBe(true);
      expect(step(run, DEPLOY).out).toContain(
        '::warning::flyctl secrets deploy succeeded, but Fly does not report these names as Deployed yet: FEATURE_AI_CONSENT_LEDGER_ENABLED.',
      );
      expectFixOnEveryProblem(run);
    });

    it('the human secrets table is never requested; every listing is --json', () => {
      const run = runJob({
        mode: 'apply',
        deployStaged: true,
        edits: { 'flags.FEATURE_DUNNING_V2': 'true' },
      });
      const lists = run.calls.filter((c) => c.startsWith('secrets list'));
      expect(lists.length).toBe(3);
      expect(new Set(lists)).toEqual(new Set(['secrets list json=1']));
    });

    it('scratch files hold names, statuses and words only, and are removed at the end', () => {
      const run = runJob({
        mode: 'apply',
        deployStaged: true,
        edits: { 'flags.FEATURE_DUNNING_V2': 'true', 'secrets.GOOGLE_CLIENT_IDS': 'github-secret' },
      });
      expect(run.ok).toBe(true);
      expect(Object.keys(run.scratch).sort()).toEqual(
        [
          'changed.txt',
          'compare-names.json',
          'compare.cmd',
          'fly-state-deployed.tsv',
          'fly-state-staged.tsv',
          'fly-state.tsv',
          'machine-after.json',
          'machine.json',
          'pending.txt',
          'set-flags.txt',
          'set-secrets.txt',
          'sources.json',
          'unset.txt',
        ].sort(),
      );
      expect(run.scratch['set-secrets.txt']).toBe('GOOGLE_CLIENT_IDS\n');
      expect(run.scratch['set-flags.txt']).toBe('FEATURE_DUNNING_V2=true\n');
      expect(run.scratchAfter).toEqual([]);
      expectNoLeak(run);
    });
  });
});
