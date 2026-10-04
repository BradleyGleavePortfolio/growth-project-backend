// B-CI-116: jest compiles specs TRANSPILE-ONLY (ts-jest isolatedModules), so
// the build-and-test job's "Type-check" step is the one type gate for every
// file jest can load. This spec pins the invariants that make that safe:
//
//   1. build-and-test runs `npx tsc --noEmit` (fail-closed, no
//      continue-on-error) BEFORE the step that runs the jest suite, in the
//      same required job.
//   2. tsconfig.json (the config that step uses) has every .ts file under
//      src/ and under every jest root (default and live-RLS configs, spec
//      files and their helpers included) in its program, so no file is
//      type-checked by ts-jest alone.
//   3. The ts-jest transform is transpile-only and the worker recycle limit
//      stays below the heap cap the Test step gives each worker, so the
//      "Jest worker ran out of memory" crash cannot come back by drift.
//
// Reads files only; never runs tsc, jest or any network call.

import { readdirSync, readFileSync, statSync } from 'fs';
import { load as parseYaml } from 'js-yaml';
import { isAbsolute, join, relative, sep } from 'path';
import * as ts from 'typescript';

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const posix = (abs: string) => relative(ROOT, abs).split(sep).join('/');

interface Step {
  name?: string;
  run?: string;
  env?: Record<string, string>;
  'continue-on-error'?: unknown;
  if?: unknown;
}

interface JestConfig {
  roots: string[];
  transform: Record<string, [string, { tsconfig: Record<string, unknown> }] | string>;
  workerIdleMemoryLimit?: string | number;
}

function buildAndTest(): { job: Record<string, unknown>; steps: Step[] } {
  const wf = parseYaml(read('.github/workflows/ci.yml')) as {
    jobs: Record<string, Record<string, unknown>>;
  };
  const job = wf.jobs['build-and-test'];
  if (!job) throw new Error('ci.yml has no build-and-test job');
  return { job, steps: job.steps as Step[] };
}

function walkTs(dirAbs: string, out: string[]): void {
  for (const name of readdirSync(dirAbs)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const abs = join(dirAbs, name);
    if (statSync(abs).isDirectory()) walkTs(abs, out);
    else if (name.endsWith('.ts')) out.push(abs);
  }
}

/** Same unit semantics as jest-config's stringToBytes for the forms used here. */
function bytes(limit: string | number): number {
  if (typeof limit === 'number') return limit;
  const m = /^(\d+(?:\.\d+)?)\s*(kb|k|kib|mb|m|mib|gb|g|gib)$/i.exec(limit.trim());
  if (!m) throw new Error(`unparseable workerIdleMemoryLimit: ${limit}`);
  const n = Number.parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  const scale: Record<string, number> = {
    kb: 1e3,
    k: 1e3,
    kib: 1024,
    mb: 1e6,
    m: 1e6,
    mib: 1024 ** 2,
    gb: 1e9,
    g: 1e9,
    gib: 1024 ** 3,
  };
  return n * scale[unit];
}

describe('jest transpile-only is safe: tsc --noEmit is the type gate (B-CI-116)', () => {
  it('build-and-test runs `npx tsc --noEmit` fail-closed before the jest suite', () => {
    const { job, steps } = buildAndTest();
    expect(job['continue-on-error']).toBeUndefined();
    const tsc = steps.findIndex((s) => (s.run ?? '').trim() === 'npx tsc --noEmit');
    const test = steps.findIndex((s) => /^npm test\b/.test((s.run ?? '').trim()));
    expect(tsc).toBeGreaterThanOrEqual(0);
    expect(test).toBeGreaterThanOrEqual(0);
    expect(tsc).toBeLessThan(test);
    expect(steps[tsc]['continue-on-error']).toBeUndefined();
    expect(steps[tsc].if).toBeUndefined();
    // Plain `tsc` reads tsconfig.json from the repo root: no -p override that
    // could point the gate at a narrower project.
    expect(steps[tsc].run).not.toMatch(/(^|\s)(-p|--project)(\s|=)/);
  });

  it('tsconfig.json type-checks every .ts file under src/ and every jest root', () => {
    const parsed = ts.getParsedCommandLineOfConfigFile(
      join(ROOT, 'tsconfig.json'),
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (d) => {
          throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
        },
      },
    );
    if (!parsed) throw new Error('tsconfig.json did not parse');
    expect(parsed.errors).toEqual([]);
    expect(parsed.options.noCheck).toBeFalsy();
    expect(parsed.options.strict).toBe(true);
    const inProgram = new Set(
      parsed.fileNames.map((f) => posix(isAbsolute(f) ? f : join(ROOT, f))),
    );

    const jestDefault = require(join(ROOT, 'jest.config.js')) as JestConfig;
    const dirs = new Set<string>(['src', 'test']);
    for (const r of jestDefault.roots) dirs.add(r.replace('<rootDir>/', ''));

    const files: string[] = [];
    for (const d of dirs) walkTs(join(ROOT, d), files);
    // Fixture trees are excluded from tsc on purpose; they must stay free of
    // .ts sources jest could load.
    const missing = files.map(posix).filter((f) => !inProgram.has(f));
    expect(missing).toEqual([]);
    // The walk really covered the suite (guards a vacuous pass).
    expect(files.filter((f) => f.endsWith('.spec.ts')).length).toBeGreaterThan(500);
  });

  it('ts-jest is transpile-only and the worker recycle limit sits below the Test step heap cap', () => {
    const cfg = require(join(ROOT, 'jest.config.js')) as JestConfig;
    const tsEntry = cfg.transform['^.+\\.ts$'];
    expect(Array.isArray(tsEntry)).toBe(true);
    const [transformer, opts] = tsEntry as [string, { tsconfig: Record<string, unknown> }];
    expect(transformer).toBe('ts-jest');
    expect(opts.tsconfig.isolatedModules).toBe(true);

    const { steps } = buildAndTest();
    const test = steps.find((s) => /^npm test\b/.test((s.run ?? '').trim()));
    const heap = /--max-old-space-size=(\d+)/.exec(test?.env?.NODE_OPTIONS ?? '');
    if (!heap) throw new Error('Test step sets no --max-old-space-size in NODE_OPTIONS');
    const capBytes = Number(heap[1]) * 1024 * 1024;

    const configured = cfg.workerIdleMemoryLimit;
    if (configured === undefined) throw new Error('jest.config.js sets no workerIdleMemoryLimit');
    const limit = bytes(configured);
    // Recycling only helps if a worker is restarted while it still has room
    // for the next file: keep at least a quarter of the cap free.
    expect(limit).toBeGreaterThan(0);
    expect(limit).toBeLessThanOrEqual(capBytes * 0.75);
  });
});
