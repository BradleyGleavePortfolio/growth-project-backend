// HOUSE-SEED-134 (B14): the house-seed operator workflow, the compiled copy of
// the seed scripts it runs inside the Fly machine, and the production guard on
// the committed, owner-approved fixture (decision 133-2). Structural checks
// plus one real compile + run of the compiled script; no GitHub, Fly or DB.

import { spawnSync } from 'child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'fs';
import { createHash } from 'crypto';
import { load as parseYaml } from 'js-yaml';
import { tmpdir } from 'os';
import { dirname, join, relative } from 'path';
import * as ts from 'typescript';
import { parseFixture } from '../../src/onboarding/clinic-programs';
import { assertSeedAllowed } from '../../scripts/seed-clinic-programs';

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const FIXTURE = 'seed/clinic-programs.v1.json';
const COACH = '0b6f2f0e-6a4f-4f57-9a43-2f1c3c7e9d11';

interface Step {
  name?: string;
  run?: string;
  uses?: string;
  if?: string;
  env?: Record<string, string>;
}
interface Input {
  required?: boolean;
  default?: string;
  type?: string;
  options?: string[];
}
interface Workflow {
  on: { workflow_dispatch: { inputs: Record<string, Input> } };
  jobs: Record<string, { if?: string; environment?: string; steps: Step[] }>;
}

const raw = read('.github/workflows/house-seed.yml');
const wf = parseYaml(raw) as Workflow;
const job = wf.jobs['house-seed'];
const step = (name: string): Step => {
  const s = job.steps.find((x) => x.name === name);
  if (!s) throw new Error(`missing step ${name}`);
  return s;
};

describe('house-seed.yml — operator only, production-gated, inputs are data', () => {
  it('is workflow_dispatch only with mode (dry-run | apply), coach_id and exercise_catalog', () => {
    expect(Object.keys(wf.on)).toEqual(['workflow_dispatch']);
    const inputs = wf.on.workflow_dispatch.inputs;
    expect(inputs.mode).toMatchObject({ required: true, default: 'dry-run', options: ['dry-run', 'apply'] });
    expect(inputs.coach_id).toMatchObject({ required: true, type: 'string' });
    expect(inputs.exercise_catalog).toMatchObject({ default: 'skip', options: ['skip', 'upsert'] });
  });

  it('runs only from main, inside the production environment (required reviewers gate it)', () => {
    expect(job.if).toBe("github.ref == 'refs/heads/main'");
    expect(job.environment).toBe('production');
  });

  it('no run block interpolates expressions; every action is pinned to a 40-hex sha', () => {
    for (const s of job.steps) {
      if (s.run) expect(s.run).not.toMatch(/\$\{\{/);
      if (s.uses) expect(s.uses).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it('needs no new secret: FLY_API_TOKEN only, and no step handles a database URL', () => {
    const secrets = new Set(raw.match(/secrets\.[A-Z_]+/g));
    expect([...secrets]).toEqual(['secrets.FLY_API_TOKEN']);
    for (const s of job.steps) {
      expect(JSON.stringify(s.env ?? {})).not.toMatch(/DATABASE_URL|DIRECT_URL/);
      expect(s.run ?? '').not.toMatch(/DATABASE_URL|DIRECT_URL|printenv/);
    }
  });

  it('rejects an email or junk coach_id and an unknown mode before anything else runs', () => {
    const run = (env: Record<string, string>) =>
      spawnSync('bash', ['-c', step('Validate inputs').run ?? 'exit 99'], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', ...env },
      }).status;
    expect(run({ MODE: 'dry-run', CATALOG: 'skip', COACH_ID: COACH })).toBe(0);
    expect(run({ MODE: 'apply', CATALOG: 'upsert', COACH_ID: COACH })).toBe(0);
    expect(run({ MODE: 'dry-run', CATALOG: 'skip', COACH_ID: 'owner@example.com' })).toBe(1);
    expect(run({ MODE: 'dry-run', CATALOG: 'skip', COACH_ID: `${COACH} --apply` })).toBe(1);
    expect(run({ MODE: 'wipe', CATALOG: 'skip', COACH_ID: COACH })).toBe(1);
    expect(run({ MODE: 'apply', CATALOG: 'all', COACH_ID: COACH })).toBe(1);
  });

  it('computes the approval from the committed fixture and passes it to the house seed', () => {
    const approval = step('Compute the approval from main\'s committed fixture').run ?? '';
    expect(approval).toContain(`f=${FIXTURE}`);
    expect(approval).toContain('sha256sum "${f}"');
    expect(approval).toContain('approved=${version}:${sha}');
    const seed = step('Run the house seed inside the machine');
    expect(seed.env?.APPROVED).toBe('${{ steps.approval.outputs.approved }}');
    expect(seed.run).toContain('CLINIC_SEED_TARGET=production');
    expect(seed.run).toContain('CLINIC_PROGRAMS_SEED_APPROVED=${APPROVED}');
    expect(seed.run).toContain('CLINIC_OWNER_COACH_ID=${COACH_ID}');
    expect(seed.run).toMatch(/flags="--house"\n\s*if \[ "\$\{MODE\}" = "dry-run" \]; then flags="--house --dry-run"; fi/);
  });

  it('stops before the seed when the running image lacks main\'s fixture; catalog upsert is apply-only', () => {
    const names = job.steps.map((s) => s.name);
    const check = names.indexOf('Check the running image carries the same fixture');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(names.indexOf('Run the house seed inside the machine'));
    expect(check).toBeLessThan(names.indexOf('Upsert the exercise catalog (apply + upsert only)'));
    expect(step('Upsert the exercise catalog (apply + upsert only)').if).toBe(
      "inputs.mode == 'apply' && inputs.exercise_catalog == 'upsert'",
    );
  });
});

describe('compiled copy — the paths the workflow runs exist in the build output', () => {
  const cfgPath = join(ROOT, 'tsconfig.house-seed.json');
  const { config, error } = ts.readConfigFile(cfgPath, (p) => ts.sys.readFile(p));
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, ROOT, undefined, cfgPath);
  const jsOut = (src: string) =>
    relative(
      ROOT,
      ts.getOutputFileNames(parsed, join(ROOT, src), false).find((f) => f.endsWith('.js')) ?? '',
    );
  const df = read('Dockerfile');
  const build = df.slice(0, df.indexOf('AS runtime'));
  const runtime = df.slice(df.indexOf('AS runtime'));

  it('tsconfig.house-seed.json emits both scripts under dist/house-seed/scripts/', () => {
    expect(error).toBeUndefined();
    expect(parsed.errors).toEqual([]);
    expect(jsOut('scripts/seed-clinic-programs.ts')).toBe('dist/house-seed/scripts/seed-clinic-programs.js');
    expect(jsOut('scripts/seed-exercise-catalog.ts')).toBe('dist/house-seed/scripts/seed-exercise-catalog.js');
  });

  it('the workflow, the Dockerfile build stage and the runtime artifact check name the same files', () => {
    const seedJs = jsOut('scripts/seed-clinic-programs.ts');
    const catalogJs = jsOut('scripts/seed-exercise-catalog.ts');
    // main() reads join(__dirname, '..', 'seed', 'clinic-programs.v1.json') next to the compiled script.
    const fixtureOut = join(dirname(seedJs), '..', 'seed', 'clinic-programs.v1.json');
    expect(fixtureOut).toBe('dist/house-seed/seed/clinic-programs.v1.json');
    for (const p of [seedJs, catalogJs, fixtureOut]) {
      expect(raw).toContain(`/app/${p}`); // runtime WORKDIR is /app
      expect(runtime).toContain(`test -f ${p}`);
    }
    expect(build.indexOf('npx tsc -p tsconfig.house-seed.json')).toBeGreaterThan(build.indexOf('RUN npm run build'));
    expect(build).toContain(`cp ${FIXTURE} ${fixtureOut}`);
    expect(runtime).toMatch(/COPY --from=build \/app\/dist \.\/dist/);
    expect(read('.dockerignore').split('\n')).not.toContain('seed/');
  });

  it('compiles, and the compiled script refuses production without the exact approval (seen in a test)', () => {
    const out = mkdtempSync(join(tmpdir(), 'house-seed-'));
    const program = ts.createProgram(parsed.fileNames, { ...parsed.options, outDir: out });
    const emitted = program.emit();
    expect(emitted.emitSkipped).toBe(false);
    expect(ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
    mkdirSync(join(out, 'seed'));
    copyFileSync(join(ROOT, FIXTURE), join(out, 'seed', 'clinic-programs.v1.json'));
    const runSeed = (approved?: string) =>
      spawnSync(process.execPath, [join(out, 'scripts', 'seed-clinic-programs.js'), '--house', '--dry-run'], {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH ?? '',
          NODE_PATH: join(ROOT, 'node_modules'),
          CLINIC_SEED_TARGET: 'production',
          CLINIC_OWNER_COACH_ID: COACH,
          ...(approved ? { CLINIC_PROGRAMS_SEED_APPROVED: approved } : {}),
        },
      });
    const sha = createHash('sha256').update(readFileSync(join(ROOT, FIXTURE))).digest('hex');
    for (const r of [runSeed(), runSeed('clinic-programs.v1:0000'), runSeed(`clinic-programs.v0:${sha}`)]) {
      expect(r.status).toBe(1);
      expect(r.stdout).toBe('');
      expect(r.stderr).toContain('Refusing to seed production');
    }
    // With the exact approval it gets past the guard (and then stops: no database here).
    const ok = runSeed(`clinic-programs.v1:${sha}`);
    expect(ok.stderr).not.toContain('Refusing to seed production');
  }, 120_000);
});

describe('production guard on the committed, owner-approved fixture (decision 133-2)', () => {
  const text = read(FIXTURE);
  const fx = parseFixture(text);
  // What the workflow computes: sha256sum of the file bytes.
  const fileSha = createHash('sha256').update(readFileSync(join(ROOT, FIXTURE))).digest('hex');

  it('is approved and authorized, and the workflow hash equals the hash the guard checks', () => {
    expect(fx.approval_status).toBe('approved');
    expect(fx.production_seed_authorized).toBe(true);
    expect(fx.sha256).toBe(fileSha);
  });

  it('still refuses production without the approval hash, with a wrong one, or with the draft hash', () => {
    const draftSha = createHash('sha256')
      .update(
        text
          .replace('"approval_status": "approved"', '"approval_status": "draft-owner-approval-required"')
          .replace('"production_seed_authorized": true', '"production_seed_authorized": false'),
      )
      .digest('hex');
    expect(draftSha).not.toBe(fileSha);
    for (const approved of [undefined, '', `clinic-programs.v1:${draftSha}`, fileSha, `clinic-programs.v2:${fileSha}`]) {
      expect(() =>
        assertSeedAllowed({ NODE_ENV: 'production', CLINIC_PROGRAMS_SEED_APPROVED: approved }, fx),
      ).toThrow(/Refusing to seed production/);
    }
    expect(() =>
      assertSeedAllowed({ CLINIC_SEED_TARGET: 'production', CLINIC_PROGRAMS_SEED_APPROVED: `clinic-programs.v1:${fileSha}` }, fx),
    ).not.toThrow();
  });
});
