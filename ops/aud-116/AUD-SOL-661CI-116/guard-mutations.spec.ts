import * as fs from 'fs';
import { join } from 'path';
import * as ts from 'typescript';
import { runInNewContext } from 'vm';

const ROOT = join(__dirname, '..', '..');
const CONFIG = join(ROOT, 'tsconfig.json');
const WORKFLOW = join(ROOT, '.github', 'workflows', 'ci.yml');
const GUARD = join(ROOT, 'test', 'ci', 'jest-typecheck-gate.spec.ts');

// Execute the candidate guard unchanged with read-only virtual input mutations.
// This avoids editing the candidate workflow or tsconfig, and invokes the real
// TypeScript config parser against the mutated text (not a fake file list).
function guardFailures(options: { cwd?: boolean; nullChecksOff?: boolean; excludeCi?: boolean } = {}) {
  const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  if (options.nullChecksOff) config.compilerOptions.strictNullChecks = false;
  if (options.excludeCi) config.exclude.push('test/ci/**');
  let workflow = fs.readFileSync(WORKFLOW, 'utf8');
  if (options.cwd) {
    workflow = workflow.replace(
      '      - name: Type-check\n',
      '      - name: Type-check\n        working-directory: scripts/secrets\n',
    );
  }
  const readFile = (path: string) =>
    path === CONFIG ? JSON.stringify(config) : ts.sys.readFile(path);
  const failures: string[] = [];
  let executed = 0;
  const code = ts.transpileModule(fs.readFileSync(GUARD, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  runInNewContext(code, {
    __dirname: join(ROOT, 'test', 'ci'),
    exports: {},
    require: (id: string) => {
      if (id === 'fs') {
        return {
          ...fs,
          readFileSync: (path: string, encoding: BufferEncoding) =>
            path === WORKFLOW ? workflow : fs.readFileSync(path, encoding),
        };
      }
      if (id === 'typescript') {
        return {
          ...ts,
          getParsedCommandLineOfConfigFile: (
            path: string,
            overrides: ts.CompilerOptions,
            host: ts.ParseConfigFileHost,
          ) => ts.getParsedCommandLineOfConfigFile(path, overrides, { ...host, readFile }),
        };
      }
      return require(id);
    },
    expect,
    describe: (_name: string, body: () => void) => body(),
    it: (name: string, body: () => void) => {
      executed++;
      try {
        body();
      } catch {
        failures.push(name);
      }
    },
  });
  expect(executed).toBe(3);
  return failures;
}

describe('independent Sol #694 guard-negative tests', () => {
  it('control: all three unchanged candidate guard assertions pass on candidate inputs', () => {
    expect(guardFailures()).toEqual([]);
  });

  it('control: the guard rejects exclusion of its own test/ci tree', () => {
    expect(guardFailures({ excludeCi: true }).length).toBeGreaterThan(0);
  });

  it('the guard must reject running the unchanged tsc command in an unrelated narrow project', () => {
    // scripts/secrets/tsconfig.json has its own narrow default include and
    // strict:false. It does not cover Jest specs, despite the command being identical.
    expect(guardFailures({ cwd: true }).length).toBeGreaterThan(0);
  });

  it('the guard must reject explicit strictNullChecks=false even when strict=true remains', () => {
    // Explicit strict-family false overrides strict:true; the new guard currently
    // checks the umbrella flag only, so its promised strict settings can disappear.
    expect(guardFailures({ nullChecksOff: true }).length).toBeGreaterThan(0);
  });
});
