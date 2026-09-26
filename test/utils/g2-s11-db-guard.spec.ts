import { readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';
import {
  G2_S11_BASE_HEAD,
  G2_S11_CANDIDATE_HEAD_ENV,
  g2S11CandidateHead,
  G2_S11_CLUSTER_MARKER,
  G2_S11_DATABASE_MARKER,
  g2S11TestTarget,
  withFixturePassword,
} from './g2-s11-db';

const base = 'postgresql://s11_super@127.0.0.1:55648/g2_s11_disposable';
const ack = 'g2_s11_disposable:55648';

describe('S11 PG17 disposable target guard', () => {
  it('accepts a confirmed loopback target and strips only Prisma options for psql', () => {
    expect(g2S11TestTarget(`${base}?schema=public&connection_limit=2`, ack)).toEqual({
      prismaUrl: `${base}?schema=public&connection_limit=2&connect_timeout=5`,
      psqlUrl: `${base}?connect_timeout=5`,
      maintenanceUrl: `postgresql://s11_super@127.0.0.1:55648/postgres?connect_timeout=5`,
      port: 55648,
    });
  });
  it.each([
    base.replace('127.0.0.1', 'localhost'),
    base.replace('127.0.0.1', 'db.supabase.co'),
    base.replace('55648', '5432'),
    base.replace('55648', '6543'),
    base.replace('55648', '55439'),
    base.replace('55648', '70000'),
    base.replace('55648', '55461'),
    base.replace('55648', '55471'),
    base.replace('55648', '55481'),
    base.replace('55648', '55491'),
    base.replace('55648', '55501'),
    base.replace('55648', '55511'),
    base.replace('55648', '55641'),
    base.replace('55648', '55642'),
    base.replace('55648', '55643'),
    base.replace('55648', '55644'),
    base.replace('55648', '55645'),
    base.replace('55648', '55646'),
    base.replace('55648', '55647'),
    base.replace('55648', '55649'),
    base.replace('g2_s11_disposable', 'g2_b_drain_disposable'),
    base.replace('g2_s11_disposable', 'g2_r_ready_disposable'),
    base.replace('g2_s11_disposable', 'g2_nq1_disposable'),
    base.replace('g2_s11_disposable', 'g2_c_disposable'),
    base.replace('g2_s11_disposable', 'g2_s7l_disposable'),
    base.replace('g2_s11_disposable', 'g2_s8b_disposable'),
    base.replace('g2_s11_disposable', 'g2_s8c_disposable'),
    base.replace('g2_s11_disposable', 'g2_s8g_disposable'),
    base.replace('g2_s11_disposable', 'g2_s9_disposable'),
    base.replace('g2_s11_disposable', 'g2_s9c_disposable'),
    base.replace('g2_s11_disposable', 'g2_s10b_disposable'),
    base.replace('s11_super@', 'b_super@'),
    base.replace('s11_super@', 'r_super@'),
    base.replace('s11_super@', 'nq1_super@'),
    base.replace('s11_super@', 'c_super@'),
    base.replace('s11_super@', 's7l_super@'),
    base.replace('s11_super@', 's8b_super@'),
    base.replace('s11_super@', 's8c_super@'),
    base.replace('s11_super@', 's8g_super@'),
    base.replace('s11_super@', 's9_super@'),
    base.replace('s11_super@', 's9c_super@'),
    base.replace('s11_super@', 's10b_super@'),
    base.replace('g2_s11_disposable', 'g2_tq0_disposable'),
    base.replace('g2_s11_disposable', 'g2_s5_etq0_disposable'),
    base.replace('55648', '54325'),
    base.replace('g2_s11_disposable', 'g2_ledger_expand_disposable'),
    base.replace('g2_s11_disposable', 'postgres'),
    base.replace('s11_super@', 'service_role@'),
    base.replace('s11_super@', 's8c_super:secret@'),
    base.replace('s11_super@', 'postgres@'),
    base.replace('55648', '54321'),
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
    expect(() => g2S11TestTarget(url, ack)).toThrow();
  });
  // Discriminating refused-port proof (S11-A1 fix 1): each prohibited port is paired with its OWN
  // matching confirmation, so only the explicit refused-port set can reject it. The positive
  // controls show the same URL shape on a non-prohibited port with its matching confirmation passes.
  it.each([
    '5432',
    '5433',
    '6543',
    '54321',
    '54322',
    '55439',
    '54325',
    '55461',
    '55471',
    '55481',
    '55491',
    '55501',
    '55511',
    '55641',
    '55642',
    '55643',
    '55644',
    '55645',
    '55646',
    '55647',
  ])('refuses prohibited prior-lane port %s even with its matching confirmation', (port) => {
    const url = base.replace('55648', port);
    expect(url).toBe(`postgresql://s11_super@127.0.0.1:${port}/g2_s11_disposable`);
    expect(() => g2S11TestTarget(url, `g2_s11_disposable:${port}`)).toThrow(
      /explicitly confirmed loopback disposable database and port/,
    );
  });
  it.each(['55648', '55649', '55650'])(
    'accepts non-prohibited port %s with its matching confirmation (control)',
    (port) => {
      const url = base.replace('55648', port);
      expect(g2S11TestTarget(url, `g2_s11_disposable:${port}`).port).toBe(Number(port));
    },
  );
  it('refuses absent, mistaken or port-mismatched confirmation', () => {
    expect(() => g2S11TestTarget(base)).toThrow();
    expect(() => g2S11TestTarget(base, 'g2_s11_disposable')).toThrow();
    expect(() => g2S11TestTarget(base, 'g2_s11_disposable:55643')).toThrow();
    expect(() => g2S11TestTarget(base, 'g2_s8c_disposable:55648')).toThrow();
    expect(() => g2S11TestTarget(base, 'g2_tq0_disposable:55648')).toThrow();
    expect(() => g2S11TestTarget(base, 'g2_b_drain_disposable:55648')).toThrow();
    expect(() => g2S11TestTarget(base, 'g2_r_ready_disposable:55648')).toThrow();
    expect(() => g2S11TestTarget(base, 'g2_nq1_disposable:55648')).toThrow();
    expect(() => g2S11TestTarget(base, 'g2_c_disposable:55648')).toThrow();
    expect(() => g2S11TestTarget(base, 'g2_s7l_disposable:55648')).toThrow();
    expect(() => g2S11TestTarget(base, 'g2_s8b_disposable:55648')).toThrow();
    expect(() => g2S11TestTarget(base, 'g2_s8g_disposable:55648')).toThrow();
    expect(() => g2S11TestTarget(base, 'g2_s9_disposable:55648')).toThrow();
    expect(() => g2S11TestTarget(base, 'g2_s9c_disposable:55648')).toThrow();
    expect(() => g2S11TestTarget(base, 'g2_s11_disposable:55646')).toThrow();
    expect(() => g2S11TestTarget(base, 'g2_s11_disposable:55647')).toThrow();
  });
  it('pins distinctive, non-blank fixture markers that bootstrap carries verbatim', () => {
    expect(G2_S11_CLUSTER_MARKER).toBe('s11-disposable-pg17');
    expect(G2_S11_DATABASE_MARKER).toBe(
      's11-g2-journey-multi-host-synthetic-disposable-fixture-safe-to-drop',
    );
    for (const marker of [G2_S11_CLUSTER_MARKER, G2_S11_DATABASE_MARKER]) {
      expect(marker).toMatch(/^s11-[a-z0-9-]{8,}$/);
      expect(marker).toContain('disposable');
    }
    const bootstrap = readFileSync(resolve(__dirname, './g2-s11-bootstrap.sh'), 'utf8');
    expect(bootstrap).toContain(`CLUSTER_MARKER=${G2_S11_CLUSTER_MARKER}\n`);
    expect(bootstrap).toContain(`DB_MARKER=${G2_S11_DATABASE_MARKER}\n`);
    expect(bootstrap).not.toMatch(/CLUSTER_MARKER=\$\{|DB_MARKER=\$\{/);
  });
  it('attaches the fixture password only from the environment and only in plain form', () => {
    expect(withFixturePassword(base, 'local_fixture')).toBe(
      'postgresql://s11_super:local_fixture@127.0.0.1:55648/g2_s11_disposable',
    );
    expect(withFixturePassword(base, 'local_fixture', 'service_role')).toBe(
      'postgresql://service_role:local_fixture@127.0.0.1:55648/g2_s11_disposable',
    );
    expect(withFixturePassword(base, 'local_fixture', 'postgres')).toBe(
      'postgresql://postgres:local_fixture@127.0.0.1:55648/g2_s11_disposable',
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
      's9c_super',
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
    const BASE_HEAD = '711c1f8f8b42157bca97f2a721557be7ef006667';
    const EXPECTED_MIGRATIONS = 173;
    const S8B_MIGRATION = '20270122000000_scout_native_provenance_expand';
    const S7L_MIGRATION = '20270123000000_scout_run_lifecycle_expand';
    const S10B_MIGRATION = '20270124000000_scout_run_observation_expand';
    const S10B_TABLES = 'ScoutRunDeclaration ScoutRunObservation ScoutRunSettledBasis';
    const bootstrap = readFileSync(resolve(__dirname, './g2-s11-bootstrap.sh'), 'utf8');
    const harness = readFileSync(resolve(__dirname, './g2-s11-pg-harness.ts'), 'utf8');
    expect(bootstrap).toContain(`BASE_HEAD=${BASE_HEAD}\n`);
    expect(bootstrap).toContain(`EXPECTED_MIGRATIONS=${EXPECTED_MIGRATIONS}\n`);
    expect(bootstrap).toContain(`S8B_MIGRATION=${S8B_MIGRATION}\n`);
    expect(bootstrap).toContain(`S7L_MIGRATION=${S7L_MIGRATION}\n`);
    expect(bootstrap).toContain(`S10B_MIGRATION=${S10B_MIGRATION}\n`);
    expect(bootstrap).toContain(`S10B_TABLES="${S10B_TABLES}"\n`);
    expect(bootstrap).toContain('[[ "$LAST_MIGRATION" == "$S10B_MIGRATION" ]]');
    expect(G2_S11_BASE_HEAD).toBe(BASE_HEAD);
    expect(harness).toContain(`export const BASE_HEAD: string = G2_S11_BASE_HEAD;`);
    expect(bootstrap).toContain(`G2_S11_CANDIDATE_HEAD`);
    expect(G2_S11_CANDIDATE_HEAD_ENV).toBe('G2_S11_CANDIDATE_HEAD');
    expect(harness).toContain(`export const EXPECTED_MIGRATIONS = ${EXPECTED_MIGRATIONS};`);
    expect(harness).toContain(`export const S8B_MIGRATION = '${S8B_MIGRATION}';`);
    expect(harness).toContain(`export const S7L_MIGRATION = '${S7L_MIGRATION}';`);
    expect(harness).toContain(`export const S10B_MIGRATION = '${S10B_MIGRATION}';`);
    expect(harness).toContain(
      `export const S10B_TABLES = ['${S10B_TABLES.split(' ').join("', '")}'];`,
    );
    // S11 ships no migration: the proof base's 173 directories are present, in order, and end at
    // the S10-B migration (S7-L before it, S8-B before that). Lanes landed after the proof base may
    // add later, well-formed migrations.
    const migrationsDir = resolve(__dirname, '../../prisma/migrations');
    const migrations = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const baseMigrations = migrations.slice(0, EXPECTED_MIGRATIONS);
    expect(baseMigrations).toHaveLength(EXPECTED_MIGRATIONS);
    expect(baseMigrations[EXPECTED_MIGRATIONS - 1]).toBe(S10B_MIGRATION);
    expect(baseMigrations[EXPECTED_MIGRATIONS - 2]).toBe(S7L_MIGRATION);
    expect(baseMigrations[EXPECTED_MIGRATIONS - 3]).toBe(S8B_MIGRATION);
    expect(baseMigrations.filter((name) => name > S10B_MIGRATION)).toEqual([]);
    for (const later of migrations.slice(EXPECTED_MIGRATIONS)) {
      expect(later > S10B_MIGRATION).toBe(true);
      expect(later).toMatch(/^\d{14}_[a-z0-9_]+$/);
      expect(readdirSync(resolve(migrationsDir, later))).toContain('migration.sql');
    }
  });
  it('binds the proof to one attested, clean, non-base candidate head; the worker attests before any client', () => {
    const base = '711c1f8f8b42157bca97f2a721557be7ef006667';
    const candidate = 'a'.repeat(40);
    expect(g2S11CandidateHead(candidate, `${candidate}\n`, '')).toBe(candidate);
    expect(() => g2S11CandidateHead(undefined, candidate, '')).toThrow(/G2_S11_CANDIDATE_HEAD/);
    expect(() => g2S11CandidateHead('abc', candidate, '')).toThrow(/G2_S11_CANDIDATE_HEAD/);
    expect(() => g2S11CandidateHead(candidate.toUpperCase(), candidate, '')).toThrow();
    expect(() => g2S11CandidateHead(base, base, '')).toThrow(/not the accepted base/);
    expect(() => g2S11CandidateHead(candidate, 'b'.repeat(40), '')).toThrow(
      /not the attested candidate/,
    );
    expect(() => g2S11CandidateHead(candidate, candidate, ' M src/x.ts\n')).toThrow(/uncommitted/);
    const worker = readFileSync(resolve(__dirname, './g2-s11-worker.cjs'), 'utf8');
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

describe('S11 one-harness shape (D-S11-6, D-S11-7(7); static, no database)', () => {
  const read = (name: string) => readFileSync(resolve(__dirname, name), 'utf8');
  const s11Files = [
    'g2-s11-bootstrap.sh',
    'g2-s11-db.ts',
    'g2-s11-harness.ts',
    'g2-s11-pg-harness.ts',
    'g2-s11-worker.cjs',
    '../rls-g2-s11.spec.ts',
    '../scout/s11/journey-core.pg.spec.ts',
  ];
  const actionsOf = (worker: string) =>
    [...worker.matchAll(/^\s+case '([a-z-]+)':/gm)].map((m) => m[1]).sort();

  it('the S11 worker carries exactly the donor actions S11 uses plus the S11-A1 additions', () => {
    const worker = read('g2-s11-worker.cjs');
    const donor = read('g2-s9c-worker.cjs');
    const kept = ['cancel', 'complete', 'fence', 'ingest', 'start', 'status'];
    const removed = ['reconstruct', 'report', 'run-pass', 'settled'];
    const added = [
      'entities',
      'pair-current',
      'pair-init',
      'pair-redeem',
      'pair-session',
      'progress',
      'roster',
    ];
    expect(actionsOf(donor)).toEqual([...kept, ...removed].sort());
    expect(actionsOf(worker)).toEqual([...kept, ...added].sort());
    // Head attestation still precedes the first client; the mint stub is the only non-real service.
    expect(worker.indexOf("['rev-parse', 'HEAD']")).toBeLessThan(
      worker.indexOf('new PrismaClient'),
    );
    expect(worker).toContain('new ExtensionPairService(prisma, auth)');
    expect(worker).toContain("await barrier('cached');");
    expect(worker).toContain('if (body.flush === true) await scout.flush();');
    // J08 observes outbound CALLS: channel methods and transports are replaced by recording,
    // throwing stand-ins after the startup graph loads, and each push is recorded on the call.
    expect(worker).toContain('function blockedCall(channel, method, args)');
    expect(worker.indexOf('function blockedCall')).toBeGreaterThan(
      worker.indexOf('sideEffectLoads[k] = 0'),
    );
    expect(worker).toMatch(/\['https', require\('https'\)\]/);
    expect(worker).toContain('globalThis.fetch = ');
    expect(worker).toContain('pushCalls.push({ userId, kind:');
  });

  it('every S11 harness file is bound to the S11 lane only and names no real platform slug', () => {
    const sources = resolve(__dirname, '../../src/scout/reconstruct/sources');
    const slugs = readdirSync(sources)
      .filter((name) => name.endsWith('.json') && !name.startsWith('conformance_'))
      .map((name) => name.replace(/\.json$/, ''));
    expect(slugs.length).toBeGreaterThan(0);
    for (const file of s11Files) {
      const text = read(file);
      for (const slug of slugs) expect(text.includes(slug)).toBe(false);
      expect(text).not.toMatch(/G2_S9C_|g2_s9c_disposable|s9c_super|G2_S10B_/);
    }
    // One harness: the S11 specs import the S11 harness and no donor harness.
    for (const file of ['../rls-g2-s11.spec.ts', '../scout/s11/journey-core.pg.spec.ts']) {
      const text = read(file);
      expect(text).toContain('g2-s11-');
      expect(text).not.toMatch(/g2-s(7l|8[a-z]|9[a-z]?|10[a-z]?)-/);
    }
  });

  it('the real-PG journey spec is inert without the S11 lane and never builds its own harness', () => {
    const journey = read('../scout/s11/journey-core.pg.spec.ts');
    expect(journey).toContain('process.env.G2_S11_DATABASE_URL ? describe : describe.skip');
    expect(journey).not.toMatch(/^import (?!type)[^;]*g2-s11-(pg-)?harness/m);
    expect(journey).not.toMatch(/new PrismaClient|fork\(|spawn\(/);
  });
});
