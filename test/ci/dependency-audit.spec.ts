// Regression tests for the dependency-audit CI gate
// (.github/workflows/dependency-audit.yml).
//
// The tests parse the REAL workflow with js-yaml (already a declared
// dependency) and execute the audit step's REAL shell body, so a softened
// workflow changes their verdict. The body runs in a per-case sandbox whose
// PATH holds ONLY bash + timeout + node symlinks and (optionally) a fake npm,
// with a copy of the REAL scripts/ci/audit-gate.mjs, a fixture lockfile and a
// per-case exception file: the real npm is unreachable, so no install, registry
// or network access occurs. Fixture outcomes prove the fail-closed contract
// only; except the real braces report named in the cases file they are
// SYNTHETIC and are not evidence of a real advisory, audit run or clean graph.
// The gate's own behaviour matrix lives in test/ci/audit-gate.spec.ts.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { load as parseYaml } from 'js-yaml';

const WORKFLOW_PATH = join(__dirname, '..', '..', '.github', 'workflows', 'dependency-audit.yml');
const FIXTURES_PATH = join(__dirname, 'fixtures', 'dependency-audit-cases.json');
const GATE_FIXTURES = join(__dirname, 'fixtures', 'audit-gate');
const GATE_SCRIPT = join(__dirname, '..', '..', 'scripts', 'ci', 'audit-gate.mjs');
const EXCEPTIONS_PATH = '.github/audit-exceptions.json';
// The one gate invocation the step must end with, verbatim (comments stripped).
const GATE_INVOCATION =
  'node scripts/ci/audit-gate.mjs \\\n' +
  '  --audit "$audit_json" --audit-exit "$audit_exit" \\\n' +
  `  --lockfile package-lock.json --exceptions ${EXCEPTIONS_PATH}`;
const SHELL_TIMEOUT_MS = 5000;
const SHELL_MAX_BUFFER = 1024 * 1024;

// The whole-graph contract: exactly what the workflow must hand to npm.
// --include overrides an ambient --omit / NODE_ENV=production config, and
// --package-lock-only audits the committed lockfile without node_modules.
const AUDIT_ARGV_CONTRACT = [
  'audit',
  '--package-lock-only',
  '--include=prod',
  '--include=dev',
  '--include=optional',
  '--include=peer',
  '--audit-level=high',
  '--json',
];

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  shell?: string;
  with?: Record<string, unknown>;
  'continue-on-error'?: unknown;
}
interface Job {
  name?: string;
  'timeout-minutes'?: number;
  'continue-on-error'?: unknown;
  steps: Step[];
}
interface Workflow {
  name: string;
  on: Record<string, { branches?: string[] } | null>;
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
}
interface Case {
  id: string;
  npmExitCode: number;
  auditFixture: string;
  stderr: string;
  exceptions: 'none' | 'braces';
  expectShellExit: 'zero' | 'nonzero';
  expectMessage: string;
}

const workflow = parseYaml(fs.readFileSync(WORKFLOW_PATH, 'utf8')) as Workflow;
const cases: Case[] = JSON.parse(fs.readFileSync(FIXTURES_PATH, 'utf8')).cases;
const caseById = (id: string): Case => {
  const found = cases.find((c) => c.id === id);
  if (!found) throw new Error(`fixture case missing: ${id}`);
  return found;
};

const job: Job = workflow.jobs.audit;
const steps: Step[] = job.steps;
const runSteps = steps.filter((s): s is Step & { run: string } => typeof s.run === 'string');
const auditStep = runSteps.find((s) => /npm audit/.test(s.run));
// The one artifact under test: the audit step's shell body, verbatim.
const AUDIT_SHELL = auditStep ? auditStep.run : '';

// Flag assertions must read executable shell, not the explanatory comments,
// which legitimately NAME flags and failure modes the gate refuses.
const stripComments = (shell: string): string =>
  shell
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, ''))
    .join('\n');
const AUDIT_COMMANDS = stripComments(AUDIT_SHELL);

// Absolute host interpreters resolved without executing anything; a missing one
// is a harness failure, never a silent pass.
const resolveBinary = (name: string, candidates: string[]): string => {
  const found = candidates.find((path) => fs.existsSync(path));
  if (!found) throw new Error(`harness cannot resolve required binary: ${name}`);
  return found;
};
const BASH = resolveBinary('bash', ['/bin/bash', '/usr/bin/bash']);
const TIMEOUT = resolveBinary('timeout', ['/usr/bin/timeout', '/bin/timeout']);
const NODE = process.execPath;
const tempDirs: string[] = [];

const dayFromToday = (days: number): string =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const exceptionFile = (kind: 'none' | 'braces'): string =>
  JSON.stringify({
    schema: 1,
    exceptions:
      kind === 'braces'
        ? [
            {
              ghsa: 'GHSA-vfj7-8cjw-p6xm',
              package: 'braces',
              max_version: '3.0.3',
              reason: 'SYNTHETIC harness reason',
              expires: dayFromToday(10),
              owner_ruling: 'OR-114-2 (test)',
            },
          ]
        : [],
  });
const auditStdout = (c: Case | null): string =>
  c && c.auditFixture ? fs.readFileSync(join(GATE_FIXTURES, c.auditFixture), 'utf8') : '';

// Per-case sandbox: bin/ holds only bash + timeout + node symlinks, plus a fake
// npm when requested. No host PATH fallback, so the real npm cannot run. The
// working directory carries the real gate script, the fixture lockfile and the
// case's exception file at the paths the workflow names.
const makeSandbox = (npm: Case | null, exceptions: 'none' | 'braces'): string => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'dep-audit-gate-'));
  tempDirs.push(dir);
  const bin = join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(BASH, join(bin, 'bash'));
  fs.symlinkSync(TIMEOUT, join(bin, 'timeout'));
  fs.symlinkSync(NODE, join(bin, 'node'));
  fs.mkdirSync(join(dir, 'scripts', 'ci'), { recursive: true });
  fs.copyFileSync(GATE_SCRIPT, join(dir, 'scripts', 'ci', 'audit-gate.mjs'));
  fs.copyFileSync(join(GATE_FIXTURES, 'lock-dev-only.json'), join(dir, 'package-lock.json'));
  fs.mkdirSync(join(dir, '.github'));
  fs.writeFileSync(join(dir, EXCEPTIONS_PATH), exceptionFile(exceptions));
  fs.mkdirSync(join(dir, 'runner-temp'));
  if (npm) {
    // Fixture data arrives through the environment; only the absolute
    // interpreter path is interpolated into the shim body. `npm audit` argv is
    // logged one arg per line; the gate's own `npm view` registry probe is
    // answered with no patched release and logged separately.
    const shim = [
      `#!${BASH}`,
      'if [ "$1" = view ]; then',
      '  echo "$*" >> "$FAKE_NPM_VIEW_LOG"',
      '  echo \'["3.0.2","3.0.3"]\'',
      '  exit 0',
      'fi',
      'for arg in "$@"; do',
      '  echo "$arg" >> "$FAKE_NPM_ARGV_LOG"',
      'done',
      'if [ -n "${FAKE_NPM_STDOUT:-}" ]; then printf \'%s\' "$FAKE_NPM_STDOUT"; fi',
      'if [ -n "${FAKE_NPM_STDERR:-}" ]; then echo "$FAKE_NPM_STDERR" >&2; fi',
      'exit "$FAKE_NPM_EXIT"',
      '',
    ].join('\n');
    fs.writeFileSync(join(bin, 'npm'), shim);
    fs.chmodSync(join(bin, 'npm'), 0o755);
  }
  return dir;
};

// Runs a shell body in the sandbox, preserving stdout/stderr. Transport errors,
// signals and a null status throw as harness failures; they are never reported
// as "the gate failed closed".
const runShell = (body: string, npm: Case | null) => {
  const dir = makeSandbox(npm, npm ? npm.exceptions : 'none');
  const argvLog = join(dir, 'argv.log');
  const viewLog = join(dir, 'view.log');
  const proc = spawnSync(BASH, ['-c', body], {
    encoding: 'utf8',
    cwd: dir,
    timeout: SHELL_TIMEOUT_MS,
    maxBuffer: SHELL_MAX_BUFFER,
    killSignal: 'SIGKILL',
    env: {
      PATH: join(dir, 'bin'),
      HOME: dir,
      RUNNER_TEMP: join(dir, 'runner-temp'),
      FAKE_NPM_ARGV_LOG: argvLog,
      FAKE_NPM_VIEW_LOG: viewLog,
      FAKE_NPM_EXIT: String(npm ? npm.npmExitCode : 0),
      FAKE_NPM_STDOUT: auditStdout(npm),
      FAKE_NPM_STDERR: npm ? npm.stderr : '',
    },
  });
  if (proc.error) throw new Error(`harness failure: ${proc.error.message}`);
  if (proc.signal) throw new Error(`harness failure: shell killed by ${proc.signal}`);
  if (proc.status === null) throw new Error('harness failure: shell produced no exit status');
  return {
    status: proc.status,
    stdout: proc.stdout ?? '',
    stderr: proc.stderr ?? '',
    argv: fs.existsSync(argvLog)
      ? fs.readFileSync(argvLog, 'utf8').split('\n').filter(Boolean)
      : [],
    viewCalls: fs.existsSync(viewLog)
      ? fs.readFileSync(viewLog, 'utf8').split('\n').filter(Boolean)
      : [],
  };
};

/** True only when vulnerability, infrastructure AND missing-npm all fail. */
const failsClosed = (body: string): boolean =>
  [
    runShell(body, caseById('simulated-vulnerable')),
    runShell(body, caseById('infrastructure-failure')),
    runShell(body, null),
  ].every((outcome) => outcome.status !== 0);

/** The single shared graph-contract check, applied to real body and mutants. */
const satisfiesGraphContract = (body: string): boolean => {
  const argv = runShell(body, caseById('native-success')).argv;
  return JSON.stringify(argv) === JSON.stringify(AUDIT_ARGV_CONTRACT);
};

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('dependency-audit workflow structure', () => {
  it('exposes exactly one audit shell step running the native npm CLI', () => {
    expect(auditStep).toBeDefined();
    expect(runSteps.filter((s) => /npm audit\b/.test(s.run))).toHaveLength(1);
    expect(AUDIT_COMMANDS).toMatch(/set -euo pipefail/);
  });
  it('gates pull requests and main pushes, with manual dispatch as an extra', () => {
    expect(Object.keys(workflow.on)).toEqual(
      expect.arrayContaining(['pull_request', 'push', 'workflow_dispatch']),
    );
    expect(workflow.on.push?.branches).toContain('main');
  });
  it('keeps a stable reported check name for branch protection', () => {
    expect(workflow.name).toBe('Dependency Audit');
    expect(job.name).toBe('npm audit (high+critical, whole graph)');
  });
  it('requests read-only permissions and leaves no credentials in the runner', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    const checkout = steps.find((s) => (s.uses ?? '').startsWith('actions/checkout@'));
    expect(checkout?.with?.['persist-credentials']).toBe(false);
  });
  it('bounds job and command time', () => {
    const minutes = job['timeout-minutes'];
    expect(typeof minutes).toBe('number');
    expect(minutes as number).toBeGreaterThan(0);
    expect(minutes as number).toBeLessThanOrEqual(15);
    expect(AUDIT_COMMANDS).toMatch(/\btimeout\s+\d+\s+npm audit/);
  });
  it('pins every action to an immutable 40-hex commit SHA', () => {
    const uses = steps.map((s) => s.uses).filter((u): u is string => typeof u === 'string');
    expect(uses.length).toBeGreaterThan(0);
    for (const ref of uses) expect(ref).toMatch(/^[^@]+@[0-9a-f]{40}$/);
  });
  it('pins the runtime to the confirmed Node 20.20.1 and records versions', () => {
    const setupNode = steps.find((s) => (s.uses ?? '').startsWith('actions/setup-node@'));
    expect(setupNode?.with?.['node-version']).toBe('20.20.1');
    const allCommands = runSteps.map((s) => stripComments(s.run)).join('\n');
    expect(allCommands).toMatch(/node -v/);
    expect(allCommands).toMatch(/npm -v/);
  });
  it('runs every shell step under an explicit bash shell', () => {
    for (const step of runSteps) expect(step.shell).toBe('bash');
  });
  it('never installs dependencies or mutates the graph', () => {
    for (const step of runSteps) {
      const commands = stripComments(step.run);
      expect(commands).not.toMatch(/npm (ci|install|i)\b/);
      expect(commands).not.toMatch(/npm audit fix/);
      expect(commands).not.toMatch(/\bnpx\b/);
    }
  });
  it('has no swallowing fallback; the only exception input is the committed file via the gate', () => {
    expect(job['continue-on-error']).toBeUndefined();
    for (const step of steps) expect(step['continue-on-error']).toBeUndefined();
    for (const step of runSteps) {
      const commands = stripComments(step.run);
      expect(commands).not.toMatch(/\|\|\s*true/);
      expect(commands).not.toMatch(/\|\|\s*exit 0/);
      expect(commands).not.toMatch(/set \+e/);
    }
    expect(AUDIT_COMMANDS).not.toMatch(/audit-ignore|suppress|allowlist/);
    // Exactly one `||`: npm's exit code is captured for the gate, never dropped.
    expect(AUDIT_COMMANDS.match(/\|\|/g)).toEqual(['||']);
    expect(AUDIT_COMMANDS).toMatch(/--json >"\$audit_json" \|\| audit_exit=\$\?\n/);
    // The step ENDS with the one gate invocation (its exit is the verdict) and
    // names exactly one exception file; no clock/registry override is passed.
    expect(AUDIT_COMMANDS.trimEnd().endsWith(GATE_INVOCATION)).toBe(true);
    expect(AUDIT_COMMANDS.split('audit-gate.mjs')).toHaveLength(2);
    expect(AUDIT_COMMANDS.match(/audit-exceptions[\w.-]*/g)).toEqual(['audit-exceptions.json']);
    expect(AUDIT_COMMANDS).not.toMatch(/--now|--today|--registry|AUDIT_GATE_/);
  });
});

describe('dependency-audit shell body against controlled fake npm processes', () => {
  it.each(cases.map((c) => [c.id, c] as [string, Case]))(
    'case %s exits as required, prints the gate verdict and preserves npm stderr',
    (_id, testCase) => {
      const result = runShell(AUDIT_SHELL, testCase);
      if (testCase.expectShellExit === 'zero') {
        expect(result.status).toBe(0);
      } else {
        expect(result.status).not.toBe(0);
      }
      expect(result.stdout).toContain(testCase.expectMessage);
      if (testCase.stderr) expect(result.stderr).toContain(testCase.stderr);
    },
  );
  it('runs the registry probe only for an applied exception', () => {
    expect(runShell(AUDIT_SHELL, caseById('excepted-braces-dev-only')).viewCalls).toEqual([
      'view braces versions --json',
    ]);
    expect(runShell(AUDIT_SHELL, caseById('native-success')).viewCalls).toEqual([]);
  });
  it('fails when npm is absent from the isolated PATH', () => {
    const result = runShell(AUDIT_SHELL, null);
    expect(result.status).not.toBe(0);
    expect(result.argv).toEqual([]);
  });
  it('hands npm the whole-graph argument contract', () => {
    expect(runShell(AUDIT_SHELL, caseById('native-success')).argv).toEqual(AUDIT_ARGV_CONTRACT);
    expect(satisfiesGraphContract(AUDIT_SHELL)).toBe(true);
  });
});

describe('mutation detection (the tests must reject a softened gate)', () => {
  const mutate = (find: string, replace: string): string => {
    const mutant = AUDIT_COMMANDS.replace(find, replace);
    if (mutant === AUDIT_COMMANDS) throw new Error(`mutation did not apply: ${find}`);
    return mutant;
  };
  it('accepts the real shell body as fail-closed', () => {
    expect(failsClosed(AUDIT_SHELL)).toBe(true);
  });
  const GATE_TAIL = `--exceptions ${EXCEPTIONS_PATH}`;
  it.each([
    ['trailing || true', mutate(GATE_TAIL, `${GATE_TAIL} || true`)],
    ['soft-fail echo branch', mutate(GATE_TAIL, `${GATE_TAIL} || echo soft`)],
    ['errexit disabled', `${mutate('set -euo pipefail', 'set -uo pipefail\nset +e')}\ntrue\n`],
    ['gate never runs', mutate('node scripts/ci/audit-gate.mjs', ': scripts/ci/audit-gate.mjs')],
  ])('rejects a mutant that swallows the failure: %s', (_label, mutant) => {
    expect(failsClosed(mutant)).toBe(false);
  });
  it("rejects a mutant that discards npm's exit code", () => {
    const mutant = mutate('--audit-exit "$audit_exit"', '--audit-exit 0');
    const testCase = caseById('infrastructure-failure-with-clean-json');
    expect(runShell(AUDIT_SHELL, testCase).status).not.toBe(0);
    expect(runShell(mutant, testCase).status).toBe(0);
  });
  it('rejects a mutant that pins the gate to a different exception file', () => {
    const mutant = mutate(EXCEPTIONS_PATH, '.github/audit-exceptions.local.json');
    expect(runShell(mutant, caseById('excepted-braces-dev-only')).status).not.toBe(0);
  });
  it('rejects a narrowing mutant via the shared graph-contract check', () => {
    // --include overrides --omit, so a meaningful narrowing mutant must delete
    // the explicit includes first; only then does --omit=dev take effect.
    const mutant = AUDIT_COMMANDS.replace(/ --include=\w+/g, '').replace(
      '--audit-level=high',
      '--omit=dev --audit-level=high',
    );
    expect(mutant).not.toBe(AUDIT_COMMANDS);
    expect(satisfiesGraphContract(mutant)).toBe(false);
    expect(satisfiesGraphContract(AUDIT_SHELL)).toBe(true);
  });
  it('rejects deleting --package-lock-only via the same graph-contract check', () => {
    expect(satisfiesGraphContract(mutate(' --package-lock-only', ''))).toBe(false);
  });
  it('rejects deleting --json via the same graph-contract check', () => {
    expect(satisfiesGraphContract(mutate(' --json', ''))).toBe(false);
  });
});
