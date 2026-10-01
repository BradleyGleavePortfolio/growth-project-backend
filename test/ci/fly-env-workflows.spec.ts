/**
 * S-ENVTRUTH — structural invariants for the two operator env workflows:
 *   .github/workflows/fly-env-sync.yml   (stages allowlisted GitHub secrets on Fly)
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

describe('fly-env-sync.yml', () => {
  const { wf, text, job } = loadWorkflow('.github/workflows/fly-env-sync.yml');
  const pushStep = job.steps.find((s) => /flyctl secrets set/.test(s.run ?? ''))!;

  it('is workflow_dispatch only, read-only token, production environment', () => {
    expect(Object.keys(wf.on)).toEqual(['workflow_dispatch']);
    expect(wf.on.workflow_dispatch.inputs?.app?.default).toBe('backend-spring-lake-3890');
    expect(wf.on.workflow_dispatch.inputs?.confirm?.required).toBe(true);
    expect(wf.permissions).toEqual({ contents: 'read' });
    expect(envName(job)).toBe('production');
  });

  it('guards: app allowlist and confirm=SET before anything touches Fly', () => {
    expectAppAllowlist(job);
    const confirm = job.steps.find((s) => s.name === 'Confirm operator intent');
    expect(confirm?.run).toMatch(/if \[ "\$\{CONFIRM\}" != "SET" \]; then[\s\S]*exit 1/);
    const firstFly = job.steps.findIndex((s) => /setup-flyctl/.test(s.uses ?? ''));
    expect(job.steps.indexOf(confirm!)).toBeLessThan(firstFly);
  });

  it('stages with --stage (no machine restart); applies only when deploy_staged=true', () => {
    expect(pushStep.run).toMatch(/flyctl secrets set --stage -a "\$\{APP\}" "\$\{args\[@\]\}"/);
    const input = wf.on.workflow_dispatch.inputs?.deploy_staged;
    expect(input?.type).toBe('boolean');
    expect(input?.default).toBe(false);
    const applying = job.steps.filter((s) => /flyctl secrets deploy/.test(s.run ?? ''));
    expect(applying).toHaveLength(1);
    expect(applying[0].if).toBe('${{ inputs.deploy_staged }}');
    expect(allRuns(job)).not.toMatch(/flyctl (deploy|machine restart|apps restart)/);
    expect(allRuns(job)).not.toMatch(/secrets unset/);
  });

  it('can push GOOGLE_CLIENT_IDS (required for launch)', () => {
    expect(pushStep.env?.GOOGLE_CLIENT_IDS).toBe('${{ secrets.GOOGLE_CLIENT_IDS }}');
    expect(ENV_RULES.find((r) => r.name === 'GOOGLE_CLIENT_IDS')?.launch).toBe('required');
  });

  it('pushes exactly the allowlist, every name maps to the same-named GitHub secret and is registered', () => {
    const env = pushStep.env ?? {};
    const allow = Object.keys(env).filter((k) => k !== 'FLY_API_TOKEN' && k !== 'APP');
    expect(allow.sort()).toEqual([...EXPECTED_ALLOWLIST].sort());
    for (const n of allow) {
      expect(env[n]).toBe(`\${{ secrets.${n} }}`);
      expect(REGISTERED.has(n)).toBe(true);
    }
    // The bash allowlist array matches the env block exactly.
    const arr = /allowlist=\(\n([\s\S]*?)\n\s*\)/.exec(pushStep.run ?? '');
    expect(arr).not.toBeNull();
    expect(
      arr![1]
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .sort(),
    ).toEqual(allow.sort());
  });

  it('does not push the Apple sign-in keys (owned by the account-deletion lane workflow)', () => {
    expect(text).not.toMatch(/APPLE_SIGNIN_/);
  });

  it('skips unset/empty secrets instead of pushing empty values', () => {
    expect(pushStep.run).toMatch(/if \[ -n "\$\{!name:-\}" \]; then/);
    expect(pushStep.run).toMatch(/skipped\+=/);
  });

  it('never echoes a value: no set -x, no echo/printf of a secret variable, args or indirect expansion', () => {
    const runs = allRuns(job);
    expect(runs).not.toMatch(/set -x/);
    for (const step of job.steps) expect(step.run ?? '').not.toMatch(/^\s*set -o xtrace/m);
    const printing = runs.split('\n').filter((l) => /^\s*(echo|printf|cat)\b/.test(l));
    for (const line of printing) {
      expect(line).not.toMatch(/\$\{!name|\$\{args|\$args\b|\$\{?FLY_API_TOKEN/);
      for (const n of EXPECTED_ALLOWLIST) expect(line).not.toMatch(new RegExp(`\\$\\{?${n}\\b`));
    }
    expect(pushStep.run).toMatch(/flyctl secrets set[^\n]*> \/dev\/null/);
    expect(pushStep.run).toMatch(/set \+x/);
  });

  it('post-check prints names only (never digests)', () => {
    const check = job.steps.find((s) => /flyctl secrets list/.test(s.run ?? ''))!;
    expect(check.run).toMatch(/awk -F'│' '\{gsub\(/);
    expect(check.run).not.toMatch(/echo "\$\{listing\}"/);
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
