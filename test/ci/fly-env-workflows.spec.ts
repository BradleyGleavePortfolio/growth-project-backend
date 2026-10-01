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
import {
  flagAssignments,
  validateDesiredState,
} from '../../scripts/env-truth/fly-env-desired-state';

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

interface DesiredState {
  secrets: string[];
  flags: Record<string, string>;
  pending_flags: Record<string, { value: string; wave: string; needed_by: string; gate: string }>;
  excluded: Record<string, string>;
}
const DESIRED_FILE = join(ROOT, '.github/fly-env-desired-state.json');
const DESIRED = JSON.parse(readFileSync(DESIRED_FILE, 'utf8')) as DesiredState;

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
    // The bash allowlist comes from the manifest's `secrets`, which must equal
    // the env block exactly (a name missing from the env block would always be
    // skipped; one missing from the manifest would never be pushed).
    expect(pushStep.run).toMatch(
      /mapfile -t allowlist < <\(node scripts\/env-truth\/fly-env-desired-state\.js secrets /,
    );
    expect([...DESIRED.secrets].sort()).toEqual(allow.sort());
  });

  it('stages manifest `flags` only; `pending_flags` is never read by the workflow', () => {
    expect(pushStep.run).toMatch(
      /mapfile -t flag_args < <\(node scripts\/env-truth\/fly-env-desired-state\.js flags /,
    );
    expect(text).not.toMatch(/node [^\n]*pending/);
    expect(allRuns(job).replace(/#.*$/gm, '')).not.toMatch(/pending/);
    const validate = job.steps.find((s) => s.name === 'Validate desired-state manifest');
    expect(job.steps.indexOf(validate!)).toBeLessThan(job.steps.indexOf(pushStep));
    expect(validate?.run).toMatch(/fly-env-desired-state\.js validate /);
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

describe('.github/fly-env-desired-state.json', () => {
  const WAVE_A = [
    'FEATURE_COMMUNITY_SCHEMA',
    'FEATURE_COMMUNITY_API',
    'FEATURE_COMMUNITY_POSTS',
    'FEATURE_COMMUNITY_MESSAGES',
    'FEATURE_COMMUNITY_PUSH',
    'FEATURE_COMMUNITY_REALTIME',
    'BOOKING_REMINDERS_ENABLED',
    'FEATURE_MWB_TEMPLATES',
    'FEATURE_MWB_AUTOSAVE_UNDO',
    'FEATURE_NAMED_REGIMES',
    'FEATURE_DUNNING_V2',
  ];

  it('validates against the registry', () => {
    expect(validateDesiredState(DESIRED, [...REGISTERED])).toEqual([]);
  });

  it('Wave A day-1 flags are pending (value "true", gate documented) and NOT applied until the operator moves them', () => {
    expect(Object.keys(DESIRED.pending_flags).sort()).toEqual([...WAVE_A].sort());
    for (const n of WAVE_A) {
      expect([n, DESIRED.pending_flags[n].value, DESIRED.pending_flags[n].wave]).toEqual([
        n,
        'true',
        'A',
      ]);
    }
    expect(DESIRED.flags).toEqual({});
    expect(flagAssignments(DESIRED)).toEqual([]);
  });

  it('keeps FEATURE_MWB_AI_LIVE_CREATE and the stay-off community flags out', () => {
    const live = new Set([...Object.keys(DESIRED.flags), ...Object.keys(DESIRED.pending_flags)]);
    for (const n of [
      'FEATURE_MWB_AI_LIVE_CREATE',
      'FEATURE_COMMUNITY_AI_TRIAGE',
      'FEATURE_COMMUNITY_VOICE_NOTES',
      'FEATURE_COMMUNITY_CHALLENGES',
      'FEATURE_COMMUNITY_EVENTS',
      'FEATURE_COMMUNITY_CLASSROOM_POSTS',
      'FEATURE_COMMUNITY_DM',
    ]) {
      expect([n, live.has(n)]).toEqual([n, false]);
      expect(DESIRED.excluded[n]).toBeTruthy();
    }
  });

  it('prod-switches.yml marks every Wave A flag prod_default ON with the gate in the description', () => {
    const reg = parseYaml(readFileSync(join(ROOT, 'prod-switches.yml'), 'utf8')) as {
      switches: { name: string; prod_default: string; description: string }[];
    };
    for (const n of WAVE_A) {
      const row = reg.switches.find((r) => r.name === n);
      expect([n, row?.prod_default]).toEqual([n, 'ON']);
      expect(row?.description).toContain('Gate:');
    }
  });

  it('rejects bad manifests: unregistered name, non-boolean flag, duplicate block, missing gate', () => {
    const base = { secrets: ['GOOGLE_CLIENT_IDS'], flags: {}, pending_flags: {}, excluded: {} };
    const names = ['GOOGLE_CLIENT_IDS', 'FEATURE_COMMUNITY_API'];
    expect(validateDesiredState(base, names)).toEqual([]);
    expect(validateDesiredState({ ...base, secrets: ['NOT_REGISTERED_X'] }, names)).toEqual([
      'secrets: NOT_REGISTERED_X is not registered in env-validation.ts',
    ]);
    expect(
      validateDesiredState({ ...base, flags: { FEATURE_COMMUNITY_API: 'yes' } }, names),
    ).toEqual(['flags.FEATURE_COMMUNITY_API: value must be the string "true" or "false"']);
    expect(validateDesiredState({ ...base, flags: { GOOGLE_CLIENT_IDS: 'true' } }, names)).toEqual([
      'GOOGLE_CLIENT_IDS appears in both secrets and flags',
    ]);
    expect(
      validateDesiredState(
        {
          ...base,
          pending_flags: { FEATURE_COMMUNITY_API: { value: 'true', wave: 'A', needed_by: 'x' } },
        },
        names,
      ),
    ).toEqual(['pending_flags.FEATURE_COMMUNITY_API: gate is required']);
    expect(flagAssignments({ flags: { FEATURE_COMMUNITY_API: 'true' } })).toEqual([
      'FEATURE_COMMUNITY_API=true',
    ]);
  });
});
