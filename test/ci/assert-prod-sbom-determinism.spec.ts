// B-CI2-116: scripts/ci/assert-prod-sbom.sh must decide every denylist and
// require-list check the same way on every run.
//
// Root cause (found by AUD-OPUS-R12-116 on #679, run 37151675007 attempt 1):
// under `set -o pipefail` both checks were
//   printf '%s\n' "$NAMES" | grep -qxF "$name"
// grep -q exits at the first matching line. If printf has not finished
// writing by then it is killed by SIGPIPE (status 141), pipefail makes the
// whole pipeline fail, and a name that IS in the SBOM reads as absent: a
// banned build tool passes the denylist (fail-open), and a present runtime
// package is reported missing. A small SBOM loses that race in a few runs per
// hundred; an SBOM bigger than the 64 KiB pipe buffer loses it on every run,
// because printf is still blocked on the full pipe when grep exits.
//
// Both shapes are exercised here: hundreds of runs of a small SBOM, and an
// SBOM padded past the pipe buffer with runtime names that sort after every
// checked name. Each run must give the same, correct verdict.

import { spawn } from 'child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'ci', 'assert-prod-sbom.sh');
const SCRIPT_TEXT = readFileSync(SCRIPT, 'utf8');

/** The script's own default list, so this spec follows any later edit to it. */
function defaultList(name: string): string[] {
  const m = new RegExp(`^${name}="\\$\\{${name}:-([^}]*)\\}"$`, 'm').exec(SCRIPT_TEXT);
  if (!m) throw new Error(`assert-prod-sbom.sh has no default ${name}`);
  return m[1].split(/\s+/).filter(Boolean);
}
const DENY = defaultList('DENY_LIST');
const REQUIRE = defaultList('REQUIRE_LIST');

const LOCK = {
  packages: {
    '': { name: 'x', version: '1.0.0' },
    'node_modules/@nestjs/core': { version: '11.0.0' },
    'node_modules/@prisma/client': { version: '6.19.3' },
    'node_modules/prisma': { version: '6.19.3', devOptional: true },
    'node_modules/typescript': { version: '5.9.0', devOptional: true },
    'node_modules/jest': { version: '30.0.0', dev: true },
  },
};
const RUNTIME = [
  '@nestjs/core@11.0.0',
  '@prisma/client@6.19.3',
  'prisma@6.19.3',
  'typescript@5.9.0',
];
/** About 140 KB of names, all sorting after every denylisted and required name. */
const PADDING = Array.from(
  { length: 6000 },
  (_, i) => `zz-runtime-padding-${String(i).padStart(5, '0')}@1.0.0`,
);
/** Not in LOCK, so the dev-only leak check cannot catch it first: only the denylist can. */
const TOOL_VERSION = '99.0.0';
const SMALL_RUNS = 200;
const LARGE_RUNS = 3;
const CONCURRENCY = 6;

function fixture(components: string[]): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'sbom-determinism-'));
  const bom = {
    bomFormat: 'CycloneDX',
    components: components.map((c) => {
      const at = c.lastIndexOf('@');
      return { name: c.slice(0, at), version: c.slice(at + 1) };
    }),
  };
  writeFileSync(join(dir, 'sbom.cdx.json'), JSON.stringify(bom));
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(LOCK));
  return [join(dir, 'sbom.cdx.json'), join(dir, 'package-lock.json')];
}

interface Run {
  code: number | null;
  out: string;
}

function runOnce(args: string[]): Promise<Run> {
  return new Promise((done) => {
    const child = spawn('bash', [SCRIPT, ...args], {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp' },
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', (e) => done({ code: null, out: `spawn failed: ${e.message}` }));
    child.on('close', (code) => done({ code, out }));
  });
}

async function runMany(args: string[], times: number): Promise<Run[]> {
  const runs: Run[] = [];
  while (runs.length < times) {
    const batch = Math.min(CONCURRENCY, times - runs.length);
    runs.push(...(await Promise.all(Array.from({ length: batch }, () => runOnce(args)))));
  }
  return runs;
}

/** Every run that did not give the expected verdict, with its first output line. */
function wrong(runs: Run[], code: number, pattern: RegExp) {
  return runs
    .map((r, run) => ({
      run,
      code: r.code,
      first: r.out.trim().split('\n')[0] ?? '',
      ok: r.code === code && pattern.test(r.out),
    }))
    .filter((r) => !r.ok)
    .map(({ run, code: got, first }) => ({ run, code: got, first }));
}

const TOOL_FOUND = (tool: string) =>
  new RegExp(
    `build/test tool '${tool.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}' present in production SBOM`,
  );
const PASSED =
  /assert-prod-sbom: OK \d+ components, 0 dev-only leaks, required runtime packages present/;

describe('assert-prod-sbom.sh gives the same verdict on every run (B-CI2-116)', () => {
  it('reads its default deny and require lists', () => {
    expect(DENY).toEqual(expect.arrayContaining(['eslint', 'jest', 'ts-jest', '@nestjs/cli']));
    expect(REQUIRE).toEqual(['@nestjs/core', '@prisma/client', 'prisma']);
  });

  it(`fails on a banned build tool in every one of ${SMALL_RUNS} runs (small SBOM)`, async () => {
    const runs = await runMany(fixture([...RUNTIME, `eslint@${TOOL_VERSION}`]), SMALL_RUNS);
    expect(wrong(runs, 1, TOOL_FOUND('eslint'))).toEqual([]);
  }, 180_000);

  it(`passes a clean SBOM in every one of ${SMALL_RUNS} runs (small SBOM)`, async () => {
    const runs = await runMany(fixture(RUNTIME), SMALL_RUNS);
    expect(wrong(runs, 0, PASSED)).toEqual([]);
  }, 180_000);

  describe('SBOM larger than the pipe buffer: grep -q exits while the writer is still blocked', () => {
    for (const tool of DENY) {
      it(`fails on ${tool} in every run`, async () => {
        const runs = await runMany(
          fixture([...RUNTIME, `${tool}@${TOOL_VERSION}`, ...PADDING]),
          LARGE_RUNS,
        );
        expect(wrong(runs, 1, TOOL_FOUND(tool))).toEqual([]);
      }, 60_000);
    }

    it('passes a clean SBOM in every run (every required package found)', async () => {
      const runs = await runMany(fixture([...RUNTIME, ...PADDING]), LARGE_RUNS);
      expect(wrong(runs, 0, PASSED)).toEqual([]);
    }, 60_000);

    for (const pkg of REQUIRE) {
      it(`still fails when ${pkg} is really missing`, async () => {
        const runs = await runMany(
          fixture([...RUNTIME.filter((c) => !c.startsWith(`${pkg}@`)), ...PADDING]),
          LARGE_RUNS,
        );
        expect(
          wrong(
            runs,
            1,
            new RegExp(`required runtime package '${pkg.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}' missing`),
          ),
        ).toEqual([]);
      }, 60_000);
    }
  });
});
