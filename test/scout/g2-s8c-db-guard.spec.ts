import { readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';
import {
  G2_S8C_BASE_HEAD,
  G2_S8C_CANDIDATE_HEAD_ENV,
  g2S8cCandidateHead,
  G2_S8C_CLUSTER_MARKER,
  G2_S8C_DATABASE_MARKER,
  g2S8cTestTarget,
  withFixturePassword,
} from '../utils/g2-s8c-db';

const base = 'postgresql://s8c_super@127.0.0.1:55642/g2_s8c_disposable';
const ack = 'g2_s8c_disposable:55642';

describe('S8-C PG17 disposable target guard', () => {
  it('accepts a confirmed loopback target and strips only Prisma options for psql', () => {
    expect(g2S8cTestTarget(`${base}?schema=public&connection_limit=2`, ack)).toEqual({
      prismaUrl: `${base}?schema=public&connection_limit=2&connect_timeout=5`,
      psqlUrl: `${base}?connect_timeout=5`,
      maintenanceUrl: `postgresql://s8c_super@127.0.0.1:55642/postgres?connect_timeout=5`,
      port: 55642,
    });
  });
  it.each([
    base.replace('127.0.0.1', 'localhost'),
    base.replace('127.0.0.1', 'db.supabase.co'),
    base.replace('55642', '5432'),
    base.replace('55642', '6543'),
    base.replace('55642', '55439'),
    base.replace('55642', '70000'),
    base.replace('55642', '55461'),
    base.replace('55642', '55471'),
    base.replace('55642', '55481'),
    base.replace('55642', '55491'),
    base.replace('55642', '55501'),
    base.replace('55642', '55511'),
    base.replace('55642', '55641'),
    base.replace('g2_s8c_disposable', 'g2_b_drain_disposable'),
    base.replace('g2_s8c_disposable', 'g2_r_ready_disposable'),
    base.replace('g2_s8c_disposable', 'g2_nq1_disposable'),
    base.replace('g2_s8c_disposable', 'g2_c_disposable'),
    base.replace('g2_s8c_disposable', 'g2_s7l_disposable'),
    base.replace('g2_s8c_disposable', 'g2_s8b_disposable'),
    base.replace('s8c_super@', 'b_super@'),
    base.replace('s8c_super@', 'r_super@'),
    base.replace('s8c_super@', 'nq1_super@'),
    base.replace('s8c_super@', 'c_super@'),
    base.replace('s8c_super@', 's7l_super@'),
    base.replace('s8c_super@', 's8b_super@'),
    base.replace('g2_s8c_disposable', 'g2_tq0_disposable'),
    base.replace('g2_s8c_disposable', 'g2_s5_etq0_disposable'),
    base.replace('55642', '54325'),
    base.replace('g2_s8c_disposable', 'g2_ledger_expand_disposable'),
    base.replace('g2_s8c_disposable', 'postgres'),
    base.replace('s8c_super@', 'service_role@'),
    base.replace('s8c_super@', 's8b_super:secret@'),
    base.replace('s8c_super@', 'postgres@'),
    base.replace('55642', '54321'),
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
    expect(() => g2S8cTestTarget(url, ack)).toThrow();
  });
  it('refuses absent, mistaken or port-mismatched confirmation', () => {
    expect(() => g2S8cTestTarget(base)).toThrow();
    expect(() => g2S8cTestTarget(base, 'g2_s8c_disposable')).toThrow();
    expect(() => g2S8cTestTarget(base, 'g2_s8c_disposable:55643')).toThrow();
    expect(() => g2S8cTestTarget(base, 'g2_tq0_disposable:55642')).toThrow();
    expect(() => g2S8cTestTarget(base, 'g2_b_drain_disposable:55642')).toThrow();
    expect(() => g2S8cTestTarget(base, 'g2_r_ready_disposable:55642')).toThrow();
    expect(() => g2S8cTestTarget(base, 'g2_nq1_disposable:55642')).toThrow();
    expect(() => g2S8cTestTarget(base, 'g2_c_disposable:55642')).toThrow();
    expect(() => g2S8cTestTarget(base, 'g2_s7l_disposable:55642')).toThrow();
    expect(() => g2S8cTestTarget(base, 'g2_s8b_disposable:55642')).toThrow();
  });
  it('pins distinctive, non-blank fixture markers that bootstrap carries verbatim', () => {
    // Both markers are literals: nothing in process.env can change them, so a blank or foreign
    // cluster_name / database comment is refused before DROP or bootstrap touches a server.
    expect(G2_S8C_CLUSTER_MARKER).toBe('s8c-disposable-pg17');
    expect(G2_S8C_DATABASE_MARKER).toBe(
      's8c-g2-native-writer-synthetic-disposable-fixture-safe-to-drop',
    );
    for (const marker of [G2_S8C_CLUSTER_MARKER, G2_S8C_DATABASE_MARKER]) {
      expect(marker).toMatch(/^s8c-[a-z0-9-]{8,}$/);
      expect(marker).toContain('disposable');
    }
    const bootstrap = readFileSync(resolve(__dirname, '../utils/g2-s8c-bootstrap.sh'), 'utf8');
    expect(bootstrap).toContain(`CLUSTER_MARKER=${G2_S8C_CLUSTER_MARKER}\n`);
    expect(bootstrap).toContain(`DB_MARKER=${G2_S8C_DATABASE_MARKER}\n`);
    expect(bootstrap).not.toMatch(/CLUSTER_MARKER=\$\{|DB_MARKER=\$\{/);
  });
  it('attaches the fixture password only from the environment and only in plain form', () => {
    expect(withFixturePassword(base, 'local_fixture')).toBe(
      'postgresql://s8c_super:local_fixture@127.0.0.1:55642/g2_s8c_disposable',
    );
    expect(withFixturePassword(base, 'local_fixture', 'service_role')).toBe(
      'postgresql://service_role:local_fixture@127.0.0.1:55642/g2_s8c_disposable',
    );
    expect(withFixturePassword(base, 'local_fixture', 'postgres')).toBe(
      'postgresql://postgres:local_fixture@127.0.0.1:55642/g2_s8c_disposable',
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
    const BASE_HEAD = '93389265a846095b846fa8f1fb0dad782fb6ee9f';
    const EXPECTED_MIGRATIONS = 171;
    const S8B_MIGRATION = '20270122000000_scout_native_provenance_expand';
    const bootstrap = readFileSync(resolve(__dirname, '../utils/g2-s8c-bootstrap.sh'), 'utf8');
    const harness = readFileSync(resolve(__dirname, '../utils/g2-s8c-pg-harness.ts'), 'utf8');
    expect(bootstrap).toContain(`BASE_HEAD=${BASE_HEAD}\n`);
    expect(bootstrap).toContain(`EXPECTED_MIGRATIONS=${EXPECTED_MIGRATIONS}\n`);
    expect(bootstrap).toContain(`S8B_MIGRATION=${S8B_MIGRATION}\n`);
    expect(G2_S8C_BASE_HEAD).toBe(BASE_HEAD);
    expect(harness).toContain(`export const BASE_HEAD: string = G2_S8C_BASE_HEAD;`);
    expect(bootstrap).toContain(`G2_S8C_CANDIDATE_HEAD`);
    expect(G2_S8C_CANDIDATE_HEAD_ENV).toBe('G2_S8C_CANDIDATE_HEAD');
    expect(harness).toContain(`export const EXPECTED_MIGRATIONS = ${EXPECTED_MIGRATIONS};`);
    expect(harness).toContain(`export const S8B_MIGRATION = '${S8B_MIGRATION}';`);
    // S8-C ships no migration: the repository tracks exactly the accepted 171 directories.
    const migrations = readdirSync(resolve(__dirname, '../../prisma/migrations'), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(migrations).toHaveLength(EXPECTED_MIGRATIONS);
    expect(migrations).toContain(S8B_MIGRATION);
    expect(migrations.filter((name) => name > S8B_MIGRATION)).toEqual([]);
  });
  it('binds the proof to one attested, clean, non-base candidate head', () => {
    const base = '93389265a846095b846fa8f1fb0dad782fb6ee9f';
    const candidate = 'a'.repeat(40);
    expect(g2S8cCandidateHead(candidate, `${candidate}\n`, '')).toBe(candidate);
    expect(() => g2S8cCandidateHead(undefined, candidate, '')).toThrow(/G2_S8C_CANDIDATE_HEAD/);
    expect(() => g2S8cCandidateHead('abc', candidate, '')).toThrow(/G2_S8C_CANDIDATE_HEAD/);
    expect(() => g2S8cCandidateHead(candidate.toUpperCase(), candidate, '')).toThrow();
    expect(() => g2S8cCandidateHead(base, base, '')).toThrow(/not the accepted base/);
    expect(() => g2S8cCandidateHead(candidate, 'b'.repeat(40), '')).toThrow(
      /not the attested candidate/,
    );
    expect(() => g2S8cCandidateHead(candidate, candidate, ' M src/x.ts\n')).toThrow(/uncommitted/);
  });
});
