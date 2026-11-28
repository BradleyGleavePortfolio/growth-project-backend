// PRODUCTION-SECRETS-ENV-BE (owner decision ALM-D11 op 1): fail-closed behaviour of
// scripts/ci/secrets-environment-guard.sh, driven through the fake `gh`
// (test/ci/fixtures/fake-gh.sh) that serves JSON fixtures per API path. Each case
// changes one thing in an otherwise passing world (G9 is the control), so a
// regression that loosens one check is caught by one named case.

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const GUARD = join(ROOT, 'scripts', 'ci', 'secrets-environment-guard.sh');
const FAKE_GH = join(__dirname, 'fixtures', 'fake-gh.sh');

const REPO = 'BradleyGleavePortfolio/growth-project-backend';
const ENV = 'production-secrets';
const ENV_PATH = `repos/${REPO}/environments/${ENV}`;
const RULES_PATH = `${ENV_PATH}/deployment-branch-policies?per_page=100`;
// Values that must never reach the public run log.
const LOGIN = 'reviewer-login-never-printed';
const REVIEWER_ID = 987654321;
const NODE_ID = 'NODE-ID-NEVER-PRINTED';

type Json = Record<string, unknown>;

const reviewer = (login = LOGIN) => ({
  type: 'User',
  reviewer: { login, id: REVIEWER_ID },
});
const reviewersRule = (n = 1): Json => ({
  id: 11,
  node_id: NODE_ID,
  type: 'required_reviewers',
  prevent_self_review: false,
  reviewers: Array.from({ length: n }, (_, i) => reviewer(i === 0 ? LOGIN : `${LOGIN}-${i}`)),
});
const passingEnv = (): Json => ({
  id: 1,
  node_id: NODE_ID,
  name: ENV,
  can_admins_bypass: false,
  protection_rules: [reviewersRule()],
  deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
});
const rules = (...list: Json[]): Json => ({ total_count: list.length, branch_policies: list });
const rule = (name: string, type?: string): Json => ({
  id: 21,
  node_id: NODE_ID,
  name,
  ...(type === undefined ? {} : { type }),
});

const encode = (path: string): string =>
  path.replace(/\//g, '__').replace(/\?/g, '_Q_').replace(/&/g, '_A_').replace(/=/g, '_E_');

interface World {
  env?: Json | string | null;
  rules?: Json | string | null;
  // A path fragment whose read fails with this gh error text (exit 1).
  failOn?: { match: string; message: string };
  vars?: Record<string, string | undefined>;
}

const world = (over: Partial<World> = {}): World => ({
  env: passingEnv(),
  rules: rules(rule('main', 'branch')),
  ...over,
});

function exec(w: World) {
  const dir = mkdtempSync(join(tmpdir(), 'seg-gh-'));
  const bin = mkdtempSync(join(tmpdir(), 'seg-bin-'));
  try {
    const put = (path: string, body: Json | string | null | undefined) => {
      if (body === null || body === undefined) return; // no file: the fake answers HTTP 404
      writeFileSync(
        join(dir, encode(path)),
        typeof body === 'string' ? body : JSON.stringify(body),
      );
    };
    put(ENV_PATH, w.env);
    put(RULES_PATH, w.rules);
    const fail = w.failOn
      ? `if [[ "\${2:-}" == *'${w.failOn.match}'* ]]; then echo "$2" >> "\${FAKE_GH_DIR}/.calls"; echo '${w.failOn.message}' >&2; exit 1; fi\n`
      : '';
    writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash\n${fail}exec bash "${FAKE_GH}" "$@"\n`);
    chmodSync(join(bin, 'gh'), 0o755);
    const vars: Record<string, string | undefined> = {
      GH_REPO: REPO,
      REQUIRED_ENVIRONMENT: ENV,
      ...w.vars,
    };
    const env: Record<string, string> = {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HOME: process.env.HOME ?? '/tmp',
      FAKE_GH_DIR: dir,
    };
    for (const [k, v] of Object.entries(vars)) if (v !== undefined) env[k] = v;
    const res = spawnSync('bash', [GUARD], { encoding: 'utf8', env });
    const callsFile = join(dir, '.calls');
    const calls = existsSync(callsFile)
      ? readFileSync(callsFile, 'utf8').split('\n').filter(Boolean)
      : [];
    return { code: res.status, out: `${res.stdout}\n${res.stderr}`, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
}

const OK_LINE = (n: number) =>
  `secrets-environment-guard: OK environment ${ENV} has ${n} required reviewer(s), admin bypass off and deployments from main only; the next job waits for a reviewer's approval`;
const refusal = (check: string) =>
  `::error::secrets-environment-guard: environment '${ENV}' is not ready to run production jobs (${check}: `;
const FIX =
  'so no job ran in it and no secret was read. Fix: set it up as docs/delivery-controls.md section 2.2 says, then dispatch again.';

const expectNothingLeaked = (out: string) => {
  expect(out).not.toContain(LOGIN);
  expect(out).not.toContain(String(REVIEWER_ID));
  expect(out).not.toContain(NODE_ID);
};

const env = (over: Json) => ({ ...passingEnv(), ...over });
const without = (key: string): Json => {
  const e = passingEnv();
  delete e[key];
  return e;
};

const REFUSED: [string, Partial<World>, string, RegExp?][] = [
  ['G1 environment answers 404', { env: null }, 'environment read', /HTTP 404/],
  [
    'G2 gh fails on the environment read',
    { failOn: { match: '/environments/production-secrets', message: 'gh: HTTP 502: Bad Gateway' } },
    'environment read',
    /HTTP 502/,
  ],
  ['G2 environment body is not JSON', { env: '<html>not json</html>' }, 'environment read'],
  ['G2 environment body is a JSON array', { env: '[]' }, 'environment read'],
  ['G3 the environment name differs', { env: env({ name: 'production' }) }, 'name'],
  ['G4 no protection_rules', { env: without('protection_rules') }, 'required reviewers'],
  ['G4 empty protection_rules', { env: env({ protection_rules: [] }) }, 'required reviewers'],
  [
    'G4 a required_reviewers rule with 0 reviewers',
    { env: env({ protection_rules: [reviewersRule(0)] }) },
    'required reviewers',
  ],
  [
    'G4 only a wait_timer rule',
    { env: env({ protection_rules: [{ id: 3, type: 'wait_timer', wait_timer: 5 }] }) },
    'required reviewers',
  ],
  [
    'G4 reviewers is not a list',
    { env: env({ protection_rules: [{ id: 3, type: 'required_reviewers', reviewers: 3 }] }) },
    'required reviewers',
  ],
  [
    'G5 one reviewer with admin bypass on',
    { env: env({ can_admins_bypass: true }) },
    'admin bypass',
  ],
  ['G6 can_admins_bypass null', { env: env({ can_admins_bypass: null }) }, 'admin bypass'],
  ['G6 can_admins_bypass missing', { env: without('can_admins_bypass') }, 'admin bypass'],
  ['G6 can_admins_bypass "false"', { env: env({ can_admins_bypass: 'false' }) }, 'admin bypass'],
  ['G6 can_admins_bypass 0', { env: env({ can_admins_bypass: 0 }) }, 'admin bypass'],
  [
    'G7 deployment_branch_policy null (any branch)',
    { env: env({ deployment_branch_policy: null }) },
    'deployment branches',
  ],
  [
    'G8 protected branches, not selected branches',
    {
      env: env({
        deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
      }),
    },
    'deployment branches',
  ],
  [
    'G8 custom_branch_policies missing',
    { env: env({ deployment_branch_policy: { protected_branches: false } }) },
    'deployment branches',
  ],
  [
    'G11 two rules: main and release',
    { rules: rules(rule('main', 'branch'), rule('release', 'branch')) },
    'branch rules',
  ],
  ['G11 no rule', { rules: rules() }, 'branch rules'],
  ['G12 rule "main" of type tag', { rules: rules(rule('main', 'tag')) }, 'branch rules'],
  ['G12 pattern rule "*"', { rules: rules(rule('*', 'branch')) }, 'branch rules'],
  ['G12 pattern rule "ma*"', { rules: rules(rule('ma*', 'branch')) }, 'branch rules'],
  ['G12 rule "main" with no type', { rules: rules(rule('main')) }, 'branch rules'],
  [
    'G12 total_count disagrees with the list',
    { rules: { total_count: 2, branch_policies: [rule('main', 'branch')] } },
    'branch rules',
  ],
  [
    'G13 the branch rules read answers 403',
    {
      failOn: {
        match: 'deployment-branch-policies',
        message: 'gh: Resource not accessible by integration (HTTP 403)',
      },
    },
    'branch rules read',
    /HTTP 403/,
  ],
  ['G13 the branch rules read answers 404', { rules: null }, 'branch rules read', /HTTP 404/],
  ['G13 the branch rules body is not JSON', { rules: 'oops' }, 'branch rules read'],
];

describe('secrets-environment-guard.sh — refuses unless production-secrets is protected', () => {
  // A rest parameter keeps jest from reading a short row's missing needle as a done callback.
  it.each(REFUSED)('%s -> refused', (...row) => {
    const [, over, check, needle] = row;
    const r = exec(world(over));
    expect(r.code).toBe(1);
    expect(r.out).toContain(refusal(check));
    expect(r.out).toContain(FIX);
    if (needle) expect(r.out).toMatch(needle);
    expect(r.out).not.toMatch(/\bOK\b/);
    expectNothingLeaked(r.out);
  });

  it('G4 counts reviewers the way the release gate does: a 0-reviewer rule prints reviewers=0', () => {
    const r = exec(world({ env: env({ protection_rules: [reviewersRule(0)] }) }));
    expect(r.out).toContain(`${refusal('required reviewers')}reviewers=0)`);
  });

  it('G5 and G6 print booleans only', () => {
    expect(exec(world({ env: env({ can_admins_bypass: true }) })).out).toContain(
      `${refusal('admin bypass')}can_admins_bypass=true)`,
    );
    expect(exec(world({ env: env({ can_admins_bypass: 'false' }) })).out).toContain(
      `${refusal('admin bypass')}can_admins_bypass=other)`,
    );
  });
});

describe('secrets-environment-guard.sh — passes only a protected, main-only environment', () => {
  it('G9 one reviewer, bypass off, selected branches, one main branch rule -> OK line, exit 0 (the control)', () => {
    const r = exec(world());
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(OK_LINE(1));
    expectNothingLeaked(r.out);
    // Plain GET reads only (no gh flags), in order: the environment, then its branch rules.
    expect(r.calls).toEqual([ENV_PATH, RULES_PATH]);
  });

  it('G10 two reviewers in one rule -> OK with 2', () => {
    const r = exec(world({ env: env({ protection_rules: [reviewersRule(2)] }) }));
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(OK_LINE(2));
  });

  it('G10 two reviewer rules and a wait timer -> OK with 2', () => {
    const r = exec(
      world({
        env: env({
          protection_rules: [
            reviewersRule(1),
            { id: 4, type: 'wait_timer', wait_timer: 1 },
            reviewersRule(1),
          ],
        }),
      }),
    );
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(OK_LINE(2));
  });
});

describe('secrets-environment-guard.sh — inputs are checked before any GitHub read (G14)', () => {
  it.each([
    ['GH_REPO missing', { GH_REPO: undefined }],
    ['GH_REPO malformed', { GH_REPO: 'growth-project-backend' }],
    ['GH_REPO with a path', { GH_REPO: `${REPO}/environments` }],
    ['REQUIRED_ENVIRONMENT missing', { REQUIRED_ENVIRONMENT: undefined }],
    ['REQUIRED_ENVIRONMENT empty', { REQUIRED_ENVIRONMENT: '' }],
    ['REQUIRED_ENVIRONMENT with a slash', { REQUIRED_ENVIRONMENT: 'production/../x' }],
    ['REQUIRED_ENVIRONMENT with a space', { REQUIRED_ENVIRONMENT: 'production secrets' }],
  ])('G14 %s -> refused before any gh call', (_name, vars) => {
    const r = exec(world({ vars }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('::error::secrets-environment-guard: environment ');
    expect(r.out).toContain('(inputs: ');
    expect(r.out).not.toMatch(/\bOK\b/);
    expect(r.calls).toEqual([]);
  });
});

describe('secrets-environment-guard.sh — the public log stays value-free', () => {
  const text = (() => {
    try {
      return readFileSync(GUARD, 'utf8');
    } catch {
      return '';
    }
  })();

  it('exists, never turns on xtrace and calls gh api with a path only', () => {
    expect(text).toMatch(/^set -Eeuo pipefail$/m);
    expect(text).not.toMatch(/^\s*set\s+-[a-zA-Z]*x/m);
    expect(text).not.toMatch(/set -o xtrace/);
    const calls = text.match(/^[^#\n]*gh api [^\n]*/gm) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c).toMatch(/gh api "\$path" 2>/);
  });

  it('never says the deploy-gate sentences gate-docs.spec.ts sweeps for', () => {
    expect(text).not.toMatch(/lacks\s+a\s+required\s+reviewer/i);
    expect(text).not.toMatch(/environment\s+reviewer\s+must\s+approve/i);
  });
});
