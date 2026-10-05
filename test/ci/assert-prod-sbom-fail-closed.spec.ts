// B-CIQ-117 (C-695-1, C-695-2 from the #695 Opus verdict): the production
// SBOM check in scripts/ci/assert-prod-sbom.sh must fail closed.
//
// C-695-1: the dev-only check read the lockfile inside process substitutions
// whose exit status nothing checked, and both `comm` calls ended in
// `|| true`. A lockfile jq cannot read (not JSON, or a v1 lockfile with no
// `packages` map) made the dev-only list empty, and the script printed
// "OK ... 0 dev-only leaks" for evidence it never computed.
//
// C-695-2: has_name fed grep a here-string. When bash cannot create the
// here-string (no free file descriptor, no temp file), the command exits 1,
// the same status as "no match", so a banned tool in the SBOM read as absent.
//
// Every case below names the reason the script must give.

import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'ci', 'assert-prod-sbom.sh');
const SCRIPT_TEXT = readFileSync(SCRIPT, 'utf8');

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
/** A dev-only package (per LOCK) inside the SBOM: only check 2 can catch it. */
const LEAK = 'leftpad-devonly@1.0.0';

interface Run {
  code: number | null;
  out: string;
}

function sbom(components: string[]) {
  return {
    bomFormat: 'CycloneDX',
    components: components.map((c) => {
      const at = c.lastIndexOf('@');
      return { name: c.slice(0, at), version: c.slice(at + 1) };
    }),
  };
}

/** Runs the script on an SBOM and a lockfile given as raw file text. */
function run(sbomText: string, lockText: string): Run {
  const dir = mkdtempSync(join(tmpdir(), 'sbom-fail-closed-'));
  writeFileSync(join(dir, 'sbom.cdx.json'), sbomText);
  writeFileSync(join(dir, 'package-lock.json'), lockText);
  const r = spawnSync(
    'bash',
    [SCRIPT, join(dir, 'sbom.cdx.json'), join(dir, 'package-lock.json')],
    {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp' },
    },
  );
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

const OK = /assert-prod-sbom: OK \d+ components, 0 dev-only leaks/;

describe('assert-prod-sbom.sh fails closed on a lockfile it cannot read (C-695-1)', () => {
  it('control: a readable lockfile catches the dev-only package', () => {
    const r = run(JSON.stringify(sbom([...RUNTIME, LEAK])), JSON.stringify(LOCK));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/dev-only packages present in production SBOM: leftpad-devonly@1\.0\.0/);
  });

  it('control: a readable lockfile and a clean SBOM pass', () => {
    const r = run(JSON.stringify(sbom(RUNTIME)), JSON.stringify(LOCK));
    expect(r.out).toMatch(OK);
    expect(r.code).toBe(0);
  });

  it('a lockfile that is not valid JSON fails with that reason, never "0 dev-only leaks"', () => {
    const r = run(JSON.stringify(sbom([...RUNTIME, LEAK])), '{"packages": {');
    expect(r.out).not.toMatch(OK);
    expect(r.out).toMatch(/lockfile .*package-lock\.json is not valid JSON/);
    expect(r.code).toBe(1);
  });

  it('a v1 lockfile without a packages map fails with that reason', () => {
    const v1 = {
      lockfileVersion: 1,
      dependencies: { 'leftpad-devonly': { version: '1.0.0', dev: true } },
    };
    const r = run(JSON.stringify(sbom([...RUNTIME, LEAK])), JSON.stringify(v1));
    expect(r.out).not.toMatch(OK);
    expect(r.out).toMatch(/lockfile .*package-lock\.json has no "packages" map/);
    expect(r.code).toBe(1);
  });

  it('a packages map that is not an object fails with the same reason', () => {
    const r = run(JSON.stringify(sbom(RUNTIME)), JSON.stringify({ packages: ['node_modules/x'] }));
    expect(r.out).not.toMatch(OK);
    expect(r.out).toMatch(/has no "packages" map/);
    expect(r.code).toBe(1);
  });

  it('a lockfile that lists no production package fails: there is nothing to compare against', () => {
    const empty = { lockfileVersion: 3, packages: { '': { name: 'x', version: '1.0.0' } } };
    const r = run(JSON.stringify(sbom(RUNTIME)), JSON.stringify(empty));
    expect(r.out).not.toMatch(OK);
    expect(r.out).toMatch(/lockfile .*package-lock\.json lists no production packages/);
    expect(r.code).toBe(1);
  });

  it('an SBOM whose components are not a list fails with that reason', () => {
    const r = run(
      JSON.stringify({ bomFormat: 'CycloneDX', components: 'abc' }),
      JSON.stringify(LOCK),
    );
    expect(r.out).not.toMatch(OK);
    expect(r.out).toMatch(/components is not a list/);
    expect(r.code).toBe(1);
  });
});

describe('assert-prod-sbom.sh name check needs no file descriptor (C-695-2)', () => {
  /** The script's own has_name function, verbatim. */
  function scriptFunction(name: string): string {
    const m = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}$`, 'm').exec(SCRIPT_TEXT);
    if (!m) throw new Error(`assert-prod-sbom.sh has no ${name}()`);
    return m[0];
  }

  /**
   * Runs has_name in a shell whose descriptor limit leaves no free slot, so
   * any here-string, pipe or temp file the check needs cannot be created.
   */
  function hasNameWithoutFreeDescriptor(names: string[], name: string): Run {
    const program = [
      'set -Eeuo pipefail',
      'fail() { echo "::error::assert-prod-sbom: $*" >&2; exit 1; }',
      `NAMES=$(printf '%s\\n' ${names.map((n) => `'${n}'`).join(' ')})`,
      scriptFunction('has_name'),
      'ulimit -n 3',
      `if has_name '${name}'; then echo PRESENT; else echo ABSENT; fi`,
    ].join('\n');
    const r = spawnSync('bash', ['-c', program], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp' },
    });
    return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
  }

  const NAMES = ['@nestjs/core', '@prisma/client', 'eslint', 'prisma'];

  it('a banned tool in the SBOM reads as present', () => {
    const r = hasNameWithoutFreeDescriptor(NAMES, 'eslint');
    expect(r.out).toMatch(/^PRESENT$/m);
    expect(r.out).not.toMatch(/cannot create|Too many open files/);
    expect(r.code).toBe(0);
  });

  it('a name that is not in the SBOM reads as absent', () => {
    expect(hasNameWithoutFreeDescriptor(NAMES, 'jest').out).toMatch(/^ABSENT$/m);
  });

  it('matches whole names only, literally', () => {
    expect(hasNameWithoutFreeDescriptor(NAMES, 'nestjs/core').out).toMatch(/^ABSENT$/m);
    expect(hasNameWithoutFreeDescriptor(NAMES, '@prisma/*').out).toMatch(/^ABSENT$/m);
    expect(hasNameWithoutFreeDescriptor(NAMES, 'prisma').out).toMatch(/^PRESENT$/m);
  });
});
