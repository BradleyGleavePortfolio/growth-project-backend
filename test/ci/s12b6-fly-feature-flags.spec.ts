// S12-B6 review closure (S12B6-SOL-B1, S12B6-SOL-B2): workflow tests for
// .github/workflows/fly-feature-flags-set.yml. These extract each shell step's
// `run:` block from the parsed YAML and execute it under synthetic env vars,
// the same technique the independent S12-B6 review used manually. This never
// calls flyctl or GitHub — it proves the shell logic in isolation. Never
// dispatch the real workflow against production; that boundary is out of
// scope for a test file and is enforced by the workflow's own app-allowlist
// and `environment: production` gate, not by anything here.

import { spawnSync } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { load as parseYaml } from 'js-yaml';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const WORKFLOW_PATH = join(ROOT, '.github/workflows/fly-feature-flags-set.yml');

type Step = { name?: string; run?: string; env?: Record<string, string> };
type Doc = { jobs?: Record<string, { steps?: Step[] }> };

function loadSteps(): Step[] {
  const doc = parseYaml(readFileSync(WORKFLOW_PATH, 'utf8')) as Doc;
  const job = doc.jobs?.['fly-feature-flags-set'];
  if (!job?.steps) throw new Error('fly-feature-flags-set job/steps not found');
  return job.steps;
}

function findStep(steps: Step[], name: string): Step {
  const step = steps.find((s) => s.name === name);
  if (!step?.run) throw new Error(`step not found or has no run: block: ${name}`);
  return step;
}

/**
 * Runs one step's `run:` block under bash with the given synthetic env vars
 * standing in for the `${{ inputs.* }}` / `${{ secrets.* }}` values the real
 * workflow would substitute into `env:`. GITHUB_ENV and GITHUB_OUTPUT are
 * pointed at a scratch file so `>> "${GITHUB_ENV}"` lines (used by the push
 * step) do not fail for lack of the real Actions runner.
 */
function runStep(step: Step, envOverrides: Record<string, string>) {
  const scratch = join(ROOT, '.tmp-s12b6-github-env');
  const r = spawnSync('bash', ['-c', step.run as string], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '/tmp',
      GITHUB_ENV: scratch,
      GITHUB_OUTPUT: scratch,
      ...envOverrides,
    },
  });
  return { code: r.status, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

describe('fly-feature-flags-set.yml — structural invariants (S12-B6)', () => {
  const yml = readFileSync(WORKFLOW_PATH, 'utf8');

  it('is workflow_dispatch only, never push/pull_request/schedule', () => {
    const on = yml.slice(yml.indexOf('\non:'), yml.indexOf('\npermissions:'));
    expect(on).toMatch(/workflow_dispatch:/);
    expect(on).not.toMatch(/^\s+push:/m);
    expect(on).not.toMatch(/pull_request/);
    expect(on).not.toMatch(/schedule/);
  });

  it('S12B6-SOL-B1: every flag/allowlist input defaults to empty (no default-on mutation)', () => {
    const doc = parseYaml(yml) as {
      on?: { workflow_dispatch?: { inputs?: Record<string, { default?: unknown; required?: unknown }> } };
    };
    const inputs = doc.on?.workflow_dispatch?.inputs ?? {};
    for (const name of [
      'feature_scout_ingest',
      'feature_extension_pairing',
      'feature_scout_reconstruct',
      'feature_scout_pilot_coach_ids',
    ]) {
      expect(inputs[name]).toBeDefined();
      expect(inputs[name].default).toBe('');
      expect(inputs[name].required).toBe(false);
    }
  });

  it('permissions is contents: read only; bound to the production environment', () => {
    expect(yml).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(yml).toMatch(/^\s+environment: production$/m);
  });

  it('no step run: block interpolates inputs.* directly (all go through env:)', () => {
    const steps = loadSteps();
    const inline = /\$\{\{\s*(github\.event\.)?inputs\./;
    for (const st of steps) if (st.run) expect(st.run).not.toMatch(inline);
  });

  it('never runs a destructive or deploying flyctl command', () => {
    const mutate = /flyctl\s+(machines?\s+(start|stop|restart|destroy|kill|update)|deploy|scale)\b/;
    for (const st of loadSteps()) if (st.run) expect(st.run).not.toMatch(mutate);
  });
});

describe('fly-feature-flags-set.yml — "Validate flag values" step (S12B6-SOL-B1 / B2)', () => {
  const step = () => findStep(loadSteps(), 'Validate flag values (empty = leave unchanged, S12B6-SOL-B1)');

  it('accepts all three flags empty (nothing specified) with exit 0', () => {
    const r = runStep(step(), { SCOUT: '', RECONSTRUCT: '', PAIRING: '' });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/not specified, leaving current Fly value unchanged/);
  });

  it('accepts a mix of empty and valid true/false with exit 0', () => {
    const r = runStep(step(), { SCOUT: 'true', RECONSTRUCT: '', PAIRING: 'false' });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/feature_scout_ingest: valid boolean/);
    expect(r.out).toMatch(/feature_scout_reconstruct: not specified/);
    expect(r.out).toMatch(/feature_extension_pairing: valid boolean/);
  });

  it('rejects a non-boolean, non-empty value with exit 1 and never echoes the value', () => {
    const secretish = 'sk-super-secret-token-should-not-appear';
    const r = runStep(step(), { SCOUT: secretish, RECONSTRUCT: '', PAIRING: '' });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/feature_scout_ingest must be exactly 'true', 'false', or empty/);
    expect(r.out).not.toContain(secretish);
  });

  it("rejects 'TRUE' / '1' / whitespace as not exactly the literal booleans", () => {
    for (const bad of ['TRUE', '1', ' true', 'true ']) {
      const r = runStep(step(), { SCOUT: bad, RECONSTRUCT: '', PAIRING: '' });
      expect(r.code).not.toBe(0);
    }
  });
});

describe('fly-feature-flags-set.yml — "Validate pilot coach allowlist shape" step (S12B6-SOL-B1 / B2)', () => {
  const step = () =>
    findStep(loadSteps(), 'Validate pilot coach allowlist shape (empty = leave unchanged, S12B6-SOL-B1)');

  it('empty means unchanged (exit 0, does not say "dark")', () => {
    const r = runStep(step(), { COACH_IDS: '' });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/not specified, leaving current Fly value unchanged/);
  });

  it('__CLEAR__ is accepted and described as going dark', () => {
    const r = runStep(step(), { COACH_IDS: '__CLEAR__' });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/will set the allowlist to empty/);
  });

  it('a single valid UUID is accepted', () => {
    const r = runStep(step(), { COACH_IDS: '11111111-1111-1111-1111-111111111111' });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/entries look like UUIDs/);
  });

  it('multiple valid UUIDs (comma-separated, with spaces) are accepted', () => {
    const r = runStep(step(), {
      COACH_IDS: '11111111-1111-1111-1111-111111111111, 22222222-2222-2222-2222-222222222222',
    });
    expect(r.code).toBe(0);
  });

  it('rejects junk and never echoes the offending value into the log', () => {
    const secretish = 'not-a-uuid-but-looks-like-a-token-abcdef123456';
    const r = runStep(step(), { COACH_IDS: secretish });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/has an entry that is not a UUID/);
    expect(r.out).not.toContain(secretish);
  });

  it('rejects a trailing comma / empty segment as junk', () => {
    const r = runStep(step(), { COACH_IDS: '11111111-1111-1111-1111-111111111111,' });
    expect(r.code).not.toBe(0);
  });
});

describe('fly-feature-flags-set.yml — "Push feature flags to Fly" argument construction (S12B6-SOL-B1)', () => {
  // The real step calls `flyctl secrets set`, which is not available (and
  // must never run) in this test environment. We exercise the argument-list
  // construction and the "nothing set" guard by stubbing `flyctl` as a no-op
  // that just echoes its argv, and by injecting FLY_API_TOKEN so the earlier
  // steps this one implicitly depends on are not the reason for a failure.
  const step = () => findStep(loadSteps(), 'Push feature flags to Fly (only inputs explicitly set this dispatch)');

  function runPushStep(envOverrides: Record<string, string>) {
    const stubDir = join(ROOT, '.tmp-s12b6-bin');
    mkdirSync(stubDir, { recursive: true });
    const stubPath = join(stubDir, 'flyctl');
    writeFileSync(stubPath, '#!/usr/bin/env bash\necho "flyctl called with: $*"\n', { mode: 0o755 });
    const scratch = join(ROOT, '.tmp-s12b6-github-env');
    const r = spawnSync('bash', ['-c', step().run as string], {
      encoding: 'utf8',
      env: {
        PATH: `${stubDir}:${process.env.PATH ?? ''}`,
        HOME: process.env.HOME ?? '/tmp',
        GITHUB_ENV: scratch,
        APP: 'backend-spring-lake-3890',
        FLY_API_TOKEN: 'stub-token',
        SCOUT: '',
        RECONSTRUCT: '',
        PAIRING: '',
        COACH_IDS: '',
        ...envOverrides,
      },
    });
    return { code: r.status, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
  }

  it('refuses to run (exit 1) when every input is empty — never a silent no-op push', () => {
    const r = runPushStep({});
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/No flag or allowlist input was set this dispatch/);
    expect(r.out).not.toContain('flyctl called with:');
  });

  it('pushes ONLY the one explicitly-set flag, omitting the other three names entirely', () => {
    const r = runPushStep({ RECONSTRUCT: 'false' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('flyctl called with:');
    expect(r.out).toContain('FEATURE_SCOUT_RECONSTRUCT=false');
    expect(r.out).not.toContain('FEATURE_SCOUT_INGEST=');
    expect(r.out).not.toContain('FEATURE_EXTENSION_PAIRING=');
    expect(r.out).not.toContain('FEATURE_SCOUT_PILOT_COACH_IDS=');
  });

  it('pushes only the allowlist when only it is set, and __CLEAR__ maps to an empty value', () => {
    const r = runPushStep({ COACH_IDS: '__CLEAR__' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('FEATURE_SCOUT_PILOT_COACH_IDS=');
    expect(r.out).not.toContain('FEATURE_SCOUT_INGEST=');
    expect(r.out).not.toContain('FEATURE_SCOUT_RECONSTRUCT=');
    expect(r.out).not.toContain('FEATURE_EXTENSION_PAIRING=');
  });

  it('pushes all four when all four are explicitly set', () => {
    const r = runPushStep({ SCOUT: 'true', RECONSTRUCT: 'false', PAIRING: 'true', COACH_IDS: '__CLEAR__' });
    expect(r.code).toBe(0);
    for (const name of [
      'FEATURE_SCOUT_INGEST=true',
      'FEATURE_SCOUT_RECONSTRUCT=false',
      'FEATURE_EXTENSION_PAIRING=true',
      'FEATURE_SCOUT_PILOT_COACH_IDS=',
    ]) {
      expect(r.out).toContain(name);
    }
  });
});
