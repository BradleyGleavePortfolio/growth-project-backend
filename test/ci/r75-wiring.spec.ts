// Execute the shipped YAML commands; matching their text is not wiring proof.
import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { load } from 'js-yaml';

interface Step {
  name?: string;
  uses?: string;
  shell?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Workflow {
  jobs: Record<string, { steps: Step[]; 'continue-on-error'?: boolean }>;
}
interface Hooks {
  'pre-commit': { commands: Record<string, { run: string }> };
}
const root = join(__dirname, '../..');
const checkerPath = 'scripts/check-r75.js';
const policyPath = '.github/r75-policy.json';
const workflow = load(
  readFileSync(join(root, '.github/workflows/r100-quality-gate.yml'), 'utf8'),
) as Workflow;
const job = workflow.jobs['banned-casts'];
const step = job.steps.find((entry) => entry.name === 'Diff banned tokens');
if (!step?.run) throw new Error('missing executable workflow step');
const body = step.run;
const hooks = load(readFileSync(join(root, 'lefthook.yml'), 'utf8')) as Hooks;
const hook = hooks['pre-commit'].commands['banned-cast-tokens'].run;
const vectors: { tokens: { name: string; input: string }[] } = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/r75-boundaries.json'), 'utf8'),
);
const directories: string[] = [];
const cleanEnvironment = {
  PATH: process.env.PATH,
  HOME: tmpdir(),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

function command(repo: string, binary: string, args: string[], env = cleanEnvironment) {
  const result = spawnSync(binary, args, {
    cwd: repo,
    env,
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 1024 * 1024,
    killSignal: 'SIGKILL',
  });
  if (result.error || result.signal || result.status === null) {
    throw result.error ?? new Error(`harness interrupted: ${result.signal}`);
  }
  return result;
}

function git(repo: string, ...args: string[]) {
  const result = command(repo, 'git', args);
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function write(repo: string, path: string, text: string) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
}

function repository(violation: boolean) {
  const repo = mkdtempSync(join(tmpdir(), 'r75-wiring-'));
  directories.push(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'config', 'user.email', 'test@invalid.local');
  for (const path of [checkerPath, policyPath]) {
    write(repo, path, readFileSync(join(root, path), 'utf8'));
  }
  git(repo, 'add', '-A', '-f');
  git(repo, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  write(repo, 'src/example.ts', violation ? vectors.tokens[0].input : 'export const value = 1;');
  git(repo, 'add', '-A', '-f');
  return { repo, base };
}

function shell(repo: string, script: string, values: Record<string, string> = {}) {
  // Node's socket-backed stdin can trigger Bash rc loading even without -i.
  return command(repo, 'bash', ['--noprofile', '--norc', '-eu', '-o', 'pipefail', '-c', script], {
    ...cleanEnvironment,
    ...values,
  });
}

function rangeRun(script: string, violation: boolean, values: Record<string, string> = {}) {
  const { repo, base } = repository(violation);
  git(repo, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'head');
  const head = git(repo, 'rev-parse', 'HEAD');
  // The event head, not the checked-out base, must be scanned.
  git(repo, 'checkout', '-q', '--detach', base);
  return shell(repo, script, {
    EVENT_NAME: 'pull_request',
    BASE_SHA: base,
    HEAD_SHA: head,
    ...values,
  });
}

function wiringContract(script: string, mode: 'range' | 'staged', diagnose = false) {
  return [false, true].every((violation) => {
    const { repo } = mode === 'staged' ? repository(violation) : { repo: '' };
    const result = mode === 'range' ? rangeRun(script, violation) : shell(repo, script);
    const matches =
      result.status === (violation ? 1 : 0) &&
      result.stdout.includes(violation ? 'FAIL: positive per-class' : 'OK') &&
      result.stderr === '';
    if (!matches && diagnose) {
      throw new Error(
        `R75 wiring subprocess failed: ${JSON.stringify({
          mode,
          violation,
          status: result.status,
          stdout: result.stdout,
          stderr: result.stderr,
        })}`,
      );
    }
    return matches;
  });
}

function removeInvocation(script: string, commented: boolean) {
  const lines = script.split('\n');
  const index = lines.findIndex((line) => line.trim().startsWith(`node ${checkerPath} `));
  if (index < 0) throw new Error('mutation target missing');
  lines[index] = commented ? `# ${lines[index]}` : 'echo "checker intentionally removed"';
  return lines.join('\n');
}

afterAll(() => {
  for (const repo of directories) rmSync(repo, { recursive: true, force: true });
});

describe('R75 executable wiring contracts', () => {
  it('does not load ambient startup files into a wiring subprocess', () => {
    const home = mkdtempSync(join(tmpdir(), 'r75-shell-home-'));
    directories.push(home);
    write(home, '.bashrc', 'printf "STARTUP_FILE_READ\\n" >&2\n[ -z "$PS1" ] && return\n');
    write(home, '.bash_profile', 'printf "PROFILE_READ\\n" >&2\n');
    const result = shell(home, 'printf "EXPECTED_OUTPUT\\n"', { HOME: home });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('EXPECTED_OUTPUT\n');
    expect(result.stderr).toBe('');
  });

  it.each([
    ['errexit', 'false; printf "MUST_NOT_RUN"', ''],
    ['nounset', 'printf "%s" "$R75_UNSET_VALUE"', 'unbound variable'],
    ['pipefail', 'false | true; printf "MUST_NOT_RUN"', ''],
  ])('retains %s when startup files are disabled', (_name, script, diagnostic) => {
    const result = shell(root, script);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(diagnostic);
  });

  it.each(['range', 'staged'] as const)('rejects unfiltered script stderr in %s', (mode) => {
    const script = `printf "SCRIPT_STDERR\\n" >&2\n${mode === 'range' ? body : hook}`;
    expect(wiringContract(script, mode)).toBe(false);
    expect(() => wiringContract(script, mode, true)).toThrow(/SCRIPT_STDERR/);
  });

  it.each(['range', 'staged'] as const)('the actual %s body passes the contract', (mode) => {
    expect(wiringContract(mode === 'range' ? body : hook, mode, true)).toBe(true);
  });

  it.each(['range', 'staged'] as const)(
    'reports the failed %s subprocess without relaxing the contract',
    (mode) => {
      const script = removeInvocation(mode === 'range' ? body : hook, false);
      expect(() => wiringContract(script, mode, true)).toThrow(
        new RegExp(
          `"mode":"${mode}","violation":false,"status":0,"stdout":.*checker intentionally removed.*"stderr":""`,
        ),
      );
      expect(wiringContract(script, mode)).toBe(false);
    },
  );

  it.each([
    ['range', false],
    ['range', true],
    ['staged', false],
    ['staged', true],
  ] as const)('detects a missing call in %s (commented=%s)', (mode, commented) => {
    const script = mode === 'range' ? body : hook;
    const mutant = removeInvocation(script, commented);
    expect(mutant).not.toBe(script);
    expect(wiringContract(mutant, mode)).toBe(false);
  });

  it.each(['', '   '])('rejects an empty event head instead of checkout fallback: %s', (head) => {
    const result = rangeRun(body, false, { HEAD_SHA: head });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('OK');
    expect(result.stderr).toMatch(/head SHA|nonempty head/);
  });

  it.each(['', '   ', 'not-a-commit'])('rejects an unusable event base: %s', (base) => {
    const result = rangeRun(body, false, { BASE_SHA: base });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('OK');
    expect(result.stderr).not.toBe('');
  });

  it('rejects a malformed event head', () => {
    const result = rangeRun(body, false, { HEAD_SHA: 'not-a-commit' });
    expect(result.status).toBe(2);
    expect(result.stdout).not.toContain('OK');
    expect(result.stderr).toContain('operational failure');
  });

  it('keeps a manual dispatch explicitly non-certifying', () => {
    const result = rangeRun(body, true, {
      EVENT_NAME: 'workflow_dispatch',
      BASE_SHA: '',
      HEAD_SHA: '',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('NON-CERTIFYING RUN');
    expect(result.stdout).toContain('NOT measured');
    expect(result.stdout).not.toContain('OK');
  });

  it('uses event references, an explicit shell and a pinned runtime without stored credentials', () => {
    expect(step.env).toEqual({
      EVENT_NAME: '${{ github.event_name }}',
      BASE_SHA: '${{ github.event.pull_request.base.sha }}',
      HEAD_SHA: '${{ github.event.pull_request.head.sha }}',
    });
    expect(step.shell).toBe('bash');
    expect(job['continue-on-error']).not.toBe(true);
    const setup = job.steps.find((entry) => entry.uses?.startsWith('actions/setup-node@'));
    expect(setup?.uses).toMatch(/^actions\/setup-node@[a-f0-9]{40}$/);
    expect(setup?.with?.['node-version']).toBe('20.20.1');
    const checkout = job.steps.find((entry) => entry.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with?.['persist-credentials']).toBe(false);
    expect(checkout?.with?.['fetch-depth']).toBe(0);
  });
});

describe('canonical quota retirement preserves the remaining enforcement', () => {
  it('removes quota requirements without changing the retained provisioning payload', () => {
    const script = readFileSync(join(root, 'scripts/setup-branch-protection.sh'), 'utf8');
    const start = script.indexOf('REQUIRED_CHECKS=(\n');
    const end = script.indexOf('\necho "Applying branch protection');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    // Evaluate only local array/JSON construction, NEVER the provisioning script
    // or its network operations. No credentials or repository target are supplied.
    const construction = script.slice(start, end);
    expect(construction).not.toMatch(/\bcurl\b|\bgh\b|GH_TOKEN|GH_REPO|PROTECTION_URL/);
    const result = shell(root, `${construction}\nprintf '%s' "$PAYLOAD"`);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      required_status_checks: {
        strict: true,
        checks: [
          'build-and-test',
          'rls-floor-guard',
          'rls-live-tests',
          'mwb-3-live-tests',
          'danger',
          'Banned cast tokens (R75 / R100.A2)',
          'test-deploy-readiness',
        ].map((context) => ({ context, app_id: -1 })),
      },
      enforce_admins: true,
      required_pull_request_reviews: {
        dismiss_stale_reviews: true,
        require_code_owner_reviews: true,
        required_approving_review_count: 1,
        require_last_push_approval: true,
      },
      restrictions: null,
      required_linear_history: true,
      allow_force_pushes: false,
      allow_deletions: false,
      block_creations: false,
      required_conversation_resolution: true,
      lock_branch: false,
      allow_fork_syncing: false,
    });
  });

  it('removes only the quota jobs, not the R75 event or execution boundary', () => {
    const configuration = load(
      readFileSync(join(root, '.github/workflows/r100-quality-gate.yml'), 'utf8'),
    ) as Record<string, unknown>;
    expect(configuration.on).toEqual({
      pull_request: { branches: ['main'] },
      workflow_dispatch: null,
    });
    expect(configuration.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' });
    expect(configuration.concurrency).toEqual({
      group: 'r100-quality-gate-${{ github.ref }}',
      'cancel-in-progress': true,
    });
    expect(Object.keys(workflow.jobs)).toEqual(['banned-casts']);
    // No new job/step condition, dependency, or continue-on-error may skip R75.
    expect(Object.keys(job).sort()).toEqual(['name', 'runs-on', 'steps']);
    expect(job.steps).toHaveLength(3);
    expect(job.steps.map((entry) => Object.keys(entry).sort())).toEqual([
      ['uses', 'with'],
      ['uses', 'with'],
      ['env', 'name', 'run', 'shell'],
    ]);
    expect(body).not.toMatch(/PR_TITLE|GH_TOKEN|gh pr view|--numstat/);
  });

  it.each([
    ['range', false, ''],
    ['range', true, ''],
    ['staged', false, ''],
    ['staged', true, ''],
    ['range', false, '[LOC-EXEMPT: legacy] [TEST-EXEMPT: legacy]'],
    ['range', true, '[LOC-EXEMPT: legacy] [TEST-EXEMPT: legacy]'],
    ['staged', false, '[LOC-EXEMPT: legacy] [TEST-EXEMPT: legacy]'],
    ['staged', true, '[LOC-EXEMPT: legacy] [TEST-EXEMPT: legacy]'],
  ] as const)(
    '%s measures safety, not volume or title (violation=%s, title=%s)',
    (mode, violation, title) => {
      const { repo, base } = repository(false);
      const lines = Array.from({ length: 1101 }, (_, index) => `export const item${index} = 1;`);
      if (violation) lines.push(vectors.tokens[0].input);
      write(repo, 'src/large.ts', `${lines.join('\n')}\n`);
      git(repo, 'add', '-A', '-f');
      expect(git(repo, 'diff', '--cached', '--numstat', '--', 'src/large.ts')).toBe(
        `${lines.length}\t0\tsrc/large.ts`,
      );
      // No test additions or exemption title are required to measure this diff.
      expect(git(repo, 'diff', '--cached', '--name-only', '--', 'test/')).toBe('');
      let head = '';
      if (mode === 'range') {
        git(repo, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'large source');
        head = git(repo, 'rev-parse', 'HEAD');
        git(repo, 'checkout', '-q', '--detach', base);
      }
      const result = shell(repo, mode === 'range' ? body : hook, {
        EVENT_NAME: 'pull_request',
        BASE_SHA: base,
        HEAD_SHA: head,
        PR_TITLE: title,
        PR_TITLE_EVENT: title,
      });
      expect(result.status).toBe(violation ? 1 : 0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain(
        violation ? 'FAIL: positive per-class token change' : 'OK — no positive token change',
      );
      if (violation) expect(result.stdout).toContain('src/large.ts');
    },
  );

  it.each(['range', 'staged'] as const)(
    'retired title exemptions cannot turn broken policy into success in %s',
    (mode) => {
      const { repo, base } = repository(false);
      write(repo, policyPath, '{invalid policy');
      git(repo, 'add', '-A', '-f');
      let head = '';
      if (mode === 'range') {
        git(repo, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'invalid policy');
        head = git(repo, 'rev-parse', 'HEAD');
      }
      const result = shell(repo, mode === 'range' ? body : hook, {
        EVENT_NAME: 'pull_request',
        BASE_SHA: base,
        HEAD_SHA: head,
        PR_TITLE: '[LOC-EXEMPT: legacy] [TEST-EXEMPT: legacy]',
        PR_TITLE_EVENT: '[LOC-EXEMPT: legacy] [TEST-EXEMPT: legacy]',
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('operational failure');
      expect(result.stdout).not.toContain('OK');
    },
  );
});
