// Structural invariants of the delivery path (workflows, Dockerfile,
// .dockerignore) plus fixture-driven negatives for
// scripts/ci/verify-fly-release.sh and scripts/ci/assert-prod-sbom.sh.
// These guard the fail-closed properties that a later edit could quietly
// remove; they do not build an image or call GitHub/Fly.

import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const SHA = 'c23b9d9f3fcc106b92c061ceb7d04d7ec53038d7';

const sh = (script: string, env: Record<string, string>, args: string[] = []) => {
  const r = spawnSync('bash', [join(ROOT, 'scripts', 'ci', script), ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp', ...env },
  });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
};

describe('fly-deploy.yml — merge is not deployment', () => {
  const yml = read('.github/workflows/fly-deploy.yml');

  it('has no push / pull_request / schedule trigger; only workflow_dispatch with a required release_sha', () => {
    const on = yml.slice(yml.indexOf('\non:'), yml.indexOf('\npermissions:'));
    expect(on).toMatch(/workflow_dispatch:/);
    expect(on).not.toMatch(/^\s+push:/m);
    expect(on).not.toMatch(/pull_request/);
    expect(on).not.toMatch(/schedule/);
    expect(on).toMatch(/release_sha:[\s\S]*?required: true/);
  });

  it('deploy job needs the evidence gate, requires its success result and re-pins the sha', () => {
    const deploy = yml.slice(yml.indexOf('\n  deploy:'));
    expect(deploy).toMatch(/needs: evidence-gate/);
    expect(deploy).toMatch(/needs\.evidence-gate\.result == 'success'/);
    expect(deploy).toMatch(/needs\.evidence-gate\.outputs\.release_sha == github\.sha/);
    expect(deploy).toMatch(/environment:\s*\n\s+name: production/);
  });

  it('gate runs only from main, runs the committed gate script and has no continue-on-error / || true fallbacks', () => {
    expect(yml).toMatch(/if: github\.ref == 'refs\/heads\/main'/);
    expect(yml).toContain('bash scripts/ci/release-evidence-gate.sh');
    expect(yml).toContain('bash scripts/ci/verify-fly-release.sh');
    expect(yml).not.toMatch(/continue-on-error/);
    expect(yml).not.toMatch(/\|\|\s*(true|echo)/);
  });

  it('deploy passes the authorized sha as image label and build args (not GITHUB_SHA of some other ref)', () => {
    expect(yml).toMatch(/--image-label "sha-\$\{RELEASE_SHA\}"/);
    expect(yml).toMatch(/--build-arg RELEASE_VERSION="\$\{RELEASE_SHA\}"/);
    expect(yml).toMatch(/--build-arg GIT_SHA="\$\{RELEASE_SHA\}"/);
    expect(yml).not.toMatch(/RELEASE_VERSION="\$\{GITHUB_SHA\}"/);
  });
});

describe('codeql.yml — fail closed', () => {
  const yml = read('.github/workflows/codeql.yml');
  it('analyze step has no continue-on-error and no GHAS-state fallback step', () => {
    expect(yml).not.toMatch(/continue-on-error/);
    expect(yml).not.toMatch(/advanced_security/);
    expect(yml).not.toMatch(/\|\|\s*echo/);
    expect(yml).toMatch(/uses: github\/codeql-action\/analyze@v3/);
    expect(yml).toMatch(/security-events: write/);
  });
  it('still runs on PRs, pushes to main and a schedule', () => {
    expect(yml).toMatch(/pull_request:\s*\n\s+branches: \[main\]/);
    expect(yml).toMatch(/push:\s*\n\s+branches: \[main\]/);
    expect(yml).toMatch(/schedule:/);
  });
});

describe('sbom.yml — production closure, lifecycle-free install, proven artifact', () => {
  const yml = read('.github/workflows/sbom.yml');
  it('installs with --omit=dev --ignore-scripts (the lefthook prepare hook killed the old job)', () => {
    expect(yml).toMatch(/npm ci --omit=dev --ignore-scripts/);
  });
  it('generates with npm sbom from the installed tree (not --package-lock-only) and runs the proof before upload', () => {
    expect(yml).toMatch(/npm sbom --sbom-format cyclonedx/);
    expect(yml).not.toMatch(/package-lock-only/);
    expect(yml).not.toMatch(/cdxgen/);
    const prove = yml.indexOf('assert-prod-sbom.sh');
    const upload = yml.indexOf('actions/upload-artifact');
    expect(prove).toBeGreaterThan(0);
    expect(upload).toBeGreaterThan(prove);
    expect(yml).toMatch(/name: sbom-cyclonedx-\$\{\{ github\.sha \}\}/);
    expect(yml).toMatch(/if-no-files-found: error/);
  });
});

describe('r100-quality-gate.yml — generic volume quotas retired, concrete check kept', () => {
  const yml = read('.github/workflows/r100-quality-gate.yml');
  it('has only the banned-casts job', () => {
    const jobIds = [...yml.matchAll(/^  ([a-z0-9-]+):$/gm)].map((m) => m[1]);
    expect(jobIds).toEqual(['banned-casts']);
    // No waiver logic left in executable steps (the header may mention the retired markers historically).
    const jobsSection = yml.slice(yml.indexOf('\njobs:'));
    expect(jobsSection).not.toMatch(/LOC-EXEMPT|TEST-EXEMPT|LOC_LIMIT|RATIO_MIN/);
  });
});

describe('setup-branch-protection.sh — required check list matches current workflows', () => {
  const sh = read('scripts/setup-branch-protection.sh');
  const start = sh.indexOf('REQUIRED_CHECKS=(');
  const list = sh.slice(start, sh.indexOf('\n)\n', start));
  it('does not require retired checks and does require CodeQL', () => {
    expect(list).not.toMatch(/LOC budget|Test density/);
    expect(list).toContain('"CodeQL JS/TS (javascript-typescript)"');
    expect(list).toContain('"Banned cast tokens (R75 / R100.A2)"');
  });
  it('no longer recommends a second PAT as reviewer', () => {
    expect(sh).not.toMatch(/Current decision: option \(b\)/);
    expect(sh).toMatch(/NOT a reviewer/);
  });
});

describe('Dockerfile / .dockerignore — production artifact shape (structural only; no image built here)', () => {
  const df = read('Dockerfile');
  const di = read('.dockerignore');

  it('is multi-stage with a runtime stage that installs --omit=dev and copies dist from build', () => {
    expect(df).toMatch(/FROM node:20-slim AS build/);
    expect(df).toMatch(/FROM node:20-slim AS runtime/);
    const runtime = df.slice(df.indexOf('AS runtime'));
    expect(runtime).toMatch(/npm ci --omit=dev/);
    expect(runtime).toMatch(/COPY --from=build \/app\/dist \.\/dist/);
    expect(runtime).not.toMatch(/COPY \. \./);
    expect(runtime).toMatch(/CMD \["node", "dist\/main\.js"\]/);
  });

  it('runtime stage asserts prisma CLI present and dev tooling absent at build time', () => {
    const runtime = df.slice(df.indexOf('AS runtime'));
    expect(runtime).toMatch(/require\.resolve\(p\)/);
    expect(runtime).toContain("'prisma/package.json'");
    for (const tool of ['jest', '@nestjs/cli', 'eslint', 'lefthook', 'ts-node']) expect(runtime).toContain(tool);
    expect(runtime).toMatch(/test -f scripts\/release\.sh/);
    expect(runtime).toMatch(/test -f prisma\/seed-diagnostic\.json/);
  });

  it('does not bake NODE_ENV or secrets, keeps Sentry token as a build secret in the build stage only', () => {
    expect(df).not.toMatch(/ENV NODE_ENV/);
    expect(df).not.toMatch(/ENV SENTRY_AUTH_TOKEN/);
    const build = df.slice(0, df.indexOf('AS runtime'));
    expect(build).toMatch(/--mount=type=secret,id=sentry_auth_token/);
  });

  it('.dockerignore excludes VCS, CI, tests and docs from the build context', () => {
    for (const entry of ['.git/', '.github/', 'test/', 'docs/', 'node_modules/', 'dist/', '.env', 'lefthook.yml']) {
      expect(di.split('\n')).toContain(entry);
    }
    expect(di).not.toMatch(/^prisma\/?$/m);
    expect(di).not.toMatch(/^scripts\/?$/m);
  });
});

describe('verify-fly-release.sh — running machines must be the authorized image', () => {
  const machine = (o: Partial<{ id: string; state: string; tag: string; ghSha: string; digest: string; group: string }> = {}) => ({
    id: o.id ?? '860311cee0d008',
    state: o.state ?? 'started',
    region: 'sjc',
    config: { metadata: { fly_process_group: o.group ?? 'app' } },
    image_ref: {
      registry: 'registry.fly.io',
      repository: 'backend-spring-lake-3890',
      tag: o.tag ?? `sha-${SHA}`,
      digest: o.digest ?? 'sha256:5eed9e51368eb2645cc3bedb47eab34ef492fb3577027f0738327bd55f8c6c69',
      labels: { GH_SHA: o.ghSha ?? SHA, GH_REPO: 'BradleyGleavePortfolio/growth-project-backend' },
    },
  });
  const withMachines = (list: unknown[]) => {
    const f = join(mkdtempSync(join(tmpdir(), 'fly-')), 'machines.json');
    writeFileSync(f, JSON.stringify(list));
    return f;
  };
  const env = (f: string, extra: Record<string, string> = {}) => ({ MACHINES_JSON: f, RELEASE_SHA: SHA, IMAGE_LABEL: `sha-${SHA}`, ...extra });

  it('passes for a converged app and records the digest in the manifest', () => {
    const f = withMachines([machine(), machine({ id: 'e2' })]);
    const manifest = join(mkdtempSync(join(tmpdir(), 'man-')), 'm.json');
    writeFileSync(manifest, JSON.stringify({ image: null }));
    const r = sh('verify-fly-release.sh', env(f, { MANIFEST: manifest }));
    expect(r.out).toContain('OK 2 machine(s)');
    expect(r.code).toBe(0);
    const m = JSON.parse(readFileSync(manifest, 'utf8'));
    expect(m.image.digest).toMatch(/^sha256:/);
    expect(m.image.tag).toBe(`sha-${SHA}`);
    expect(m.image.machines).toHaveLength(2);
  });
  it('fails when a machine still runs the previous image tag', () => {
    const r = sh('verify-fly-release.sh', env(withMachines([machine(), machine({ id: 'old', tag: 'deployment-01KY69AH7K7RH6KTW6QKEHRXCE', ghSha: '5076a07a1e54b14e3db84d3aa128fb0bb44542d7' })])));
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/not running the authorized image/);
  });
  it('fails when the image label GH_SHA does not match the release sha', () => {
    const r = sh('verify-fly-release.sh', env(withMachines([machine({ ghSha: '5076a07a1e54b14e3db84d3aa128fb0bb44542d7' })])));
    expect(r.code).not.toBe(0);
  });
  it('fails when no machine is started', () => {
    const r = sh('verify-fly-release.sh', env(withMachines([machine({ state: 'stopped' })])));
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/no started machines/);
  });
  it('fails when started machines run two different digests', () => {
    const r = sh('verify-fly-release.sh', env(withMachines([machine(), machine({ id: 'b', digest: 'sha256:' + 'a'.repeat(64) })])));
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/distinct image digests/);
  });
  it('fails on malformed or missing digest', () => {
    const r = sh('verify-fly-release.sh', env(withMachines([machine({ digest: '' })])));
    expect(r.code).not.toBe(0);
  });
  it('fails on non-array input', () => {
    const f = withMachines([]);
    writeFileSync(f, '{"error":"unauthorized"}');
    expect(sh('verify-fly-release.sh', env(f)).code).not.toBe(0);
  });
});

describe('assert-prod-sbom.sh — production dependency proof', () => {
  const lock = {
    packages: {
      '': { name: 'x', version: '1.0.0' },
      'node_modules/@nestjs/core': { version: '11.0.0' },
      'node_modules/@prisma/client': { version: '6.19.3' },
      'node_modules/prisma': { version: '6.19.3', devOptional: true },
      'node_modules/typescript': { version: '5.9.0', devOptional: true },
      'node_modules/jest': { version: '30.0.0', dev: true },
      'node_modules/@nestjs/cli': { version: '11.0.0', dev: true },
      'node_modules/some-dev-only-lib': { version: '2.0.0', dev: true },
    },
  };
  const good = ['@nestjs/core@11.0.0', '@prisma/client@6.19.3', 'prisma@6.19.3', 'typescript@5.9.0'];
  const sbom = (comps: string[], bomFormat = 'CycloneDX') => ({
    bomFormat,
    components: comps.map((c) => {
      const at = c.lastIndexOf('@');
      return { name: c.slice(0, at), version: c.slice(at + 1) };
    }),
  });
  const files = (doc: unknown) => {
    const d = mkdtempSync(join(tmpdir(), 'sbom-'));
    writeFileSync(join(d, 'sbom.cdx.json'), JSON.stringify(doc));
    writeFileSync(join(d, 'package-lock.json'), JSON.stringify(lock));
    return [join(d, 'sbom.cdx.json'), join(d, 'package-lock.json')];
  };

  it('passes for the production closure including the dev-optional prisma CLI', () => {
    const r = sh('assert-prod-sbom.sh', {}, files(sbom(good)));
    expect(r.out).toMatch(/OK 4 components/);
    expect(r.out).toMatch(/sha256 [0-9a-f]{64}/);
    expect(r.code).toBe(0);
  });
  it('fails when a lockfile dev-only package leaks in (name@version match)', () => {
    const r = sh('assert-prod-sbom.sh', {}, files(sbom([...good, 'some-dev-only-lib@2.0.0'])));
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/dev-only packages present.*some-dev-only-lib@2\.0\.0/);
  });
  it('fails when an explicit build/test tool is present even if the lockfile mis-flags it', () => {
    const r = sh('assert-prod-sbom.sh', {}, files(sbom([...good, 'eslint@9.0.0'])));
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/build\/test tool 'eslint'/);
  });
  it('fails when the prisma CLI (release_command dependency) is missing', () => {
    const r = sh('assert-prod-sbom.sh', {}, files(sbom(good.filter((c) => !c.startsWith('prisma@')))));
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/required runtime package 'prisma' missing/);
  });
  it('fails on zero components or a non-CycloneDX document', () => {
    expect(sh('assert-prod-sbom.sh', {}, files(sbom([]))).code).not.toBe(0);
    expect(sh('assert-prod-sbom.sh', {}, files(sbom(good, 'SPDX'))).code).not.toBe(0);
  });
});
