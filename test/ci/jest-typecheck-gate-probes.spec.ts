// B-CI2-116 (B-694-1, C-694-2): black-box regression for the type-gate guard.
//
// Executes test/ci/jest-typecheck-gate.spec.ts UNCHANGED inside a VM, feeding
// it virtual mutations of its real inputs (.github/workflows/ci.yml,
// tsconfig.json, jest.config.js), and requires the guard to fail on every
// mutation that weakens the gate. The first mutations are the GPT-6.1 Sol
// probes of CI-lane run 37173631554 (Type-check moved to scripts/secrets;
// strictNullChecks:false under strict:true), which the first version of the
// guard accepted. This file depends only on the guard's inputs, never on its
// internals, so the same assertions run against any version of the guard.
//
// The guard's own negative self-tests (names starting with "rejects:") are
// skipped here: they run in the guard's suite, and repeating them under every
// mutation would only multiply the cost.
//
// Reads files only; never runs tsc, jest, git or any network call.

import * as fs from 'fs';
import { join, resolve } from 'path';
import * as ts from 'typescript';
import { runInNewContext } from 'vm';

const ROOT = resolve(__dirname, '..', '..');
const GUARD = join(ROOT, 'test', 'ci', 'jest-typecheck-gate.spec.ts');
const WORKFLOW = join(ROOT, '.github', 'workflows', 'ci.yml');
const TSCONFIG = join(ROOT, 'tsconfig.json');
const JEST_CONFIG = join(ROOT, 'jest.config.js');

interface TsconfigJson {
  compilerOptions: Record<string, unknown>;
  exclude: string[];
}

interface Mutation {
  workflow?: (text: string) => string;
  tsconfig?: (cfg: TsconfigJson) => void;
  jest?: (cfg: Record<string, unknown>) => void;
}

interface GuardRun {
  executed: string[];
  failures: string[];
}

/** Text edit that must change the input (a no-op edit would make the probe vacuous). */
function edit(text: string, find: string, replace: string): string {
  const out = text.replace(find, replace);
  if (out === text) throw new Error(`probe edit did not apply: ${JSON.stringify(find)}`);
  return out;
}

async function runGuard(m: Mutation): Promise<GuardRun> {
  const workflowText = m.workflow ? m.workflow(fs.readFileSync(WORKFLOW, 'utf8')) : undefined;
  let tsconfigText: string | undefined;
  if (m.tsconfig) {
    const cfg = JSON.parse(fs.readFileSync(TSCONFIG, 'utf8')) as TsconfigJson;
    m.tsconfig(cfg);
    tsconfigText = JSON.stringify(cfg);
  }
  const virtual = (p: unknown): string | undefined => {
    if (typeof p !== 'string') return undefined;
    const abs = resolve(p);
    if (abs === WORKFLOW) return workflowText;
    if (abs === TSCONFIG) return tsconfigText;
    return undefined;
  };
  const fsView = {
    ...fs,
    readFileSync: (p: fs.PathOrFileDescriptor, options?: Parameters<typeof fs.readFileSync>[1]) => {
      const text = virtual(p);
      return text !== undefined ? text : fs.readFileSync(p, options);
    },
  };
  const tsView = {
    ...ts,
    getParsedCommandLineOfConfigFile: (
      path: string,
      extend: ts.CompilerOptions | undefined,
      host: ts.ParseConfigFileHost,
    ) =>
      ts.getParsedCommandLineOfConfigFile(path, extend, {
        ...host,
        readFile: (p: string) => virtual(p) ?? host.readFile(p),
      }),
  };
  const requireView = (id: string): unknown => {
    if (id === 'fs') return fsView;
    if (id === 'typescript') return tsView;
    if (resolve(id) === JEST_CONFIG) {
      const real: Record<string, unknown> = require(JEST_CONFIG);
      if (!m.jest) return real;
      const copy = { ...real };
      m.jest(copy);
      return copy;
    }
    return require(id);
  };

  const tests: Array<{ name: string; body: () => unknown }> = [];
  const code = ts.transpileModule(fs.readFileSync(GUARD, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  runInNewContext(code, {
    __dirname: join(ROOT, 'test', 'ci'),
    __filename: GUARD,
    exports: {},
    require: requireView,
    expect,
    describe: (_name: string, body: () => void) => body(),
    it: (name: string, body: () => unknown) => {
      tests.push({ name, body });
    },
  });

  const run: GuardRun = { executed: [], failures: [] };
  for (const t of tests) {
    if (t.name.startsWith('rejects: ')) continue;
    run.executed.push(t.name);
    try {
      await t.body();
    } catch (e) {
      const msg =
        e !== null && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);
      run.failures.push(`${t.name} :: ${msg.split('\n').slice(0, 12).join(' | ')}`);
    }
  }
  return run;
}

const STEP_CWD = (text: string) =>
  edit(
    text,
    '      - name: Type-check\n',
    '      - name: Type-check\n        working-directory: scripts/secrets\n',
  );
const JOB_DEFAULT_CWD = (text: string) =>
  edit(
    text,
    '  build-and-test:\n',
    '  build-and-test:\n    defaults:\n      run:\n        working-directory: scripts/secrets\n',
  );
const WORKFLOW_DEFAULT_CWD = (text: string) =>
  edit(text, '\njobs:\n', '\ndefaults:\n  run:\n    working-directory: scripts/secrets\n\njobs:\n');

const PROBES: Array<[string, Mutation]> = [
  [
    'Sol probe 1: Type-check step runs in scripts/secrets (narrow strict:false project)',
    { workflow: STEP_CWD },
  ],
  [
    'Sol probe 2: strictNullChecks:false while strict:true remains',
    { tsconfig: (c) => void (c.compilerOptions.strictNullChecks = false) },
  ],
  [
    'build-and-test job defaults move every run step to scripts/secrets',
    { workflow: JOB_DEFAULT_CWD },
  ],
  ['workflow defaults move every run step to scripts/secrets', { workflow: WORKFLOW_DEFAULT_CWD }],
  [
    'noImplicitAny:false while strict:true remains',
    { tsconfig: (c) => void (c.compilerOptions.noImplicitAny = false) },
  ],
  [
    'strictFunctionTypes:false while strict:true remains',
    { tsconfig: (c) => void (c.compilerOptions.strictFunctionTypes = false) },
  ],
  [
    'C-694-2: fractional numeric workerIdleMemoryLimit (0.9 of system RAM)',
    { jest: (c) => void (c.workerIdleMemoryLimit = 0.9) },
  ],
];

const CONTROLS: Array<[string, Mutation]> = [
  ['control: tsconfig excludes test/ci/**', { tsconfig: (c) => void c.exclude.push('test/ci/**') }],
  [
    'control: Type-check pointed at a narrower project with -p',
    {
      workflow: (t) =>
        edit(t, 'run: npx tsc --noEmit\n', 'run: npx tsc --noEmit -p scripts/secrets\n'),
    },
  ],
  [
    'control: percentage workerIdleMemoryLimit',
    { jest: (c) => void (c.workerIdleMemoryLimit = '90%') },
  ],
];

describe('type-gate guard, executed unchanged against mutated inputs (B-CI2-116)', () => {
  it('baseline: every guard assertion passes on the real inputs', async () => {
    const run = await runGuard({});
    expect(run.executed.length).toBeGreaterThanOrEqual(3);
    expect(run.failures).toEqual([]);
  });

  for (const [name, mutation] of [...PROBES, ...CONTROLS]) {
    it(`the guard fails on: ${name}`, async () => {
      const run = await runGuard(mutation);
      expect(run.executed.length).toBeGreaterThanOrEqual(3);
      expect(run.failures.length).toBeGreaterThan(0);
    });
  }
});
