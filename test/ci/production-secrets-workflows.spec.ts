// PRODUCTION-SECRETS-ENV-BE (owner decision ALM-D11 op 1): the operator workflows that write
// production secrets, database URLs and launch flags, or open a shell on a production machine,
// run their one real job in the `production-secrets` environment (the owner approves each run),
// behind a first job that runs scripts/ci/secrets-environment-guard.sh. Code deploys stay on
// `production` (fly-deploy.yml, automatic after its evidence gate: #ALM-E7, ALM-D7 op 2).

import { readdirSync, readFileSync } from 'fs';
import { load as parseYaml } from 'js-yaml';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const WF_DIR = join(ROOT, '.github', 'workflows');
const read = (file: string): string => readFileSync(join(WF_DIR, file), 'utf8');

type Step = { name?: string; uses?: string; run?: string; with?: unknown; env?: unknown };
type Job = {
  environment?: string | { name?: string };
  needs?: string | string[];
  if?: string;
  steps?: Step[];
  [key: string]: unknown;
};
type Workflow = { permissions?: unknown; jobs: Record<string, Job> };
const load = (file: string): Workflow => parseYaml(read(file)) as Workflow;

const GUARD_ID = 'secrets-environment-guard';
const SECRETS_ENV = 'production-secrets';
const SUCCESS = "needs.secrets-environment-guard.result == 'success'";

// file -> its bound job id
const MOVED: Record<string, string> = {
  'fly-secrets-set.yml': 'fly-secrets-set',
  'fly-db-secrets-set.yml': 'fly-db-secrets-set',
  'fly-apple-signin-set.yml': 'set-secrets',
  'fly-launch-env-set.yml': 'set',
  'fly-recent-auth-set.yml': 'set-secrets',
  'fly-env-sync.yml': 'fly-env-sync',
  'fly-env-truth.yml': 'fly-env-truth',
};
// house-seed.yml is the eighth workflow of ALM-D11. It stays on `production` in this PR: moving
// it means re-formatting test/ci/house-seed-workflow.spec.ts, which this PR does not do (DECISIONS
// ALM-D13). The job HOUSE-SEED-ENV-BE moves it and deletes this entry.
const HELD: Record<string, string> = { 'house-seed.yml': 'house-seed' };

const GUARD_JOB = {
  name: 'Production-secrets environment guard',
  'runs-on': 'ubuntu-latest',
  'timeout-minutes': 5,
  permissions: { contents: 'read', actions: 'read' },
  steps: [
    {
      uses: 'actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10',
      with: { 'persist-credentials': false },
    },
    {
      name: 'Refuse unless production-secrets is protected',
      env: {
        GH_TOKEN: '${{ github.token }}',
        GH_REPO: '${{ github.repository }}',
        REQUIRED_ENVIRONMENT: SECRETS_ENV,
      },
      run: 'bash scripts/ci/secrets-environment-guard.sh',
    },
  ],
};

const envName = (j: Job): string | undefined =>
  typeof j.environment === 'string' ? j.environment : j.environment?.name;
const needsList = (j: Job): string[] =>
  j.needs === undefined ? [] : Array.isArray(j.needs) ? j.needs : [j.needs];

describe('the production secrets, flag and shell workflows wait for the owner in production-secrets (ALM-D11 op 1)', () => {
  it.each(Object.entries(MOVED))('%s: the guard job first, then %s behind it', (file, bound) => {
    const wf = load(file);
    expect(Object.keys(wf.jobs)).toEqual([GUARD_ID, bound]);

    // The guard: exactly this job, bound to no environment, no if, no continue-on-error, no secret.
    expect(wf.jobs[GUARD_ID]).toEqual(GUARD_JOB);
    expect(read(file)).toContain(
      '- uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3',
    );

    // The bound job: in production-secrets, the same name the guard checks, only after it passes.
    const job = wf.jobs[bound];
    expect(job.environment).toBe(SECRETS_ENV);
    expect(job.environment).toBe(
      (wf.jobs[GUARD_ID].steps?.[1].env as Record<string, string>).REQUIRED_ENVIRONMENT,
    );
    expect(job.needs).toBe(GUARD_ID);
    expect(job.if).toBe(SUCCESS);

    expect(wf.permissions).toEqual({ contents: 'read' });
    expect(read(file)).not.toContain('secrets.GITHUB_TOKEN');
  });
});

describe('class: who can reach production credentials without the owner (every workflow file)', () => {
  const files = readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f));
  const jobs = files.flatMap((file) =>
    Object.entries(load(file).jobs ?? {}).map(([id, job]) => ({ file, id, job })),
  );
  const key = (x: { file: string; id: string }) => `${x.file}#${x.id}`;

  it('only Fly Deploy (and the held house-seed) bind to production', () => {
    const bound = jobs.filter((x) => envName(x.job) === 'production').map(key);
    expect(bound.sort()).toEqual(
      ['fly-deploy.yml#deploy', ...Object.entries(HELD).map(([f, id]) => `${f}#${id}`)].sort(),
    );
  });

  it('every job in production-secrets needs the guard job of its own file and runs only on its success', () => {
    const inSecrets = jobs.filter((x) => envName(x.job) === SECRETS_ENV);
    expect(inSecrets.map(key).sort()).toEqual(
      Object.entries(MOVED)
        .map(([f, id]) => `${f}#${id}`)
        .sort(),
    );
    for (const x of inSecrets) {
      expect(needsList(x.job)).toContain(GUARD_ID);
      expect(x.job.if ?? '').toContain(SUCCESS);
      expect(load(x.file).jobs[GUARD_ID]).toEqual(GUARD_JOB);
    }
  });

  it('every job that reads a secret the eight read is Fly Deploy, Fly Secrets List, held, or behind the guard', () => {
    // The names the eight workflows read, from their own text.
    const eight = [...Object.keys(MOVED), ...Object.keys(HELD)];
    const names = new Set(
      eight.flatMap((f) => [...read(f).matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1])),
    );
    expect(names.size).toBe(48);
    const readers = jobs.filter((x) =>
      [...JSON.stringify(x.job).matchAll(/secrets\.([A-Z0-9_]+)/g)].some((m) => names.has(m[1])),
    );
    const allowed = new Set([
      'fly-deploy.yml#deploy', // FLY_API_TOKEN and SENTRY_DSN: the code deploy, automatic (ALM-D7 op 2)
      'fly-secrets-list.yml#list', // FLY_API_TOKEN: names and digests only, no environment (Found, not fixed)
      ...Object.entries(HELD).map(([f, id]) => `${f}#${id}`),
    ]);
    for (const x of readers) {
      if (allowed.has(key(x))) continue;
      expect([key(x), envName(x.job)]).toEqual([key(x), SECRETS_ENV]);
      expect(needsList(x.job)).toContain(GUARD_ID);
      expect(x.job.if ?? '').toContain(SUCCESS);
    }
    expect(readers.map(key).sort()).toEqual(
      [...allowed, ...Object.entries(MOVED).map(([f, id]) => `${f}#${id}`)].sort(),
    );
  });

  it('no guard job reads a secret, binds an environment or touches flyctl', () => {
    for (const x of jobs.filter((j) => j.id === GUARD_ID)) {
      expect(JSON.stringify(x.job)).not.toMatch(/secrets\.|flyctl|FLY_API_TOKEN/);
      expect(x.job.environment).toBeUndefined();
    }
  });
});
