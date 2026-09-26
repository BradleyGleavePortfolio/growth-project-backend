import { readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';
import {
  G2_S9_BASE_HEAD,
  G2_S9_CANDIDATE_HEAD_ENV,
  g2S9CandidateHead,
  G2_S9_CLUSTER_MARKER,
  G2_S9_DATABASE_MARKER,
  g2S9TestTarget,
  withFixturePassword,
} from '../utils/g2-s9-db';

const base = 'postgresql://s9_super@127.0.0.1:55645/g2_s9_disposable';
const ack = 'g2_s9_disposable:55645';

describe('S9-B PG17 disposable target guard', () => {
  it('accepts a confirmed loopback target and strips only Prisma options for psql', () => {
    expect(g2S9TestTarget(`${base}?schema=public&connection_limit=2`, ack)).toEqual({
      prismaUrl: `${base}?schema=public&connection_limit=2&connect_timeout=5`,
      psqlUrl: `${base}?connect_timeout=5`,
      maintenanceUrl: `postgresql://s9_super@127.0.0.1:55645/postgres?connect_timeout=5`,
      port: 55645,
    });
  });
  it.each([
    base.replace('127.0.0.1', 'localhost'),
    base.replace('127.0.0.1', 'db.supabase.co'),
    base.replace('55645', '5432'),
    base.replace('55645', '6543'),
    base.replace('55645', '55439'),
    base.replace('55645', '70000'),
    base.replace('55645', '55461'),
    base.replace('55645', '55471'),
    base.replace('55645', '55481'),
    base.replace('55645', '55491'),
    base.replace('55645', '55501'),
    base.replace('55645', '55511'),
    base.replace('55645', '55641'),
    base.replace('55645', '55642'),
    base.replace('55645', '55643'),
    base.replace('55645', '55644'),
    base.replace('g2_s9_disposable', 'g2_b_drain_disposable'),
    base.replace('g2_s9_disposable', 'g2_r_ready_disposable'),
    base.replace('g2_s9_disposable', 'g2_nq1_disposable'),
    base.replace('g2_s9_disposable', 'g2_c_disposable'),
    base.replace('g2_s9_disposable', 'g2_s7l_disposable'),
    base.replace('g2_s9_disposable', 'g2_s8b_disposable'),
    base.replace('s9_super@', 'b_super@'),
    base.replace('s9_super@', 'r_super@'),
    base.replace('s9_super@', 'nq1_super@'),
    base.replace('s9_super@', 'c_super@'),
    base.replace('s9_super@', 's7l_super@'),
    base.replace('s9_super@', 's8b_super@'),
    base.replace('g2_s9_disposable', 'g2_tq0_disposable'),
    base.replace('g2_s9_disposable', 'g2_s5_etq0_disposable'),
    base.replace('55645', '54325'),
    base.replace('g2_s9_disposable', 'g2_ledger_expand_disposable'),
    base.replace('g2_s9_disposable', 'postgres'),
    base.replace('s9_super@', 'service_role@'),
    base.replace('s9_super@', 's8b_super:secret@'),
    base.replace('s9_super@', 'postgres@'),
    base.replace('55645', '54321'),
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
    expect(() => g2S9TestTarget(url, ack)).toThrow();
  });
  it('refuses absent, mistaken or port-mismatched confirmation', () => {
    expect(() => g2S9TestTarget(base)).toThrow();
    expect(() => g2S9TestTarget(base, 'g2_s9_disposable')).toThrow();
    expect(() => g2S9TestTarget(base, 'g2_s9_disposable:55646')).toThrow();
    expect(() => g2S9TestTarget(base, 'g2_tq0_disposable:55645')).toThrow();
    expect(() => g2S9TestTarget(base, 'g2_b_drain_disposable:55645')).toThrow();
    expect(() => g2S9TestTarget(base, 'g2_r_ready_disposable:55645')).toThrow();
    expect(() => g2S9TestTarget(base, 'g2_nq1_disposable:55645')).toThrow();
    expect(() => g2S9TestTarget(base, 'g2_c_disposable:55645')).toThrow();
    expect(() => g2S9TestTarget(base, 'g2_s7l_disposable:55645')).toThrow();
    expect(() => g2S9TestTarget(base, 'g2_s8b_disposable:55645')).toThrow();
    expect(() => g2S9TestTarget(base, 'g2_s8c_disposable:55645')).toThrow();
    expect(() => g2S9TestTarget(base, 'g2_s8g_disposable:55645')).toThrow();
  });
  it('pins distinctive, non-blank fixture markers that bootstrap carries verbatim', () => {
    // Both markers are literals: nothing in process.env can change them, so a blank or foreign
    // cluster_name / database comment is refused before DROP or bootstrap touches a server.
    expect(G2_S9_CLUSTER_MARKER).toBe('s9-disposable-pg17');
    expect(G2_S9_DATABASE_MARKER).toBe(
      's9-g2-reconciliation-facts-synthetic-disposable-fixture-safe-to-drop',
    );
    for (const marker of [G2_S9_CLUSTER_MARKER, G2_S9_DATABASE_MARKER]) {
      expect(marker).toMatch(/^s9-[a-z0-9-]{8,}$/);
      expect(marker).toContain('disposable');
    }
    const bootstrap = readFileSync(resolve(__dirname, '../utils/g2-s9-bootstrap.sh'), 'utf8');
    expect(bootstrap).toContain(`CLUSTER_MARKER=${G2_S9_CLUSTER_MARKER}\n`);
    expect(bootstrap).toContain(`DB_MARKER=${G2_S9_DATABASE_MARKER}\n`);
    expect(bootstrap).not.toMatch(/CLUSTER_MARKER=\$\{|DB_MARKER=\$\{/);
  });
  it('attaches the fixture password only from the environment and only in plain form', () => {
    expect(withFixturePassword(base, 'local_fixture')).toBe(
      'postgresql://s9_super:local_fixture@127.0.0.1:55645/g2_s9_disposable',
    );
    expect(withFixturePassword(base, 'local_fixture', 'service_role')).toBe(
      'postgresql://service_role:local_fixture@127.0.0.1:55645/g2_s9_disposable',
    );
    expect(withFixturePassword(base, 'local_fixture', 'postgres')).toBe(
      'postgresql://postgres:local_fixture@127.0.0.1:55645/g2_s9_disposable',
    );
    // Only the explicit fixture matrix may log in; API roles and arbitrary names are refused.
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
      's8g_super',
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
    const BASE_HEAD = '1c5fbb0441178e0cfe6e9f8d72e955c645c265e9';
    const EXPECTED_MIGRATIONS = 172;
    const S8B_MIGRATION = '20270122000000_scout_native_provenance_expand';
    const S7L_MIGRATION = '20270123000000_scout_run_lifecycle_expand';
    const bootstrap = readFileSync(resolve(__dirname, '../utils/g2-s9-bootstrap.sh'), 'utf8');
    const harness = readFileSync(resolve(__dirname, '../utils/g2-s9-pg-harness.ts'), 'utf8');
    expect(bootstrap).toContain(`BASE_HEAD=${BASE_HEAD}\n`);
    expect(bootstrap).toContain(`EXPECTED_MIGRATIONS=${EXPECTED_MIGRATIONS}\n`);
    expect(bootstrap).toContain(`S8B_MIGRATION=${S8B_MIGRATION}\n`);
    expect(bootstrap).toContain(`S7L_MIGRATION=${S7L_MIGRATION}\n`);
    expect(G2_S9_BASE_HEAD).toBe(BASE_HEAD);
    expect(harness).toContain(`export const BASE_HEAD: string = G2_S9_BASE_HEAD;`);
    expect(bootstrap).toContain(`G2_S9_CANDIDATE_HEAD`);
    expect(G2_S9_CANDIDATE_HEAD_ENV).toBe('G2_S9_CANDIDATE_HEAD');
    expect(harness).toContain(`export const EXPECTED_MIGRATIONS = ${EXPECTED_MIGRATIONS};`);
    expect(harness).toContain(`export const S8B_MIGRATION = '${S8B_MIGRATION}';`);
    expect(harness).toContain(`export const S7L_MIGRATION = '${S7L_MIGRATION}';`);
    // S9-B ships no migration (D-S9-5): the proof base's 172 directories are present, in order, and
    // end at the S7-L migration. Lanes landed after the proof base may add later, well-formed migrations.
    const migrationsDir = resolve(__dirname, '../../prisma/migrations');
    const migrations = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const baseMigrations = migrations.slice(0, EXPECTED_MIGRATIONS);
    expect(baseMigrations).toHaveLength(EXPECTED_MIGRATIONS);
    expect(baseMigrations[EXPECTED_MIGRATIONS - 1]).toBe(S7L_MIGRATION);
    expect(baseMigrations).toContain(S8B_MIGRATION);
    expect(baseMigrations.filter((name) => name > S7L_MIGRATION)).toEqual([]);
    for (const later of migrations.slice(EXPECTED_MIGRATIONS)) {
      expect(later > S7L_MIGRATION).toBe(true);
      expect(later).toMatch(/^\d{14}_[a-z0-9_]+$/);
      expect(readdirSync(resolve(migrationsDir, later))).toContain('migration.sql');
    }
  });
  it('binds the proof to one attested, clean, non-base candidate head', () => {
    const base = '1c5fbb0441178e0cfe6e9f8d72e955c645c265e9';
    const candidate = 'a'.repeat(40);
    expect(g2S9CandidateHead(candidate, `${candidate}\n`, '')).toBe(candidate);
    expect(() => g2S9CandidateHead(undefined, candidate, '')).toThrow(/G2_S9_CANDIDATE_HEAD/);
    expect(() => g2S9CandidateHead('abc', candidate, '')).toThrow(/G2_S9_CANDIDATE_HEAD/);
    expect(() => g2S9CandidateHead(candidate.toUpperCase(), candidate, '')).toThrow();
    expect(() => g2S9CandidateHead(base, base, '')).toThrow(/not the accepted base/);
    expect(() => g2S9CandidateHead(candidate, 'b'.repeat(40), '')).toThrow(
      /not the attested candidate/,
    );
    expect(() => g2S9CandidateHead(candidate, candidate, ' M src/x.ts\n')).toThrow(/uncommitted/);
  });
});
