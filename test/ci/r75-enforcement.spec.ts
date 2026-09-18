// Real ESLint configuration and parsed CI contracts, not remote-run evidence.
import { ESLint } from 'eslint';
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
const checkerText = readFileSync(join(root, checker), 'utf8');
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
const eslint = new ESLint({ cwd: root });

describe('R75 conformance: standing lint', () => {
  it('does not ignore the shipped checker', async () => {
    expect(await eslint.isPathIgnored(join(root, checker))).toBe(false);
  });

  it('actually lints the unmodified checker with no ignored-file warning', async () => {
    const results = await eslint.lintFiles([join(root, checker)]);
    expect(results).toHaveLength(1);
    expect(results[0].errorCount).toBe(0);
    expect(results[0].warningCount).toBe(0);
    expect(results[0].messages).toEqual([]);
  });

  it('reports an unused-variable mutation through the real configured rule', async () => {
    const results = await eslint.lintText(`${checkerText}\nconst unreferencedProbe = 1;\n`, {
      filePath: join(root, checker),
    });
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
    expect(Object.hasOwn(audit.on, 'pull_request')).toBe(true);
    expect(Object.hasOwn(audit.on, 'push')).toBe(true);
    expect(Object.hasOwn(audit.on, 'workflow_dispatch')).toBe(true);
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
