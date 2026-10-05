// AUD-OPUS-FU1-118 lens probe (never merge): scripts/ci/assert-prod-sbom.sh must
// fail closed when a tool it relies on fails part-way (not only when an input
// is unreadable), and under descriptor exhaustion it must never print OK.
// Negative cases: a dev-only leak or a banned tool is present in the SBOM, and
// a jq / sort / comm failure must turn the gate red, never "0 dev-only leaks".

import { spawnSync } from 'child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'ci', 'assert-prod-sbom.sh');

const LOCK = {
  lockfileVersion: 3,
  packages: {
    '': { name: 'x', version: '1.0.0' },
    'node_modules/@nestjs/core': { version: '11.0.0' },
    'node_modules/@prisma/client': { version: '6.19.3' },
    'node_modules/prisma': { version: '6.19.3', devOptional: true },
    'node_modules/leftpad-devonly': { version: '1.0.0', dev: true },
  },
};
const RUNTIME = ['@nestjs/core@11.0.0', '@prisma/client@6.19.3', 'prisma@6.19.3'];
const sbom = (c: string[]) => ({
  bomFormat: 'CycloneDX',
  components: c.map((x) => {
    const at = x.lastIndexOf('@');
    return { name: x.slice(0, at), version: x.slice(at + 1) };
  }),
});
const OK = /assert-prod-sbom: OK \d+ components/;

function real(cmd: string): string {
  const r = spawnSync('bash', ['-c', `command -v ${cmd}`], { encoding: 'utf8' });
  return r.stdout.trim();
}

function files(doc: unknown, lock: unknown = LOCK): [string, string] {
  const d = mkdtempSync(join(tmpdir(), 'aud699-'));
  writeFileSync(join(d, 'sbom.cdx.json'), typeof doc === 'string' ? doc : JSON.stringify(doc));
  writeFileSync(join(d, 'package-lock.json'), typeof lock === 'string' ? lock : JSON.stringify(lock));
  return [join(d, 'sbom.cdx.json'), join(d, 'package-lock.json')];
}

/** A PATH dir holding one shim that replaces <cmd>. */
function shim(cmd: string, body: string): string {
  const d = mkdtempSync(join(tmpdir(), 'aud699-shim-'));
  writeFileSync(join(d, cmd), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(join(d, cmd), 0o755);
  return d;
}

function run(args: [string, string], pathPrefix?: string, ulimitN?: number) {
  const PATH = `${pathPrefix ? `${pathPrefix}:` : ''}${process.env.PATH ?? ''}`;
  const pre = ulimitN ? `ulimit -n ${ulimitN}; ` : '';
  const r = spawnSync('bash', ['-c', `${pre}bash "$0" "$1" "$2"`, SCRIPT, args[0], args[1]], {
    encoding: 'utf8',
    env: { PATH, HOME: process.env.HOME ?? '/tmp' },
  });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

const JQ = real('jq');
const SORT = real('sort');

describe('AUD-OPUS-FU1-118 #699 probe: tool failures fail closed', () => {
  it('controls: clean SBOM passes; leak and banned tool are red with their own reason', () => {
    const clean = run(files(sbom(RUNTIME)));
    expect(clean.out).toMatch(OK);
    expect(clean.code).toBe(0);
    const leak = run(files(sbom([...RUNTIME, 'leftpad-devonly@1.0.0'])));
    expect(leak.code).toBe(1);
    expect(leak.out).toMatch(/dev-only packages present in production SBOM: leftpad-devonly@1\.0\.0/);
    const tool = run(files(sbom([...RUNTIME, 'eslint@9.0.0'])));
    expect(tool.code).toBe(1);
    expect(tool.out).toMatch(/build\/test tool 'eslint'/);
  });

  it('jq dies part-way through the lockfile read (partial output, exit 5): red, never OK', () => {
    const dir = shim(
      'jq',
      `for a in "$@"; do if [[ "$a" == "--arg" ]]; then echo "zzz-partial@0"; exit 5; fi; done\nexec ${JQ} "$@"`,
    );
    const r = run(files(sbom([...RUNTIME, 'leftpad-devonly@1.0.0'])), dir);
    expect(r.out).not.toMatch(OK);
    expect(r.code).toBe(1);
  });

  it('comm fails with no output: red, never OK', () => {
    const dir = shim('comm', 'exit 1');
    const r = run(files(sbom([...RUNTIME, 'leftpad-devonly@1.0.0'])), dir);
    expect(r.out).not.toMatch(OK);
    expect(r.code).toBe(1);
  });

  it('sort fails after reading its input: red, never OK', () => {
    const dir = shim('sort', `${SORT} "$@" >/dev/null; exit 2`);
    const r = run(files(sbom([...RUNTIME, 'leftpad-devonly@1.0.0'])), dir);
    expect(r.out).not.toMatch(OK);
    expect(r.code).not.toBe(0);
  });

  it('jq fails on the component-name list with a banned tool present: red, never OK', () => {
    const dir = shim(
      'jq',
      `for a in "$@"; do if [[ "$a" == ".components[].name" ]]; then exit 5; fi; done\nexec ${JQ} "$@"`,
    );
    const r = run(files(sbom([...RUNTIME, 'eslint@9.0.0'])), dir);
    expect(r.out).not.toMatch(OK);
    expect(r.code).not.toBe(0);
  });

  it('a lockfile entry that is not an object (jq type error mid-stream): red, never OK', () => {
    const lock = { lockfileVersion: 3, packages: { ...LOCK.packages, 'node_modules/zz-bad': 'oops' } };
    const r = run(files(sbom([...RUNTIME, 'leftpad-devonly@1.0.0']), lock));
    expect(r.out).not.toMatch(OK);
    expect(r.code).toBe(1);
  });

  it('an SBOM component that is not an object: red, never OK', () => {
    const doc = { bomFormat: 'CycloneDX', components: [...sbom(RUNTIME).components, 'eslint'] };
    const r = run(files(doc));
    expect(r.out).not.toMatch(OK);
    expect(r.code).not.toBe(0);
  });

  it.each([4, 5, 6, 7, 8, 9, 10, 12, 16, 32])(
    'ulimit -n %i: a leak or a banned tool never reads as OK',
    (n) => {
      for (const c of ['leftpad-devonly@1.0.0', 'eslint@9.0.0']) {
        const r = run(files(sbom([...RUNTIME, c])), undefined, n);
        expect(r.out).not.toMatch(OK);
        expect(r.code).not.toBe(0);
      }
    },
  );
});
