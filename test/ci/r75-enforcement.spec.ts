// Real ESLint configuration and parsed CI contracts, not remote-run evidence.
import type { ESLint } from 'eslint';
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { load } from 'js-yaml';

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  shell?: string;
  if?: unknown;
  'continue-on-error'?: unknown;
}
interface Job {
  steps: Step[];
  if?: unknown;
  'continue-on-error'?: unknown;
}
interface Workflow {
  on: { schedule?: { cron: string }[]; pull_request?: unknown; push?: unknown };
  jobs: Record<string, Job>;
}
const root = join(__dirname, '../..');
const checker = 'scripts/check-r75.js';
const auditText = readFileSync(join(root, '.github/workflows/dependency-audit.yml'), 'utf8');
const ci = load(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')) as Workflow;
const audit = load(auditText) as Workflow;
const controlPaths = [
  checker,
  'test/ci/r75-gate.spec.ts',
  'test/ci/r75-boundaries.spec.ts',
  'test/ci/r75-wiring.spec.ts',
  'test/ci/r75-enforcement.spec.ts',
  'test/ci/r100-pathspec.spec.ts',
  'test/ci/dependency-audit.spec.ts',
];
const expectedCommand = `npx --no-install eslint --max-warnings 0 ${controlPaths.join(' ')}`;

describe('R75 conformance: standing lint', () => {
  let probe: { ignored: boolean; original: ESLint.LintResult[]; mutated: ESLint.LintResult[] };
  beforeAll(() => {
    // ESLint dynamically imports its flat config. Use native Node rather than
    // changing Jest's VM-module flags or bypassing real config discovery.
    const script = `
      const { ESLint } = require('eslint');
      const { readFileSync } = require('fs');
      const checker = process.argv[1];
      const eslint = new ESLint({ cwd: process.cwd() });
      async function inspect() {
        const text = readFileSync(checker, 'utf8');
        const result = {
          ignored: await eslint.isPathIgnored(checker),
          original: await eslint.lintFiles([checker]),
          mutated: await eslint.lintText(text + '\\nconst unreferencedProbe = 1;\\n', {
            filePath: checker,
          }),
        };
        process.stdout.write(JSON.stringify(result));
      }
      inspect().catch((error) => { console.error(error); process.exitCode = 2; });
    `;
    const result = spawnSync(process.execPath, ['-e', script, join(root, checker)], {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      killSignal: 'SIGKILL',
    });
    if (result.error || result.signal || result.status !== 0) {
      throw result.error ?? new Error(`lint harness failed: ${result.status} ${result.stderr}`);
    }
    probe = JSON.parse(result.stdout);
  });

  it('does not ignore the shipped checker', () => {
    expect(probe.ignored).toBe(false);
  });

  it('actually lints the unmodified checker with no ignored-file warning', () => {
    const results = probe.original;
    expect(results).toHaveLength(1);
    expect(results[0].errorCount).toBe(0);
    expect(results[0].warningCount).toBe(0);
    expect(results[0].messages).toEqual([]);
  });

  it('reports an unused-variable mutation through the real configured rule', () => {
    const results = probe.mutated;
    expect(results).toHaveLength(1);
    expect(results[0].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: '@typescript-eslint/no-unused-vars', severity: 1 }),
      ]),
    );
    expect(results[0].warningCount).toBeGreaterThan(0);
  });

  it('wires exactly the zero-warning control command without a fail-open suffix', () => {
    const job = ci.jobs['build-and-test'];
    const steps = job.steps.filter((step) => step.name === 'Lint control sources');
    expect(steps).toHaveLength(1);
    expect(steps[0].run?.trim().replace(/\s+/g, ' ')).toBe(expectedCommand);
    expect(steps[0].shell).toBe('bash');
    expect(steps[0]['continue-on-error']).toBeUndefined();
    expect(steps[0].if).toBeUndefined();
    expect(job['continue-on-error']).toBeUndefined();
    expect(job.if).toBeUndefined();
    const install = job.steps.findIndex((step) => step.name === 'Install dependencies');
    expect(install).toBeGreaterThanOrEqual(0);
    expect(install).toBeLessThan(job.steps.indexOf(steps[0]));
  });
});

describe('R75 conformance: weekly dependency audit', () => {
  it('declares one weekly UTC schedule while retaining change triggers', () => {
    expect(audit.on.schedule).toEqual([{ cron: '17 9 * * 1' }]);
    expect(Object.prototype.hasOwnProperty.call(audit.on, 'pull_request')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(audit.on, 'push')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(audit.on, 'workflow_dispatch')).toBe(true);
    expect(audit.jobs.audit.if).toBeUndefined();
  });

  it('uses immutable action identities without duplicated release-version prose', () => {
    const actions = audit.jobs.audit.steps.filter((step) => step.uses);
    expect(actions).toHaveLength(2);
    for (const step of actions) expect(step.uses).toMatch(/^actions\/[\w-]+@[a-f0-9]{40}$/);
    expect(auditText.split('\n').filter((line) => line.includes('uses:'))).toHaveLength(2);
    for (const line of auditText.split('\n').filter((entry) => entry.includes('uses:'))) {
      expect(line).not.toContain('#');
    }
  });
});
