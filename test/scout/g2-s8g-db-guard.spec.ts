import { readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';
import {
  G2_S8G_BASE_HEAD,
  G2_S8G_CANDIDATE_HEAD_ENV,
  g2S8gCandidateHead,
  G2_S8G_CLUSTER_MARKER,
  G2_S8G_DATABASE_MARKER,
  g2S8gTestTarget,
  withFixturePassword,
} from '../utils/g2-s8g-db';

const base = 'postgresql://s8g_super@127.0.0.1:55644/g2_s8g_disposable';
const ack = 'g2_s8g_disposable:55644';

describe('S8-G PG17 disposable target guard', () => {
  it('accepts a confirmed loopback target and strips only Prisma options for psql', () => {
    expect(g2S8gTestTarget(`${base}?schema=public&connection_limit=2`, ack)).toEqual({
      prismaUrl: `${base}?schema=public&connection_limit=2&connect_timeout=5`,
      psqlUrl: `${base}?connect_timeout=5`,
      maintenanceUrl: `postgresql://s8g_super@127.0.0.1:55644/postgres?connect_timeout=5`,
      port: 55644,
    });
  });
  it.each([
    base.replace('127.0.0.1', 'localhost'),
    base.replace('127.0.0.1', 'db.supabase.co'),
    base.replace('55644', '5432'),
    base.replace('55644', '6543'),
    base.replace('55644', '55439'),
    base.replace('55644', '70000'),
    base.replace('55644', '55461'),
    base.replace('55644', '55471'),
    base.replace('55644', '55481'),
    base.replace('55644', '55491'),
    base.replace('55644', '55501'),
    base.replace('55644', '55511'),
    base.replace('55644', '55641'),
    base.replace('55644', '55642'),
    base.replace('55644', '55643'),
    base.replace('g2_s8g_disposable', 'g2_b_drain_disposable'),
    base.replace('g2_s8g_disposable', 'g2_r_ready_disposable'),
    base.replace('g2_s8g_disposable', 'g2_nq1_disposable'),
    base.replace('g2_s8g_disposable', 'g2_c_disposable'),
    base.replace('g2_s8g_disposable', 'g2_s7l_disposable'),
    base.replace('g2_s8g_disposable', 'g2_s8b_disposable'),
    base.replace('g2_s8g_disposable', 'g2_s8c_disposable'),
    base.replace('s8g_super@', 'b_super@'),
    base.replace('s8g_super@', 'r_super@'),
    base.replace('s8g_super@', 'nq1_super@'),
    base.replace('s8g_super@', 'c_super@'),
    base.replace('s8g_super@', 's7l_super@'),
    base.replace('s8g_super@', 's8b_super@'),
    base.replace('s8g_super@', 's8c_super@'),
    base.replace('g2_s8g_disposable', 'g2_tq0_disposable'),
    base.replace('g2_s8g_disposable', 'g2_s5_etq0_disposable'),
    base.replace('55644', '54325'),
    base.replace('g2_s8g_disposable', 'g2_ledger_expand_disposable'),
    base.replace('g2_s8g_disposable', 'postgres'),
    base.replace('s8g_super@', 'service_role@'),
    base.replace('s8g_super@', 's8c_super:secret@'),
    base.replace('s8g_super@', 'postgres@'),
    base.replace('55644', '54321'),
    base.replace('postgresql:', 'postgres:'),
    `${base}?host=remote`,
    `${base}?sslmode=disable`,
    `${base}?options=-csearch_path%3Dprivate`,
    `${base}?schema=private`,
    `${base}?connection_limit=0`,
    `${base}?connection_limit=01`,
    `${base}?connect_timeout=11`,
    `${base}?schema=public&schema=public`,
    `${base}#fragment`,
  ])('refuses unsafe or ambiguous target %s', (url) => {
    expect(() => g2S8gTestTarget(url, ack)).toThrow();
  });
  it('refuses absent, mistaken or port-mismatched confirmation', () => {
    expect(() => g2S8gTestTarget(base)).toThrow();
    expect(() => g2S8gTestTarget(base, 'g2_s8g_disposable')).toThrow();
    expect(() => g2S8gTestTarget(base, 'g2_s8g_disposable:55643')).toThrow();
    expect(() => g2S8gTestTarget(base, 'g2_s8c_disposable:55644')).toThrow();
    expect(() => g2S8gTestTarget(base, 'g2_tq0_disposable:55644')).toThrow();
    expect(() => g2S8gTestTarget(base, 'g2_b_drain_disposable:55644')).toThrow();
    expect(() => g2S8gTestTarget(base, 'g2_r_ready_disposable:55644')).toThrow();
    expect(() => g2S8gTestTarget(base, 'g2_nq1_disposable:55644')).toThrow();
    expect(() => g2S8gTestTarget(base, 'g2_c_disposable:55644')).toThrow();
    expect(() => g2S8gTestTarget(base, 'g2_s7l_disposable:55644')).toThrow();
    expect(() => g2S8gTestTarget(base, 'g2_s8b_disposable:55644')).toThrow();
  });
  it('pins distinctive, non-blank fixture markers that bootstrap carries verbatim', () => {
    expect(G2_S8G_CLUSTER_MARKER).toBe('s8g-disposable-pg17');
    expect(G2_S8G_DATABASE_MARKER).toBe(
      's8g-g2-run-orchestration-synthetic-disposable-fixture-safe-to-drop',
    );
    for (const marker of [G2_S8G_CLUSTER_MARKER, G2_S8G_DATABASE_MARKER]) {
      expect(marker).toMatch(/^s8g-[a-z0-9-]{8,}$/);
      expect(marker).toContain('disposable');
    }
    const bootstrap = readFileSync(resolve(__dirname, '../utils/g2-s8g-bootstrap.sh'), 'utf8');
    expect(bootstrap).toContain(`CLUSTER_MARKER=${G2_S8G_CLUSTER_MARKER}\n`);
    expect(bootstrap).toContain(`DB_MARKER=${G2_S8G_DATABASE_MARKER}\n`);
    expect(bootstrap).not.toMatch(/CLUSTER_MARKER=\$\{|DB_MARKER=\$\{/);
  });
  it('attaches the fixture password only from the environment and only in plain form', () => {
    expect(withFixturePassword(base, 'local_fixture')).toBe(
      'postgresql://s8g_super:local_fixture@127.0.0.1:55644/g2_s8g_disposable',
    );
    expect(withFixturePassword(base, 'local_fixture', 'service_role')).toBe(
      'postgresql://service_role:local_fixture@127.0.0.1:55644/g2_s8g_disposable',
    );
    expect(withFixturePassword(base, 'local_fixture', 'postgres')).toBe(
      'postgresql://postgres:local_fixture@127.0.0.1:55644/g2_s8g_disposable',
    );
    for (const role of [
      'anon',
      'authenticated',
      'authenticator',
      'user',
      'g2_ledger_owner',
      'b_super',
      'r_super',
      'nq1_super',
      'c_super',
      's7l_super',
      's8b_super',
      's8c_super',
      '',
    ]) {
      expect(() => withFixturePassword(base, 'local_fixture', role)).toThrow();
    }
    expect(() => withFixturePassword(base, undefined)).toThrow();
    expect(() => withFixturePassword(base, '')).toThrow();
    expect(() => withFixturePassword(base, 'has space')).toThrow();
    expect(() => withFixturePassword(base, 'a@b')).toThrow();
  });
  it('pins the base head and migration count identically across bootstrap, harness and repository', () => {
    const BASE_HEAD = '62471b116267fdec6746073c4b4c80a154d09834';
    const EXPECTED_MIGRATIONS = 172;
    const S8B_MIGRATION = '20270122000000_scout_native_provenance_expand';
    const S7L_MIGRATION = '20270123000000_scout_run_lifecycle_expand';
    const bootstrap = readFileSync(resolve(__dirname, '../utils/g2-s8g-bootstrap.sh'), 'utf8');
    const harness = readFileSync(resolve(__dirname, '../utils/g2-s8g-pg-harness.ts'), 'utf8');
    expect(bootstrap).toContain(`BASE_HEAD=${BASE_HEAD}\n`);
    expect(bootstrap).toContain(`EXPECTED_MIGRATIONS=${EXPECTED_MIGRATIONS}\n`);
    expect(bootstrap).toContain(`S8B_MIGRATION=${S8B_MIGRATION}\n`);
    expect(bootstrap).toContain(`S7L_MIGRATION=${S7L_MIGRATION}\n`);
    expect(G2_S8G_BASE_HEAD).toBe(BASE_HEAD);
    expect(harness).toContain(`export const BASE_HEAD: string = G2_S8G_BASE_HEAD;`);
    expect(bootstrap).toContain(`G2_S8G_CANDIDATE_HEAD`);
    expect(G2_S8G_CANDIDATE_HEAD_ENV).toBe('G2_S8G_CANDIDATE_HEAD');
    expect(harness).toContain(`export const EXPECTED_MIGRATIONS = ${EXPECTED_MIGRATIONS};`);
    expect(harness).toContain(`export const S8B_MIGRATION = '${S8B_MIGRATION}';`);
    expect(harness).toContain(`export const S7L_MIGRATION = '${S7L_MIGRATION}';`);
    // S8-G ships no migration: the proof base's 172 directories are present, in order, and end at
    // the S7-L migration. Lanes landed after the proof base may add later, well-formed migrations.
    const migrationsDir = resolve(__dirname, '../../prisma/migrations');
    const migrations = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const baseMigrations = migrations.slice(0, EXPECTED_MIGRATIONS);
    expect(baseMigrations).toHaveLength(EXPECTED_MIGRATIONS);
    expect(baseMigrations[EXPECTED_MIGRATIONS - 1]).toBe(S7L_MIGRATION);
    expect(baseMigrations[EXPECTED_MIGRATIONS - 2]).toBe(S8B_MIGRATION);
    expect(baseMigrations.filter((name) => name > S7L_MIGRATION)).toEqual([]);
    for (const later of migrations.slice(EXPECTED_MIGRATIONS)) {
      expect(later > S7L_MIGRATION).toBe(true);
      expect(later).toMatch(/^\d{14}_[a-z0-9_]+$/);
      expect(readdirSync(resolve(migrationsDir, later))).toContain('migration.sql');
    }
  });
  it('binds the proof to one attested, clean, non-base candidate head; the worker attests before any client', () => {
    const base = '62471b116267fdec6746073c4b4c80a154d09834';
    const candidate = 'a'.repeat(40);
    expect(g2S8gCandidateHead(candidate, `${candidate}\n`, '')).toBe(candidate);
    expect(() => g2S8gCandidateHead(undefined, candidate, '')).toThrow(/G2_S8G_CANDIDATE_HEAD/);
    expect(() => g2S8gCandidateHead('abc', candidate, '')).toThrow(/G2_S8G_CANDIDATE_HEAD/);
    expect(() => g2S8gCandidateHead(candidate.toUpperCase(), candidate, '')).toThrow();
    expect(() => g2S8gCandidateHead(base, base, '')).toThrow(/not the accepted base/);
    expect(() => g2S8gCandidateHead(candidate, 'b'.repeat(40), '')).toThrow(
      /not the attested candidate/,
    );
    expect(() => g2S8gCandidateHead(candidate, candidate, ' M src/x.ts\n')).toThrow(/uncommitted/);
    const worker = readFileSync(resolve(__dirname, '../utils/g2-s8g-worker.cjs'), 'utf8');
    expect(worker.indexOf("['rev-parse', 'HEAD']")).toBeGreaterThan(-1);
    expect(worker.indexOf("['rev-parse', 'HEAD']")).toBeLessThan(
      worker.indexOf('new PrismaClient'),
    );
    // The worker hands the injected mappers to BOTH engine seams (families and planner).
    expect(worker).toContain('reconstruct.sourceMappers = sourceMappers');
  });
  it('G12: the orchestration seam imports no side-effecting module (static import scan)', () => {
    const src = resolve(__dirname, '../../src/scout');
    const files = [
      resolve(src, 'reconstruct/orchestration/run-context.ts'),
      resolve(src, 'reconstruct/orchestration/family-plan.ts'),
      resolve(src, 'scout-reconstruct.service.ts'),
    ];
    const forbidden = /(notifications|drip|assignment|email|billing|mailer|stripe)/i;
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const imports = [...text.matchAll(/^import[^;]*?from\s+'([^']+)';/gms)].map((m) => m[1]);
      expect(imports.length).toBeGreaterThan(0);
      for (const spec of imports) expect(spec).not.toMatch(forbidden);
      expect(text).not.toMatch(/require\(/);
    }
    // The engine does not import the lifecycle (no cycle): the gate arrives as a closure.
    const engine = readFileSync(files[2], 'utf8');
    expect(engine).not.toMatch(/from '\.\/lifecycle\//);
    // The hook seam: lifecycle gates the pass with assertRunOpen and classifies a closed gate once.
    const lifecycle = readFileSync(resolve(src, 'lifecycle/lifecycle.service.ts'), 'utf8');
    expect(lifecycle).toContain('gate: (tx) => this.assertRunOpen(tx, coachId, intentId)');
    expect(lifecycle).toMatch(
      /if \(pass\.stopped === 'gate_closed'\) \{\s+await this\.classifyClosed\(coachId, intentId\);/,
    );
  });
});
