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

describe('fly-deploy.yml — gate checks the same environment the deploy job binds to', () => {
  const yml = read('.github/workflows/fly-deploy.yml');
  it('REQUIRED_ENVIRONMENT equals deploy environment.name', () => {
    const gateEnv = /REQUIRED_ENVIRONMENT:\s*(\S+)/.exec(yml)?.[1];
    const deployEnv = /environment:\s*\n\s+name:\s*(\S+)/.exec(yml)?.[1];
    expect(gateEnv).toBe('production');
    expect(deployEnv).toBe(gateEnv);
  });
});

describe('codeql.yml — fail closed', () => {
  const yml = read('.github/workflows/codeql.yml');
  it('analyze step has no continue-on-error and no GHAS-state fallback step', () => {
    expect(yml).not.toMatch(/continue-on-error/);
    expect(yml).not.toMatch(/advanced_security/);
    expect(yml).not.toMatch(/\|\|\s*echo/);
    expect(yml).toMatch(/uses: github\/codeql-action\/analyze@3ea06614dafe36dec890db3446326e0d40ce53d4/);
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
  it('runs on pull requests to main and on main pushes (requirable pre-merge, verifiable post-merge)', () => {
    const on = yml.slice(yml.indexOf('\non:'), yml.indexOf('\npermissions:'));
    expect(on).toMatch(/pull_request:\s*\n\s+branches: \[main\]/);
    expect(on).toMatch(/push:\s*\n\s+branches: \[main\]/);
  });
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

// ---------------------------------------------------------------------------
// R2 additions (audit findings S2-A-02..07, S2-B1, B5, B6, B7, B9, B10, B11)
// ---------------------------------------------------------------------------

const PINNED = /uses:\s+\S+@[0-9a-f]{40}(\s|$)/;

describe('privileged action refs are pinned to full commit SHAs (S2-B1 / S2-A-07)', () => {
  const files = [
    '.github/workflows/fly-deploy.yml',
    '.github/workflows/sbom.yml',
    '.github/workflows/codeql.yml',
    '.github/workflows/fly-db-secrets-set.yml',
    '.github/workflows/fly-feature-flags-set.yml',
    '.github/workflows/fly-launch-env-set.yml',
    '.github/workflows/fly-recent-auth-set.yml',
    '.github/workflows/fly-secrets-set.yml',
    '.github/workflows/fly-logs.yml',
    '.github/workflows/fly-logs-dump.yml',
    '.github/workflows/fly-secrets-list.yml',
  ];
  for (const f of files) {
    it(`${f}: every uses: is a 40-hex pin (no @master / @vN)`, () => {
      const uses = read(f).split('\n').filter((l) => /^\s*-?\s*uses:/.test(l));
      expect(uses.length).toBeGreaterThan(0);
      for (const line of uses) expect(line).toMatch(PINNED);
    });
  }
  it('download-artifact and upload-artifact are the same major (v5)', () => {
    const yml = read('.github/workflows/fly-deploy.yml');
    expect(yml).toMatch(/actions\/download-artifact@634f93cb2916e3fdff6788551b99b062d0335ce0\s+# v5/);
    expect(yml).toMatch(/actions\/upload-artifact@330a01c490aca151604b8cf639adc76d48f6c5d4\s+# v5/);
  });
});

describe('fly-deploy.yml — recovery and migration evidence (S2-B6 / S2-B7 / S2-A-05 / S2-A-06)', () => {
  const yml = read('.github/workflows/fly-deploy.yml');
  const deploy = yml.slice(yml.indexOf('\n  deploy:'));
  const idx = (s: string) => {
    const i = deploy.indexOf(s);
    expect(i).toBeGreaterThan(-1);
    return i;
  };
  it('records running machines and computes the migration delta BEFORE flyctl deploy', () => {
    const before = idx('machines-before.json');
    const delta = idx('bash scripts/ci/migration-delta.sh');
    const dep = idx('flyctl deploy');
    expect(before).toBeLessThan(dep);
    expect(delta).toBeLessThan(dep);
    expect(deploy).toMatch(/fetch-depth: 0/);
  });
  it('only filtered machine data reaches the uploaded evidence', () => {
    expect(deploy).toMatch(/filter-machines\.sh "\$\{RUNNER_TEMP\}\/machines-before\.json" > release-evidence\/machines-before\.json/);
    expect(deploy).toMatch(/filter-machines\.sh "\$\{RUNNER_TEMP\}\/machines-after\.json" > release-evidence\/machines-after\.json/);
    expect(deploy).not.toMatch(/--json > release-evidence\//);
  });
  it('manifest artifact name and body carry the job result; deploy waits bounded', () => {
    expect(deploy).toMatch(/name: release-manifest-\$\{\{ needs\.evidence-gate\.outputs\.release_sha \}\}-\$\{\{ job\.status \}\}/);
    expect(deploy).toMatch(/\.deploy_result = \$r/);
    expect(deploy).toMatch(/--wait-timeout \d+m/);
  });
  it('migrations input exists and is only an acknowledgement string, not a default-on switch', () => {
    expect(yml).toMatch(/migrations:\s*\n\s+description:[^\n]*apply-migrations/);
    expect(yml).toMatch(/migrations:[\s\S]*?default: ''/);
  });
});

describe('production-mutating Fly operator workflows are bound to the production environment (S2-B10)', () => {
  for (const f of ['fly-db-secrets-set', 'fly-feature-flags-set', 'fly-launch-env-set', 'fly-recent-auth-set', 'fly-secrets-set']) {
    it(`${f}.yml has environment: production`, () => {
      expect(read(`.github/workflows/${f}.yml`)).toMatch(/^\s+environment: production$/m);
    });
  }
});

describe('Dockerfile — runtime residue (S2-B9)', () => {
  const df = read('Dockerfile');
  it('runtime stage drops root and disables scarf telemetry during install', () => {
    const runtime = df.slice(df.indexOf('AS runtime'));
    expect(runtime).toMatch(/^USER node$/m);
    expect(runtime.indexOf('USER node')).toBeLessThan(runtime.indexOf('CMD ['));
    expect(runtime).toMatch(/SCARF_ANALYTICS=false npm ci --omit=dev/);
  });
});

describe('setup-branch-protection.sh — explicit review-count decision and app-bound checks (S2-B3)', () => {
  const s = read('scripts/setup-branch-protection.sh');
  it('requires REQUIRED_APPROVING_REVIEW_COUNT and CHECKS_APP_ID, never app_id -1, lists build-sbom, no private path', () => {
    expect(s).toMatch(/\$\{REQUIRED_APPROVING_REVIEW_COUNT:\?/);
    expect(s).toMatch(/\$\{CHECKS_APP_ID:\?/);
    expect(s).not.toMatch(/app_id: -1/);
    expect(s).toContain('"build-sbom"');
    expect(s).not.toMatch(/execution\/s2-delivery/);
  });
});

describe('filter-machines.sh — evidence excludes raw machine config (S2-A-06)', () => {
  it('keeps id/state/image_ref/checks, drops config.env and services', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fm-'));
    const f = join(dir, 'm.json');
    writeFileSync(f, JSON.stringify([{
      id: 'm1', name: 'app-1', region: 'sjc', state: 'started', updated_at: 'x',
      image_ref: { registry: 'registry.fly.io', repository: 'app', tag: `sha-${SHA}`, digest: 'sha256:' + 'a'.repeat(64), labels: { GH_SHA: SHA } },
      config: { env: { SECRETISH: 'value' }, services: [{ internal_port: 3000 }], metadata: { fly_process_group: 'app' } },
      checks: [{ name: 'servicecheck-00-http-3000', status: 'passing', output: 'HTTP 200', updated_at: 'y' }],
    }]));
    const r = sh('filter-machines.sh', {}, [f]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out.trim());
    expect(out[0].image_ref.labels.GH_SHA).toBe(SHA);
    expect(out[0].process_group).toBe('app');
    expect(out[0].checks[0].status).toBe('passing');
    expect(JSON.stringify(out)).not.toMatch(/SECRETISH|internal_port|output/);
  });
});

describe('migration-delta.sh — release_command migrations need an explicit acknowledgement (S2-B7 / S2-A-05)', () => {
  const git = (cwd: string, args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  // repo: c1 (baseline) -> c2 (migration added) -> c3 (src only)
  const repo = mkdtempSync(join(tmpdir(), 'md-repo-'));
  git(repo, ['init', '-q', '-b', 'main']);
  writeFileSync(join(repo, 'a.txt'), '1');
  git(repo, ['add', '.']); git(repo, ['commit', '-q', '-m', 'c1']);
  const c1 = git(repo, ['rev-parse', 'HEAD']);
  spawnSync('mkdir', ['-p', join(repo, 'prisma', 'migrations', '20260920_x')]);
  writeFileSync(join(repo, 'prisma', 'migrations', '20260920_x', 'migration.sql'), 'ALTER TABLE t ADD c int;');
  git(repo, ['add', '.']); git(repo, ['commit', '-q', '-m', 'c2']);
  const c2 = git(repo, ['rev-parse', 'HEAD']);
  writeFileSync(join(repo, 'a.txt'), '2');
  git(repo, ['add', '.']); git(repo, ['commit', '-q', '-m', 'c3']);
  const c3 = git(repo, ['rev-parse', 'HEAD']);

  const machines = (label: string | undefined, state = 'started') => {
    const f = join(mkdtempSync(join(tmpdir(), 'md-m-')), 'm.json');
    writeFileSync(f, JSON.stringify([{ id: 'm', state, image_ref: { labels: label === undefined ? {} : { GH_SHA: label } }, config: { metadata: { fly_process_group: 'app' } } }]));
    return f;
  };
  const manifest = () => {
    const f = join(mkdtempSync(join(tmpdir(), 'md-mf-')), 'manifest.json');
    writeFileSync(f, JSON.stringify({ schema: 'tgp.release-evidence.v1' }));
    return f;
  };
  const run = (prev: string | undefined, release: string, ack = '') => {
    const mf = manifest();
    const r = spawnSync('bash', [join(ROOT, 'scripts', 'ci', 'migration-delta.sh')], {
      cwd: repo, encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp', MACHINES_JSON: machines(prev), RELEASE_SHA: release, MIGRATIONS_ACK: ack, MANIFEST: mf },
    });
    return { code: r.status, out: `${r.stdout}\n${r.stderr}`, manifest: JSON.parse(readFileSync(mf, 'utf8')) };
  };

  it('empty delta, no ack → pass and manifest records status empty', () => {
    const r = run(c2, c3);
    expect(r.code).toBe(0);
    expect(r.manifest.migrations.status).toBe('empty');
    expect(r.manifest.migrations.previous_running_sha).toBe(c2);
  });
  it('non-empty delta without ack → refused, names the files', () => {
    const r = run(c1, c3);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/Refused without migrations input 'apply-migrations'/);
    expect(r.out).toMatch(/prisma\/migrations\/20260920_x\/migration\.sql/);
  });
  it('non-empty delta with ack → pass, manifest lists files and acknowledged=true', () => {
    const r = run(c1, c3, 'apply-migrations');
    expect(r.code).toBe(0);
    expect(r.manifest.migrations.files).toEqual(['prisma/migrations/20260920_x/migration.sql']);
    expect(r.manifest.migrations.acknowledged).toBe(true);
  });
  it('empty delta with a stray ack → refused (the input must mean something)', () => {
    expect(run(c2, c3, 'apply-migrations').code).not.toBe(0);
  });
  it('wrong ack word is not an acknowledgement', () => {
    expect(run(c1, c3, 'yes').code).not.toBe(0);
  });
  it('running commit unknown (no GH_SHA label) → refused without ack, allowed with ack as status unknown', () => {
    expect(run(undefined, c3).out).toMatch(/cannot compute migration delta \(unknown: running GH_SHA label is 'unknown'\)/);
    const ok = run(undefined, c3, 'apply-migrations');
    expect(ok.code).toBe(0);
    expect(ok.manifest.migrations.status).toMatch(/^unknown/);
  });
  it('running commit not in this repository history → refused without ack', () => {
    const r = run('f'.repeat(40), c3);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/not in this repository's history/);
  });
  it('release sha not a commit here → refused', () => {
    expect(run(c1, '0'.repeat(40), 'apply-migrations').out).toMatch(/is not a commit in this checkout/);
  });
});
