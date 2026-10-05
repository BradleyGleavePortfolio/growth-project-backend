import { spawnSync } from 'child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';

const SCRIPT = join(__dirname, '../../scripts/ci/assert-prod-sbom.sh');
const NAMES = ['@nestjs/core', '@prisma/client', 'prisma'];

function fixture(extra: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'aud-sol-ci117-695-'));
  const bom = join(dir, 'bom.json');
  const lock = join(dir, 'lock.json');
  const output = join(dir, 'outputs.txt');
  writeFileSync(bom, JSON.stringify({
    bomFormat: 'CycloneDX',
    components: [...NAMES, ...extra].map((name) => ({ name, version: '1.0.0' })),
  }));
  writeFileSync(lock, '{"packages":{}}');
  return { dir, bom, lock, output };
}

function run(f: ReturnType<typeof fixture>, moreEnv: Record<string, string> = {}) {
  const result = spawnSync('bash', [SCRIPT, f.bom, f.lock], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? '/tmp',
      GITHUB_OUTPUT: f.output,
      ...moreEnv,
    },
  });
  expect(result.error).toBeUndefined();
  return { code: result.status, out: result.stdout + result.stderr };
}

describe('AUD-SOL-CI-117 independent SBOM predicate error and literal probes', () => {
  it('control: a clean document passes and binds output to exact artifact bytes', () => {
    const f = fixture();
    expect(run(f)).toMatchObject({ code: 0 });
    const hash = createHash('sha256').update(readFileSync(f.bom)).digest('hex');
    expect(readFileSync(f.output, 'utf8')).toBe(`components=3\nsha256=${hash}\n`);
  });

  for (const status of [2, 127, 141]) {
    it(`fails closed with a specific diagnostic for grep exit ${status}`, () => {
      const f = fixture();
      const fake = join(f.dir, 'grep');
      writeFileSync(fake, `#!/usr/bin/env bash\nexit ${status}\n`);
      chmodSync(fake, 0o755);
      const r = run(f, { PATH: `${f.dir}:${process.env.PATH ?? '/usr/bin:/bin'}` });
      expect(r.code).toBe(1);
      expect(r.out).toContain(`grep exited ${status} while checking 'jest'`);
      expect(r.out).not.toContain('assert-prod-sbom: OK');
    });
  }

  for (const name of ['-n', 'runtime[0].+']) {
    it(`treats the denylist sentinel ${name} as a literal whole name`, () => {
      const f = fixture([name]);
      const r = run(f, { DENY_LIST: name });
      expect(r.code).toBe(1);
      expect(r.out).toContain(`build/test tool '${name}' present in production SBOM`);
    });
  }

  it('does not confuse an unanchored or regex near-match with a required name', () => {
    const f = fixture(['runtimeX0YZZ', 'prefix-runtime[0].+-suffix']);
    const r = run(f, { REQUIRE_LIST: 'runtime[0].+' });
    expect(r.code).toBe(1);
    expect(r.out).toContain("required runtime package 'runtime[0].+' missing");
  });
});
