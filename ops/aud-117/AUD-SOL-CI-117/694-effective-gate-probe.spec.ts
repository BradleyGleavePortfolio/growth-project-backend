import * as fs from 'fs';
import { join, resolve } from 'path';
import * as ts from 'typescript';
import { runInNewContext } from 'vm';

const ROOT = resolve(__dirname, '..', '..');
const GUARD = join(ROOT, 'test/ci/jest-typecheck-gate.spec.ts');
const WORKFLOW = join(ROOT, '.github/workflows/ci.yml');
const CONFIG = join(ROOT, 'tsconfig.json');
const JEST_CONFIG = join(ROOT, 'jest.config.js');

interface Mutation {
  workflow?: (text: string) => string;
  config?: (text: string) => string;
  files?: Record<string, string>;
  jest?: (cfg: Record<string, unknown>) => void;
}

function edit(text: string, before: string, after: string): string {
  expect(text).toContain(before);
  return text.replace(before, after);
}

// Tests-only VM executes the exact candidate guard unchanged. All file enumeration,
// TypeScript configuration parsing and Jest normalization remain real.
async function failures(m: Mutation) {
  const virtual: Record<string, string> = {};
  if (m.workflow) virtual[WORKFLOW] = m.workflow(fs.readFileSync(WORKFLOW, 'utf8'));
  if (m.config) virtual[CONFIG] = m.config(fs.readFileSync(CONFIG, 'utf8'));
  for (const [path, content] of Object.entries(m.files ?? {})) {
    virtual[resolve(ROOT, path)] = content;
  }
  const get = (p: unknown) =>
    typeof p === 'string' ? virtual[resolve(p)] : undefined;
  const fsView = {
    ...fs,
    readFileSync: (p: fs.PathOrFileDescriptor, options?: Parameters<typeof fs.readFileSync>[1]) =>
      get(p) ?? fs.readFileSync(p, options),
    existsSync: (p: fs.PathLike) => get(p) !== undefined || fs.existsSync(p),
  };
  const load = (id: string): unknown => {
    if (id === 'fs') return fsView;
    if (id === JEST_CONFIG && m.jest) {
      const cfg = { ...require(JEST_CONFIG) };
      m.jest(cfg);
      return cfg;
    }
    return require(id);
  };
  const cases: Array<{ name: string; body: () => unknown }> = [];
  const code = ts.transpileModule(fs.readFileSync(GUARD, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  runInNewContext(code, {
    __dirname: join(ROOT, 'test/ci'),
    exports: {},
    require: Object.assign(load, { resolve: require.resolve }),
    expect,
    describe: (_name: string, body: () => void) => body(),
    it: (name: string, body: () => unknown) => cases.push({ name, body }),
  });
  const failed: string[] = [];
  let executed = 0;
  for (const c of cases) {
    if (/^(accepts|rejects): /.test(c.name)) continue;
    executed++;
    try {
      await c.body();
    } catch (error) {
      failed.push(`${c.name}: ${String(error)}`);
    }
  }
  expect(executed).toBe(3);
  return failed;
}

const withConfig = (change: (cfg: Record<string, any>) => void) => (text: string) => {
  const cfg = JSON.parse(text);
  change(cfg);
  return JSON.stringify(cfg);
};

describe('AUD-SOL-CI-117 independent exact-guard boundary probes', () => {
  it('control: candidate inputs pass unchanged', async () => {
    expect(await failures({})).toEqual([]);
  });

  const rejects: Array<[string, Mutation, RegExp]> = [
    ['masked tsc exit', {
      workflow: (t) => edit(t, 'run: npx tsc --noEmit\n', 'run: npx tsc --noEmit || true\n'),
    }, /not one plain tsc command/],
    ['narrow effective project', {
      workflow: (t) => edit(t, '- name: Type-check\n', '- name: Type-check\n        working-directory: scripts/secrets\n'),
    }, /Type-check runs in scripts\/secrets/],
    ['explicit strict override', {
      config: withConfig((c) => { c.compilerOptions.strictFunctionTypes = false; }),
    }, /effective strictFunctionTypes is false/],
    ['inherited noCheck', {
      config: withConfig((c) => {
        c.extends = './aud-sol-ci117-base.json';
      }),
      files: { 'aud-sol-ci117-base.json': '{"compilerOptions":{"noCheck":true}}' },
    }, /effective noCheck is on/],
    ['one excluded spec, not a whole directory', {
      config: withConfig((c) => {
        c.exclude.push('test/ci/branch-protection-checks.spec.ts');
      }),
    }, /branch-protection-checks\.spec\.ts/],
    ['disabled tsc step', {
      workflow: (t) => edit(t, '- name: Type-check\n', '- name: Type-check\n        if: false\n'),
    }, /Type-check has an if:/],
    ['fractional memory', {
      jest: (c) => { c.workerIdleMemoryLimit = 0.9; },
    }, /share of system RAM/],
    ['job shell masks failure', {
      workflow: (t) => edit(t, '  build-and-test:\n', '  build-and-test:\n    defaults:\n      run:\n        shell: bash {0}; true\n'),
    }, /only the runner default or bash/],
  ];
  for (const [name, mutation, diagnostic] of rejects) {
    it(`fails closed: ${name}`, async () => {
      const result = await failures(mutation);
      expect(result.length).toBeGreaterThan(0);
      expect(result.join('\n')).toMatch(diagnostic);
    });
  }

  it('control: a root step overrides a narrow job default', async () => {
    expect(await failures({
      workflow: (t) => edit(
        edit(t, '  build-and-test:\n',
          '  build-and-test:\n    defaults:\n      run:\n        working-directory: scripts/secrets\n'),
        '- name: Type-check\n', '- name: Type-check\n        working-directory: .\n',
      ),
    })).toEqual([]);
  });
});
