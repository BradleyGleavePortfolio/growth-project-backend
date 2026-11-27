// Fail-closed behaviour of scripts/ci/release-evidence-gate.sh, driven through
// a fake `gh` (test/ci/fixtures/fake-gh.sh) that serves JSON fixtures per API
// path. Each negative case mutates exactly one thing in an otherwise passing
// world, so a regression that loosens one rule is caught by one named test.

import { execFileSync, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const GATE = join(ROOT, 'scripts', 'ci', 'release-evidence-gate.sh');
const FAKE_GH = join(__dirname, 'fixtures', 'fake-gh.sh');

const REPO = 'BradleyGleavePortfolio/growth-project-backend';
const FORK = 'someone-else/growth-project-backend';
const SHA = 'c23b9d9f3fcc106b92c061ceb7d04d7ec53038d7';
const OTHER_SHA = '5076a07a1e54b14e3db84d3aa128fb0bb44542d7';

const CI = '.github/workflows/ci.yml';
const CODEQL = '.github/workflows/codeql.yml';
const SBOM = '.github/workflows/sbom.yml';
const CI_JOBS = ['build-and-test', 'rls-floor-guard', 'rls-live-tests', 'mwb-3-live-tests'];
const CODEQL_JOB = 'CodeQL JS/TS (javascript-typescript)';
const SBOM_JOB = 'build-sbom';
const DEP = '.github/workflows/dependency-audit.yml';
const DEP_JOB = 'npm audit (high+critical, whole graph)';

type Json = Record<string, unknown>;

interface RunOpts {
  id: number;
  path: string;
  runNumber?: number;
  headSha?: string;
  repo?: string;
  headRepo?: string;
  event?: string;
  branch?: string;
  status?: string;
  conclusion?: string | null;
}

const run = (o: RunOpts): Json => ({
  id: o.id,
  run_number: o.runNumber ?? o.id,
  path: o.path,
  head_sha: o.headSha ?? SHA,
  head_branch: o.branch ?? 'main',
  event: o.event ?? 'push',
  status: o.status ?? 'completed',
  conclusion: o.conclusion === undefined ? 'success' : o.conclusion,
  html_url: `https://github.com/${REPO}/actions/runs/${o.id}`,
  repository: { full_name: o.repo ?? REPO },
  head_repository: { full_name: o.headRepo ?? REPO },
});

const jobs = (names: string[], overrides: Record<string, Partial<{ status: string; conclusion: string | null }>> = {}): Json => ({
  total_count: names.length,
  jobs: names.map((name) => ({
    name,
    status: overrides[name]?.status ?? 'completed',
    conclusion: overrides[name] && 'conclusion' in overrides[name] ? overrides[name].conclusion : 'success',
  })),
});

const ENV_PATH = `repos/${REPO}/environments/production`;
const protectedEnv = (over: Json = {}): Json => ({
  name: 'production',
  can_admins_bypass: false,
  protection_rules: [{ id: 1, type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { login: 'BradleyGleave' } }] }],
  deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  ...over,
});

const encode = (path: string): string =>
  path.replace(/\//g, '__').replace(/\?/g, '_Q_').replace(/&/g, '_A_').replace(/=/g, '_E_');

class World {
  readonly dir: string;
  readonly out: string;
  private readonly files = new Map<string, string | Buffer>();

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), 'gate-gh-'));
    this.out = mkdtempSync(join(tmpdir(), 'gate-out-'));
  }

  api(path: string, body: Json | Json[] | Buffer): this {
    this.files.set(encode(path), Buffer.isBuffer(body) ? body : JSON.stringify(body));
    return this;
  }

  remove(path: string): this {
    this.files.delete(encode(path));
    return this;
  }

  // A fully passing world for SHA.
  static passing(): World {
    const w = new World();
    w.api(`repos/${REPO}/actions/runs?head_sha=${SHA}&per_page=100`, {
      workflow_runs: [run({ id: 11, path: CI }), run({ id: 12, path: CODEQL }), run({ id: 13, path: SBOM }), run({ id: 14, path: DEP })],
    });
    w.api(`repos/${REPO}/actions/runs/11/jobs?per_page=100`, jobs(CI_JOBS));
    w.api(`repos/${REPO}/actions/runs/12/jobs?per_page=100`, jobs([CODEQL_JOB]));
    w.api(`repos/${REPO}/actions/runs/13/jobs?per_page=100`, jobs([SBOM_JOB]));
    w.api(`repos/${REPO}/actions/runs/14/jobs?per_page=100`, jobs([DEP_JOB]));
    w.api(`repos/${REPO}/code-scanning/analyses?ref=refs/heads/main&per_page=100`, [
      { id: 900, commit_sha: SHA, created_at: '2026-09-20T00:00:00Z', tool: { name: 'CodeQL' }, url: 'https://api.github.com/x', rules_count: 42, results_count: 0, error: '' },
    ]);
    w.api(`repos/${REPO}/actions/runs/13/artifacts?per_page=100`, {
      artifacts: [{ id: 700, name: `sbom-cyclonedx-${SHA}`, expired: false }],
    });
    w.api(`repos/${REPO}/actions/artifacts/700/zip`, sbomZip(PROD_SBOM));
    w.api(ENV_PATH, protectedEnv());
    return w;
  }

  runsList(runs: Json[]): this {
    return this.api(`repos/${REPO}/actions/runs?head_sha=${SHA}&per_page=100`, { workflow_runs: runs });
  }

  exec(env: Record<string, string> = {}) {
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir);
    for (const [k, v] of this.files) writeFileSync(join(this.dir, k), v);
    const bin = mkdtempSync(join(tmpdir(), 'gate-bin-'));
    writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash\nexec bash "${FAKE_GH}" "$@"\n`);
    chmodSync(join(bin, 'gh'), 0o755);
    const res = spawnSync('bash', [GATE], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HOME: process.env.HOME ?? '/tmp',
        FAKE_GH_DIR: this.dir,
        GH_REPO: REPO,
        RELEASE_SHA: SHA,
        DISPATCH_SHA: SHA,
        OUT_DIR: this.out,
        LOCKFILE,
        ...env,
      },
    });
    return { code: res.status, out: `${res.stdout}\n${res.stderr}` };
  }
}

// Production closure consistent with fixtures/gate-lockfile.json.
const PROD_SBOM: Json = {
  bomFormat: 'CycloneDX',
  components: [
    { name: '@nestjs/core', version: '11.0.0' },
    { name: '@prisma/client', version: '6.19.3' },
    { name: 'prisma', version: '6.19.3' },
    { name: 'source-map', version: '0.7.0' },
  ],
};
const LOCKFILE = join(__dirname, 'fixtures', 'gate-lockfile.json');

function sbomZip(doc: Json, opts: { sidecar?: 'match' | 'mismatch' | 'absent' } = {}): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'sbom-zip-'));
  const body = JSON.stringify(doc);
  writeFileSync(join(dir, 'sbom.cdx.json'), body);
  const files = ['sbom.cdx.json'];
  const mode = opts.sidecar ?? 'match';
  if (mode !== 'absent') {
    const sha = mode === 'match' ? createHash('sha256').update(body).digest('hex') : '0'.repeat(64);
    writeFileSync(join(dir, 'sbom.cdx.json.sha256'), `${sha}  sbom.cdx.json\n`);
    files.push('sbom.cdx.json.sha256');
  }
  execFileSync('zip', ['-q', 'sbom.zip', ...files], { cwd: dir });
  return readFileSync(join(dir, 'sbom.zip'));
}

const expectFail = (r: { code: number | null; out: string }, needle: RegExp) => {
  expect(r.code).not.toBe(0);
  expect(r.out).toMatch(needle);
};

describe('release-evidence-gate.sh — passing world', () => {
  it('passes and writes a manifest naming every run, the analysis and the SBOM sha256', () => {
    const w = World.passing();
    const r = w.exec();
    expect(r.out).toContain('PASS');
    expect(r.code).toBe(0);
    const manifest = JSON.parse(readFileSync(join(w.out, `release-evidence-${SHA}.json`), 'utf8'));
    expect(manifest.release_sha).toBe(SHA);
    expect(manifest.required_runs.map((x: Json) => x.path).sort()).toEqual([CI, CODEQL, SBOM, DEP].sort());
    expect(manifest.codeql_analysis.commit_sha).toBe(SHA);
    expect(manifest.sbom.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.sbom.components).toBe(4);
    expect(manifest.sbom.scope).toMatch(/npm production closure/);
    expect(manifest.codeql_analysis.rules_count).toBe(42);
    expect(manifest.image).toBeNull();
    expect(manifest.environment).toBe('production');
  });

  it('newest run wins: an older failure superseded by a newer success passes', () => {
    const w = World.passing().runsList([
      run({ id: 10, runNumber: 10, path: CI, conclusion: 'failure' }),
      run({ id: 11, runNumber: 11, path: CI }),
      run({ id: 12, path: CODEQL }),
      run({ id: 13, path: SBOM }), run({ id: 14, path: DEP }),
    ]);
    expect(w.exec().code).toBe(0);
  });
});

describe('release-evidence-gate.sh — exact head binding', () => {
  it('rejects a short / non-hex sha', () => {
    expectFail(World.passing().exec({ RELEASE_SHA: 'c23b9d9', DISPATCH_SHA: 'c23b9d9' }), /40-hex/);
  });
  it('rejects RELEASE_SHA != DISPATCH_SHA (push landed after authorization)', () => {
    expectFail(World.passing().exec({ DISPATCH_SHA: OTHER_SHA }), /refusing to deploy a commit other than the exact head/);
  });
});

describe('release-evidence-gate.sh — required run negatives (one mutation each)', () => {
  it('missing CI run for the sha fails (absence is not success)', () => {
    const w = World.passing().runsList([run({ id: 12, path: CODEQL }), run({ id: 13, path: SBOM }), run({ id: 14, path: DEP })]);
    expectFail(w.exec(), /no trusted run of \.github\/workflows\/ci\.yml/);
  });

  it('stale run on a different sha does not count', () => {
    const w = World.passing().runsList([
      run({ id: 11, path: CI, headSha: OTHER_SHA }),
      run({ id: 12, path: CODEQL }),
      run({ id: 13, path: SBOM }), run({ id: 14, path: DEP }),
    ]);
    expectFail(w.exec(), /no trusted run of \.github\/workflows\/ci\.yml/);
  });

  it('newest run failed even though an older run succeeded', () => {
    const w = World.passing().runsList([
      run({ id: 11, runNumber: 11, path: CI }),
      run({ id: 14, runNumber: 14, path: CI, conclusion: 'failure' }),
      run({ id: 12, path: CODEQL }),
      run({ id: 13, path: SBOM }), run({ id: 14, path: DEP }),
    ]);
    expectFail(w.exec(), /run #14 .* concluded 'failure'/);
  });

  it('in-progress newest run fails', () => {
    const w = World.passing().runsList([
      run({ id: 11, runNumber: 11, path: CI }),
      run({ id: 15, runNumber: 15, path: CI, status: 'in_progress', conclusion: null }),
      run({ id: 12, path: CODEQL }),
      run({ id: 13, path: SBOM }), run({ id: 14, path: DEP }),
    ]);
    expectFail(w.exec(), /is 'in_progress', not completed/);
  });

  it('cancelled / skipped run conclusions fail', () => {
    for (const conclusion of ['cancelled', 'skipped', 'neutral', 'timed_out']) {
      const w = World.passing().runsList([
        run({ id: 11, path: CI, conclusion }),
        run({ id: 12, path: CODEQL }),
        run({ id: 13, path: SBOM }), run({ id: 14, path: DEP }),
      ]);
      expectFail(w.exec(), new RegExp(`concluded '${conclusion}'`));
    }
  });

  it('run from a fork head repository is not trusted', () => {
    const w = World.passing().runsList([
      run({ id: 11, path: CI, headRepo: FORK }),
      run({ id: 12, path: CODEQL }),
      run({ id: 13, path: SBOM }), run({ id: 14, path: DEP }),
    ]);
    expectFail(w.exec(), /no trusted run of \.github\/workflows\/ci\.yml/);
  });

  it('pull_request-event run is not trusted (workflow file may be the PR copy)', () => {
    const w = World.passing().runsList([
      run({ id: 11, path: CI, event: 'pull_request' }),
      run({ id: 12, path: CODEQL }),
      run({ id: 13, path: SBOM }), run({ id: 14, path: DEP }),
    ]);
    expectFail(w.exec(), /no trusted run of \.github\/workflows\/ci\.yml/);
  });

  it('run on a non-main branch is not trusted', () => {
    const w = World.passing().runsList([
      run({ id: 11, path: CI, branch: 'release/x' }),
      run({ id: 12, path: CODEQL }),
      run({ id: 13, path: SBOM }), run({ id: 14, path: DEP }),
    ]);
    expectFail(w.exec(), /no trusted run of \.github\/workflows\/ci\.yml/);
  });

  it('a same-name workflow at a different path is not the required workflow', () => {
    const w = World.passing().runsList([
      run({ id: 11, path: '.github/workflows/ci-copy.yml' }),
      run({ id: 12, path: CODEQL }),
      run({ id: 13, path: SBOM }), run({ id: 14, path: DEP }),
    ]);
    expectFail(w.exec(), /no trusted run of \.github\/workflows\/ci\.yml/);
  });

  it('a required job that was skipped inside a green run fails', () => {
    const w = World.passing().api(
      `repos/${REPO}/actions/runs/11/jobs?per_page=100`,
      jobs(CI_JOBS, { 'rls-live-tests': { conclusion: 'skipped' } }),
    );
    expectFail(w.exec(), /job 'rls-live-tests' .* is 'completed\/skipped'/);
  });

  it('a required job missing from the run fails', () => {
    const w = World.passing().api(`repos/${REPO}/actions/runs/11/jobs?per_page=100`, jobs(CI_JOBS.slice(0, 3)));
    expectFail(w.exec(), /job 'mwb-3-live-tests' .* is 'missing'/);
  });

  it('duplicate job names: a failed duplicate behind a green first entry fails (not resolved by .[0])', () => {
    const dup = jobs(CI_JOBS);
    (dup.jobs as Json[]).push({ name: 'rls-live-tests', status: 'completed', conclusion: 'failure' });
    const w = World.passing().api(`repos/${REPO}/actions/runs/11/jobs?per_page=100`, dup);
    expectFail(w.exec(), /job 'rls-live-tests' .* is 'completed\/success\|completed\/failure'/);
  });

  it('duplicate job names: all entries green passes', () => {
    const dup = jobs(CI_JOBS);
    (dup.jobs as Json[]).push({ name: 'rls-live-tests', status: 'completed', conclusion: 'success' });
    const w = World.passing().api(`repos/${REPO}/actions/runs/11/jobs?per_page=100`, dup);
    expect(w.exec().code).toBe(0);
  });

  it('a candidate-weakened required list (SBOM dropped) is refused', () => {
    const w = World.passing();
    expectFail(w.exec({ REQUIRED_WORKFLOWS: `${CI}=build-and-test;${CODEQL}=${CODEQL_JOB}` }), /SBOM workflow .* is not in REQUIRED_WORKFLOWS/);
  });

  it('an empty required list is refused', () => {
    expectFail(World.passing().exec({ REQUIRED_WORKFLOWS: ';' }), /REQUIRED_WORKFLOWS is empty|malformed|SBOM workflow/);
  });
});

// Section 5 since the owner's decision ALM-D7 op 2 (2026-11-26, owner words
// #ALM-E7 "I auto approve all deploys from now on" and #ALM-E16): the
// environment must exist and must not let admins bypass its rules, but a
// required human reviewer is no longer demanded. The manifest records which
// rule let the deploy through.
const AUTO_APPROVED_LINE =
  'release-evidence-gate: OK environment production has no required reviewer: deploys are auto-approved by the owner (ALM-D7 op 2, owner words #ALM-E7 and #ALM-E16)';
const REVIEWED_LINE = 'release-evidence-gate: OK environment production has required reviewers and no admin bypass';
const OWNER_RULE = 'owner standing approval (ALM-D7 op 2)';
const REVIEWER_RULE = 'required human reviewer, no admin bypass';
const reviewer = (login: string): Json => ({ type: 'User', reviewer: { login } });
// The live production environment since 2026-11-26: no protection rule, admin bypass off.
const unreviewedEnv = (over: Json = {}): Json => protectedEnv({ protection_rules: [], ...over });

type EnvCase =
  | { name: string; env: Json | null; refused: RegExp }
  | { name: string; env: Json; line: string; reviewers: number; rule: string };

const ENV_CASES: EnvCase[] = [
  { name: 'environment missing (404) is refused', env: null, refused: /GitHub API read failed for repos\/.*environments\/production/ },
  { name: 'no protection rule, bypass off (live production) is accepted on the owner standing approval', env: unreviewedEnv(), line: AUTO_APPROVED_LINE, reviewers: 0, rule: OWNER_RULE },
  {
    name: 'required_reviewers rule with an empty reviewer list, bypass off is accepted on the owner standing approval',
    env: protectedEnv({ protection_rules: [{ id: 1, type: 'required_reviewers', reviewers: [] }] }),
    line: AUTO_APPROVED_LINE, reviewers: 0, rule: OWNER_RULE,
  },
  {
    name: 'only a wait_timer rule, bypass off is accepted on the owner standing approval',
    env: protectedEnv({ protection_rules: [{ id: 2, type: 'wait_timer', wait_timer: 30 }] }),
    line: AUTO_APPROVED_LINE, reviewers: 0, rule: OWNER_RULE,
  },
  { name: 'one reviewer, bypass off is accepted (unchanged)', env: protectedEnv(), line: REVIEWED_LINE, reviewers: 1, rule: REVIEWER_RULE },
  {
    name: 'two reviewers, bypass off is accepted (unchanged)',
    env: protectedEnv({ protection_rules: [{ id: 1, type: 'required_reviewers', reviewers: [reviewer('a'), reviewer('b')] }] }),
    line: REVIEWED_LINE, reviewers: 2, rule: REVIEWER_RULE,
  },
  { name: 'one reviewer, bypass ON is still refused (a reviewer admins can skip)', env: protectedEnv({ can_admins_bypass: true }), refused: /reviewers=1 can_admins_bypass=true/ },
  { name: 'no reviewer, bypass ON is refused (bypass is still never allowed)', env: unreviewedEnv({ can_admins_bypass: true }), refused: /reviewers=0 can_admins_bypass=true/ },
  { name: 'one reviewer, bypass flag missing is refused (unknown is not off)', env: protectedEnv({ can_admins_bypass: undefined }), refused: /reviewers=1 can_admins_bypass=null/ },
  { name: 'no reviewer, bypass flag missing is refused (unknown is not off)', env: unreviewedEnv({ can_admins_bypass: undefined }), refused: /reviewers=0 can_admins_bypass=null/ },
];

describe('release-evidence-gate.sh — deployment environment (section 5, owner ALM-D7 op 2)', () => {
  it.each<EnvCase>(ENV_CASES)('$name', (c) => {
    const w = World.passing();
    if (c.env === null) w.remove(ENV_PATH);
    else w.api(ENV_PATH, c.env);
    const r = w.exec();
    if ('refused' in c) {
      expectFail(r, c.refused);
      expect(r.out).not.toContain('PASS');
      return;
    }
    expect(r.code).toBe(0);
    expect(r.out.split('\n')).toContain(c.line);
    const manifest = JSON.parse(readFileSync(join(w.out, `release-evidence-${SHA}.json`), 'utf8'));
    expect(manifest.environment).toBe('production');
    expect(manifest.required_reviewers).toBe(c.reviewers);
    expect(manifest.reviewer_rule).toBe(c.rule);
  });

  it('REQUIRED_ENVIRONMENT selects which environment is checked', () => {
    const w = World.passing().api(`repos/${REPO}/environments/staging`, protectedEnv({ name: 'staging' }));
    expect(w.exec({ REQUIRED_ENVIRONMENT: 'staging' }).code).toBe(0);
    expectFail(World.passing().exec({ REQUIRED_ENVIRONMENT: 'staging' }), /environments\/staging/);
  });
});

// The owner's standing approval replaces only the human reviewer. With the live
// production environment (no reviewer, bypass off), one failure from each
// evidence check (sections 1-4) is still refused before section 5 is reached.
interface EvidenceFailure {
  name: string;
  mutate: (w: World) => World;
  env?: Record<string, string>;
  refused: RegExp;
}

const ANALYSES_PATH = `repos/${REPO}/code-scanning/analyses?ref=refs/heads/main&per_page=100`;
const EVIDENCE_FAILURES: EvidenceFailure[] = [
  { name: 'release sha is not the dispatched head', mutate: (w) => w, env: { DISPATCH_SHA: OTHER_SHA }, refused: /refusing to deploy a commit other than the exact head/ },
  { name: 'no CI run for the sha', mutate: (w) => w.runsList([run({ id: 12, path: CODEQL }), run({ id: 13, path: SBOM }), run({ id: 14, path: DEP })]), refused: /no trusted run of \.github\/workflows\/ci\.yml/ },
  {
    name: 'newest CI run failed',
    mutate: (w) => w.runsList([run({ id: 11, path: CI, conclusion: 'failure' }), run({ id: 12, path: CODEQL }), run({ id: 13, path: SBOM }), run({ id: 14, path: DEP })]),
    refused: /concluded 'failure'/,
  },
  { name: 'a required CI job was skipped', mutate: (w) => w.api(`repos/${REPO}/actions/runs/11/jobs?per_page=100`, jobs(CI_JOBS, { 'rls-live-tests': { conclusion: 'skipped' } })), refused: /job 'rls-live-tests' .* is 'completed\/skipped'/ },
  { name: 'dependency audit failed', mutate: (w) => w.api(`repos/${REPO}/actions/runs/14/jobs?per_page=100`, jobs([DEP_JOB], { [DEP_JOB]: { conclusion: 'failure' } })), refused: /npm audit \(high\+critical, whole graph\)/ },
  { name: 'no CodeQL analysis for the sha', mutate: (w) => w.api(ANALYSES_PATH, []), refused: /no CodeQL code-scanning analysis recorded/ },
  {
    name: 'CodeQL analysis analysed nothing',
    mutate: (w) => w.api(ANALYSES_PATH, [{ id: 902, commit_sha: SHA, created_at: '2026-09-20T00:00:00Z', tool: { name: 'CodeQL' }, rules_count: 0, results_count: 0, error: '' }]),
    refused: /analysed nothing \(rules_count=0\)/,
  },
  { name: 'SBOM artifact missing', mutate: (w) => w.api(`repos/${REPO}/actions/runs/13/artifacts?per_page=100`, { artifacts: [] }), refused: /SBOM artifact 'sbom-cyclonedx-.*' missing or expired/ },
  {
    name: 'SBOM fails the production-closure proof',
    mutate: (w) => w.api(`repos/${REPO}/actions/artifacts/700/zip`, sbomZip({ ...PROD_SBOM, components: [...(PROD_SBOM.components as Json[]), { name: 'jest', version: '30.0.0' }] })),
    refused: /failed the production-closure proof/,
  },
  { name: 'SBOM sha256 sidecar mismatch', mutate: (w) => w.api(`repos/${REPO}/actions/artifacts/700/zip`, sbomZip(PROD_SBOM, { sidecar: 'mismatch' })), refused: /sidecar .* does not match/ },
];

describe('release-evidence-gate.sh — no required reviewer still refuses every evidence failure (ALM-D7 op 2)', () => {
  it('control: the live production environment with all evidence green passes', () => {
    const r = World.passing().api(ENV_PATH, unreviewedEnv()).exec();
    expect(r.code).toBe(0);
    expect(r.out).toContain(AUTO_APPROVED_LINE);
  });

  it.each<EvidenceFailure>(EVIDENCE_FAILURES)('$name is refused', (c) => {
    const r = c.mutate(World.passing().api(ENV_PATH, unreviewedEnv())).exec(c.env);
    expectFail(r, c.refused);
    expect(r.out).not.toContain('auto-approved');
    expect(r.out).not.toContain('PASS');
  });
});

describe('release-evidence-gate.sh — composed dependency-audit is a required input (S2-B8)', () => {
  it('fails when no dependency-audit run exists for the head sha', () => {
    const w = World.passing().runsList([run({ id: 11, path: CI }), run({ id: 12, path: CODEQL }), run({ id: 13, path: SBOM })]);
    expectFail(w.exec(), /dependency-audit\.yml/);
  });
  it('fails when the dependency-audit job concluded failure', () => {
    const w = World.passing().api(`repos/${REPO}/actions/runs/14/jobs?per_page=100`, jobs([DEP_JOB], { [DEP_JOB]: { conclusion: 'failure' } }));
    expectFail(w.exec(), /npm audit \(high\+critical, whole graph\)/);
  });
});

describe('release-evidence-gate.sh — CodeQL analysis and SBOM artifact negatives', () => {
  it('green CodeQL job but no uploaded analysis for the sha fails', () => {
    const w = World.passing().api(`repos/${REPO}/code-scanning/analyses?ref=refs/heads/main&per_page=100`, [
      { id: 901, commit_sha: OTHER_SHA, created_at: '2026-09-14T00:00:00Z', tool: { name: 'CodeQL' } },
    ]);
    expectFail(w.exec(), /no CodeQL code-scanning analysis recorded/);
  });

  it('analysis for the sha with rules_count 0 (analysed nothing) fails', () => {
    const w = World.passing().api(`repos/${REPO}/code-scanning/analyses?ref=refs/heads/main&per_page=100`, [
      { id: 902, commit_sha: SHA, created_at: '2026-09-20T00:00:00Z', tool: { name: 'CodeQL' }, rules_count: 0, results_count: 0, error: '' },
    ]);
    expectFail(w.exec(), /analysed nothing \(rules_count=0\)/);
  });

  it('analysis for the sha carrying an error string fails', () => {
    const w = World.passing().api(`repos/${REPO}/code-scanning/analyses?ref=refs/heads/main&per_page=100`, [
      { id: 903, commit_sha: SHA, created_at: '2026-09-20T00:00:00Z', tool: { name: 'CodeQL' }, rules_count: 42, results_count: 0, error: 'extraction failed' },
    ]);
    expectFail(w.exec(), /analysed nothing \(error=extraction failed\)/);
  });

  it('analysis object without rules_count at all fails (unknown is not success)', () => {
    const w = World.passing().api(`repos/${REPO}/code-scanning/analyses?ref=refs/heads/main&per_page=100`, [
      { id: 904, commit_sha: SHA, created_at: '2026-09-20T00:00:00Z', tool: { name: 'CodeQL' } },
    ]);
    expectFail(w.exec(), /rules_count=null/);
  });

  it('code-scanning API error (e.g. GHAS disabled → 403/404) fails instead of defaulting', () => {
    const w = World.passing().remove(`repos/${REPO}/code-scanning/analyses?ref=refs/heads/main&per_page=100`);
    expectFail(w.exec(), /GitHub API read failed for repos\/.*code-scanning/);
  });

  it('SBOM artifact missing fails', () => {
    const w = World.passing().api(`repos/${REPO}/actions/runs/13/artifacts?per_page=100`, { artifacts: [] });
    expectFail(w.exec(), /SBOM artifact 'sbom-cyclonedx-.*' missing or expired/);
  });

  it('SBOM artifact named for another sha fails', () => {
    const w = World.passing().api(`repos/${REPO}/actions/runs/13/artifacts?per_page=100`, {
      artifacts: [{ id: 701, name: `sbom-cyclonedx-${OTHER_SHA}`, expired: false }],
    });
    expectFail(w.exec(), /missing or expired/);
  });

  it('expired SBOM artifact fails', () => {
    const w = World.passing().api(`repos/${REPO}/actions/runs/13/artifacts?per_page=100`, {
      artifacts: [{ id: 700, name: `sbom-cyclonedx-${SHA}`, expired: true }],
    });
    expectFail(w.exec(), /missing or expired/);
  });

  it('SBOM with zero components fails', () => {
    const w = World.passing().api(`repos/${REPO}/actions/artifacts/700/zip`, sbomZip({ bomFormat: 'CycloneDX', components: [] }));
    expectFail(w.exec(), /failed the production-closure proof/);
  });

  it('SBOM whose closure proof fails (dev-only package present) fails at the gate, not only in sbom.yml', () => {
    const leaky = { ...PROD_SBOM, components: [...(PROD_SBOM.components as Json[]), { name: 'jest', version: '30.0.0' }] };
    const w = World.passing().api(`repos/${REPO}/actions/artifacts/700/zip`, sbomZip(leaky));
    expectFail(w.exec(), /failed the production-closure proof/);
  });

  it('SBOM missing a required runtime package (prisma CLI) fails at the gate', () => {
    const noPrisma = { ...PROD_SBOM, components: (PROD_SBOM.components as Json[]).filter((c) => c.name !== 'prisma') };
    const w = World.passing().api(`repos/${REPO}/actions/artifacts/700/zip`, sbomZip(noPrisma));
    expectFail(w.exec(), /failed the production-closure proof/);
  });

  it('sha256 sidecar mismatch fails', () => {
    const w = World.passing().api(`repos/${REPO}/actions/artifacts/700/zip`, sbomZip(PROD_SBOM, { sidecar: 'mismatch' }));
    expectFail(w.exec(), /sidecar .* does not match/);
  });

  it('sha256 sidecar absent fails', () => {
    const w = World.passing().api(`repos/${REPO}/actions/artifacts/700/zip`, sbomZip(PROD_SBOM, { sidecar: 'absent' }));
    expectFail(w.exec(), /does not contain sbom.cdx.json and sbom.cdx.json.sha256/);
  });

  it('lockfile of the release commit missing fails', () => {
    expectFail(World.passing().exec({ LOCKFILE: '/nonexistent/package-lock.json' }), /lockfile .* not found/);
  });

  it('SBOM download failure fails', () => {
    const w = World.passing().remove(`repos/${REPO}/actions/artifacts/700/zip`);
    expectFail(w.exec(), /could not download SBOM artifact/);
  });

  it('runs listing API error fails closed', () => {
    const w = World.passing().remove(`repos/${REPO}/actions/runs?head_sha=${SHA}&per_page=100`);
    expectFail(w.exec(), /GitHub API read failed/);
  });
});
