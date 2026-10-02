/**
 * S-ENVTRUTH / B-FLAGS-2 — structural invariants for the two operator env workflows:
 *   .github/workflows/fly-env-sync.yml   (plan / apply of .github/fly-env-desired-state.json)
 *   .github/workflows/fly-env-truth.yml  (read-only in-machine classifier)
 * Parses the YAML and checks the guards that a later edit could quietly drop.
 */

import { readFileSync } from 'fs';
import { load as parseYaml } from 'js-yaml';
import { join } from 'path';

import { ENV_RULES } from '../../src/common/env-validation';

const ROOT = join(__dirname, '..', '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

interface Step {
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
}
interface Job {
  environment?: string | { name: string };
  steps: Step[];
  permissions?: Record<string, string>;
}
interface Workflow {
  on: Record<
    string,
    { inputs?: Record<string, { default?: string | boolean; required?: boolean; type?: string }> }
  >;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

const PROVIDERS = ['FITBIT', 'GARMIN', 'OURA', 'POLAR', 'STRAVA', 'WAHOO', 'WHOOP', 'WITHINGS'];
const EXPECTED_ALLOWLIST = [
  'GOOGLE_CLIENT_IDS',
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'GOOGLE_OAUTH_REDIRECT_URI',
  'METRICS_AUTH_TOKEN',
  'DATA_EXPORT_DOWNLOAD_SECRET',
  'CONTRACT_PDF_URL_SECRET',
  'SCHEDULING_WEBHOOK_SECRET',
  'GARMIN_WEBHOOK_SALT',
  'WHOOP_WEBHOOK_SALT',
  ...PROVIDERS.flatMap((p) => [`${p}_CLIENT_ID`, `${p}_CLIENT_SECRET`]),
];
const REGISTERED = new Set(ENV_RULES.map((r) => r.name));

function loadWorkflow(file: string): { wf: Workflow; text: string; job: Job } {
  const text = read(file);
  const wf = parseYaml(text) as Workflow;
  const jobs = Object.values(wf.jobs);
  expect(jobs).toHaveLength(1);
  return { wf, text, job: jobs[0] };
}

const allRuns = (job: Job): string => job.steps.map((s) => s.run ?? '').join('\n');
const envName = (job: Job): string | undefined =>
  typeof job.environment === 'string' ? job.environment : job.environment?.name;

function expectAppAllowlist(job: Job): void {
  const guard = job.steps.find((s) => s.name === 'Validate Fly app target');
  expect(guard?.run).toMatch(/case "\$\{APP\}" in\s+backend-spring-lake-3890\) ;;/);
  expect(guard?.run).toMatch(/\*\)[\s\S]*exit 1/);
  // The allowlist step runs before any step that touches flyctl.
  const firstFly = job.steps.findIndex(
    (s) => /flyctl/.test(s.run ?? '') || /setup-flyctl/.test(s.uses ?? ''),
  );
  expect(job.steps.indexOf(guard!)).toBeLessThan(firstFly);
}

describe('fly-env-sync.yml (manifest-driven plan / apply; B-FLAGS-2)', () => {
  const { wf, text, job } = loadWorkflow('.github/workflows/fly-env-sync.yml');
  const stageStep = job.steps.find((s) => /flyctl secrets set/.test(s.run ?? ''))!;
  const manifest = JSON.parse(read('.github/fly-env-desired-state.json')) as {
    secrets: Record<string, string>;
  };

  it('is workflow_dispatch only, read-only token, production environment, one Fly lock', () => {
    expect(Object.keys(wf.on)).toEqual(['workflow_dispatch']);
    expect(wf.permissions).toEqual({ contents: 'read' });
    expect(envName(job)).toBe('production');
    expect(text).toMatch(/concurrency: fly-secrets-\$\{\{ inputs\.app \}\}/);
    expectAppAllowlist(job);
  });

  it('defaults to plan; apply needs confirm=SET; deploy_staged is opt-in and apply-only', () => {
    const inputs = wf.on.workflow_dispatch.inputs ?? {};
    expect(inputs.mode).toMatchObject({ type: 'choice', default: 'plan' });
    expect(inputs.deploy_staged).toMatchObject({ type: 'boolean', default: false });
    expect(inputs.confirm?.required).toBe(false);
    const confirm = job.steps.find((s) => s.name === 'Confirm operator intent');
    expect(confirm?.run).toMatch(/if \[ "\$\{CONFIRM\}" != "SET" \]/);
    const firstFly = job.steps.findIndex((s) => /setup-flyctl/.test(s.uses ?? ''));
    expect(job.steps.indexOf(confirm!)).toBeLessThan(firstFly);
    const writers = job.steps.filter((s) => /flyctl secrets (set|unset|deploy)/.test(s.run ?? ''));
    expect(writers.map((s) => s.if)).toEqual([
      "${{ inputs.mode == 'apply' }}",
      "${{ inputs.mode == 'apply' && inputs.deploy_staged }}",
    ]);
  });

  it('validates the manifest before setting up flyctl, and runs it without npm install', () => {
    const validate = job.steps.findIndex((s) =>
      /^Validate the desired-state manifest/.test(s.name ?? ''),
    );
    const setup = job.steps.findIndex((s) => /setup-flyctl/.test(s.uses ?? ''));
    expect(validate).toBeGreaterThan(-1);
    expect(validate).toBeLessThan(setup);
    expect(allRuns(job)).not.toMatch(/npm (ci|install)/);
  });

  it('stages with --stage only (no restart); flyctl secrets deploy appears once, behind deploy_staged', () => {
    const runs = allRuns(job);
    for (const line of runs.split('\n').filter((l) => /^\s*flyctl secrets (set|unset)/.test(l)))
      expect(line).toMatch(/flyctl secrets (set|unset) --stage /);
    expect(runs.match(/^\s*flyctl secrets deploy /gm)).toHaveLength(1);
  });

  it('every manifest secret maps to the same-named GitHub secret and is registered; Apple keys are never copied', () => {
    const env = stageStep.env ?? {};
    const names = Object.keys(env).filter((k) => k !== 'FLY_API_TOKEN' && k !== 'APP');
    expect(names.sort()).toEqual(Object.keys(manifest.secrets).sort());
    expect(names).toEqual(expect.arrayContaining(EXPECTED_ALLOWLIST));
    for (const n of names) {
      expect(env[n]).toBe(`\${{ secrets.${n} }}`);
      expect([n, REGISTERED.has(n)]).toEqual([n, true]);
    }
    expect(text).not.toMatch(/APPLE_SIGNIN_PRIVATE_KEY|APPLE_SIGNIN_KEY_ID/);
  });

  it('never echoes a value: no set -x, no echo/printf of a secret variable, args or indirect expansion', () => {
    const runs = allRuns(job);
    expect(runs).not.toMatch(/set -x/);
    for (const step of job.steps) expect(step.run ?? '').not.toMatch(/^\s*set -o xtrace/m);
    const printing = runs.split('\n').filter((l) => /^\s*(echo|printf|cat)\b/.test(l));
    for (const line of printing) {
      expect(line).not.toMatch(/\$\{!name|\$\{args|\$args\b|\$\{?FLY_API_TOKEN/);
      for (const n of Object.keys(manifest.secrets))
        expect(line).not.toMatch(new RegExp(`\\$\\{?${n}\\b`));
    }
    expect(stageStep.run).toMatch(/flyctl secrets set --stage[^\n]*> \/dev\/null/);
    expect(stageStep.run).toMatch(/set \+x/);
  });

  it('B-633-1: every listing is the structured --json projection (names + status only); no table parsing', () => {
    const runs = allRuns(job);
    expect(runs).toMatch(
      /flyctl secrets list -a "\$\{APP\}" --json 2> fly-list-stderr\.txt \| jq -r "\$\{filter\}" > "\$1" 2> jq-stderr\.txt/,
    );
    expect(runs).not.toMatch(/\bawk\b/);
    expect(runs).not.toMatch(/\.digest|\.Digest/);
    expect(runs).not.toMatch(/flyctl secrets list(?![^\n]*--json)/);
  });

  it('B-624-3: no flyctl output reaches the log; stderr is only classified with grep -q and removed by an EXIT trap', () => {
    // Behaviour (hostile values, every failure path) is proven in
    // fly-env-sync-behavior.spec.ts; this pins the shape.
    const flySteps = job.steps.filter((s) => /^\s*flyctl /m.test(s.run ?? ''));
    expect(flySteps.map((s) => s.name)).toEqual([
      'Plan (names, status and actions only)',
      'Stage the planned changes (apply mode only; no restart)',
      'Verify Fly matches the manifest (apply mode only)',
      'Apply staged changes now (apply mode with deploy_staged=true)',
    ]);
    const blockOf = (s: Step, tag: string) =>
      new RegExp(`# BEGIN ${tag}[\\s\\S]*?# END ${tag}\\n`).exec(s.run ?? '')?.[0];
    const classBlocks = flySteps.map((s) => blockOf(s, 'fly_error_class'));
    for (const b of classBlocks) expect(b).toEqual(expect.stringContaining('fly_error_class() {'));
    expect(new Set(classBlocks).size).toBe(1);
    const readers = flySteps.filter((s) => /fly_list_state /.test(s.run ?? ''));
    expect(readers).toHaveLength(3);
    const helperBlocks = readers.map((s) => blockOf(s, 'fly_helpers'));
    for (const b of helperBlocks) expect(b).toEqual(expect.stringContaining('fly_list_state() {'));
    expect(new Set(helperBlocks).size).toBe(1);
    const code = classBlocks[0]!
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    expect(code.match(/grep -[A-Za-z]+/g)).toEqual(Array(5).fill('grep -qiE'));
    expect(code).not.toMatch(/\b(cat|sed|head|tail|awk|cut|tr|printf)\b [^|\n]*"\$1"/);
    for (const s of flySteps) {
      const run = s.run ?? '';
      expect(run).not.toMatch(/\bsed\b/);
      expect(run).toMatch(/^\s*set \+x$/m);
      for (const line of run.split('\n').filter((l) => /^\s*flyctl /.test(l)))
        expect(line).toMatch(
          / (> \/dev\/null 2> fly-[a-z]+-stderr\.txt|--json 2> fly-list-stderr\.txt \| jq -r "\$\{filter\}" > "\$1" 2> jq-stderr\.txt|-C "\$\(cat compare\.cmd\)" > ssh-stdout\.txt 2> fly-ssh-stderr\.txt)$/,
        );
      for (const line of run.split('\n').filter((l) => /stderr\.txt/.test(l) && !/^\s*#/.test(l)))
        expect([
          line,
          [
            /^\s*flyctl .* 2> fly-[a-z]+-stderr\.txt( \| jq -r "\$\{filter\}" > "\$1" 2> jq-stderr\.txt)?$/,
            /^\s*trap 'rm -f [a-z. -]+' EXIT$/,
            /cls=\$\(fly_error_class fly-[a-z]+-stderr\.txt\)/,
            /^\s*code=\$\(grep -oE 'ENVSYNC_\[A-Z_\]\+' jq-stderr\.txt \| head -n 1 \|\| true\)$/,
            /^\s*rm -f ssh-stdout\.txt fly-ssh-stderr\.txt$/,
          ].some((re) => re.test(line)),
        ]).toEqual([line, true]);
      // Every stderr scratch file the step writes is removed by its EXIT trap.
      const written = [...run.matchAll(/2> ([a-z-]+\.txt)/g)].map((m) => m[1]);
      const trap = /trap 'rm -f ([^']+)' EXIT/.exec(run)?.[1].split(' ') ?? [];
      expect(trap).toEqual(expect.arrayContaining(written));
      expect(run.search(/^\s*trap '/m)).toBeGreaterThan(-1);
      expect(run.search(/^\s*trap '/m)).toBeLessThan(run.search(/^\s*(flyctl|fly_list_state) /m));
    }
  });

  it('scratch files live under RUNNER_TEMP and are removed by an always() step', () => {
    const last = job.steps[job.steps.length - 1];
    expect(last).toMatchObject({
      if: '${{ always() }}',
      run: 'rm -rf "${RUNNER_TEMP}/fly-env-sync"',
    });
    for (const s of job.steps.filter((x) => /fly_list_state |flyctl secrets/.test(x.run ?? '')))
      expect(s.run).toMatch(/^\s*cd "\$\{RUNNER_TEMP\}\/fly-env-sync"$/m);
  });

  it('pins every third-party action to a full commit sha; checkout does not persist credentials', () => {
    for (const s of job.steps.filter((x) => x.uses)) expect(s.uses).toMatch(/@[0-9a-f]{40}$/);
    expect(text).toMatch(/persist-credentials: false/);
  });
});

describe('fly-env-truth.yml (read-only)', () => {
  const { wf, text, job } = loadWorkflow('.github/workflows/fly-env-truth.yml');

  it('is workflow_dispatch only with a read-only token and the production environment', () => {
    expect(Object.keys(wf.on)).toEqual(['workflow_dispatch']);
    expect(wf.permissions).toEqual({ contents: 'read' });
    expect(envName(job)).toBe('production');
    expectAppAllowlist(job);
  });

  it('runs the classifier inline inside the machine via flyctl ssh console -C', () => {
    const runs = allRuns(job);
    expect(runs).toMatch(
      /fly-env-classifier\.js command src\/common\/env-validation\.ts > remote-cmd\.txt/,
    );
    expect(runs).toMatch(
      /flyctl ssh console -a "\$\{APP\}" "\$\{machine_args\[@\]\}" -C "\$\(cat remote-cmd\.txt\)"/,
    );
  });

  it('never writes to Fly', () => {
    expect(allRuns(job)).not.toMatch(
      /flyctl (secrets (set|unset|deploy|import)|deploy|machine (restart|stop|start|update)|scale)/,
    );
  });

  it('never prints the raw ssh output and uploads only the parsed report + markdown', () => {
    const runs = allRuns(job);
    expect(runs).not.toMatch(/cat ssh-output\.txt/);
    expect(runs).toMatch(/rm -f ssh-output\.txt remote-cmd\.txt/);
    const upload = job.steps.find((s) => /upload-artifact/.test(s.uses ?? '')) as Step & {
      with?: { path?: string };
    };
    expect(
      upload.with?.path
        ?.trim()
        .split('\n')
        .map((l) => l.trim()),
    ).toEqual(['env-truth-report.json', 'env-truth.md']);
    expect(runs).toMatch(/>> "\$\{GITHUB_STEP_SUMMARY\}"/);
    expect(text).not.toMatch(/set -x/);
  });

  it('pins every third-party action to a full commit sha', () => {
    for (const s of job.steps.filter((x) => x.uses)) expect(s.uses).toMatch(/@[0-9a-f]{40}$/);
  });
});
