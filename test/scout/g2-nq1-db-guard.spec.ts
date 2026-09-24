import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  G2_NQ1_CLUSTER_MARKER,
  G2_NQ1_DATABASE_MARKER,
  g2Nq1TestTarget,
  withFixturePassword,
} from '../utils/g2-nq1-db';

const base = 'postgresql://nq1_super@127.0.0.1:55481/g2_nq1_disposable';
const ack = 'g2_nq1_disposable:55481';

describe('S7-3 N/Q1 PG17 disposable target guard', () => {
  it('accepts a confirmed loopback target and strips only Prisma options for psql', () => {
    expect(g2Nq1TestTarget(`${base}?schema=public&connection_limit=2`, ack)).toEqual({
      prismaUrl: `${base}?schema=public&connection_limit=2&connect_timeout=5`,
      psqlUrl: `${base}?connect_timeout=5`,
      maintenanceUrl: `postgresql://nq1_super@127.0.0.1:55481/postgres?connect_timeout=5`,
      port: 55481,
    });
  });
  it.each([
    base.replace('127.0.0.1', 'localhost'),
    base.replace('127.0.0.1', 'db.supabase.co'),
    base.replace('55481', '5432'),
    base.replace('55481', '6543'),
    base.replace('55481', '55439'),
    base.replace('55481', '70000'),
    base.replace('55481', '55461'),
    base.replace('55481', '55471'),
    base.replace('g2_nq1_disposable', 'g2_b_drain_disposable'),
    base.replace('g2_nq1_disposable', 'g2_r_ready_disposable'),
    base.replace('nq1_super@', 'b_super@'),
    base.replace('nq1_super@', 'r_super@'),
    base.replace('g2_nq1_disposable', 'g2_tq0_disposable'),
    base.replace('g2_nq1_disposable', 'g2_s5_etq0_disposable'),
    base.replace('55481', '54325'),
    base.replace('g2_nq1_disposable', 'g2_ledger_expand_disposable'),
    base.replace('g2_nq1_disposable', 'postgres'),
    base.replace('nq1_super@', 'service_role@'),
    base.replace('nq1_super@', 'nq1_super:secret@'),
    base.replace('nq1_super@', 'postgres@'),
    base.replace('55481', '54321'),
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
    expect(() => g2Nq1TestTarget(url, ack)).toThrow();
  });
  it('refuses absent, mistaken or port-mismatched confirmation', () => {
    expect(() => g2Nq1TestTarget(base)).toThrow();
    expect(() => g2Nq1TestTarget(base, 'g2_nq1_disposable')).toThrow();
    expect(() => g2Nq1TestTarget(base, 'g2_nq1_disposable:55472')).toThrow();
    expect(() => g2Nq1TestTarget(base, 'g2_tq0_disposable:55481')).toThrow();
    expect(() => g2Nq1TestTarget(base, 'g2_b_drain_disposable:55481')).toThrow();
    expect(() => g2Nq1TestTarget(base, 'g2_r_ready_disposable:55481')).toThrow();
  });
  it('pins distinctive, non-blank fixture markers that bootstrap carries verbatim', () => {
    // Both markers are literals: nothing in process.env can change them, so a blank or foreign
    // cluster_name / database comment is refused before DROP or bootstrap touches a server.
    expect(G2_NQ1_CLUSTER_MARKER).toBe('nq1-disposable-pg17');
    expect(G2_NQ1_DATABASE_MARKER).toBe('nq1-g2-synthetic-disposable-fixture-safe-to-drop');
    for (const marker of [G2_NQ1_CLUSTER_MARKER, G2_NQ1_DATABASE_MARKER]) {
      expect(marker).toMatch(/^nq1-[a-z0-9-]{8,}$/);
      expect(marker).toContain('disposable');
    }
    const bootstrap = readFileSync(resolve(__dirname, '../utils/g2-nq1-bootstrap.sh'), 'utf8');
    expect(bootstrap).toContain(`CLUSTER_MARKER=${G2_NQ1_CLUSTER_MARKER}\n`);
    expect(bootstrap).toContain(`DB_MARKER=${G2_NQ1_DATABASE_MARKER}\n`);
    expect(bootstrap).not.toMatch(/CLUSTER_MARKER=\$\{|DB_MARKER=\$\{/);
  });
  it('attaches the fixture password only from the environment and only in plain form', () => {
    expect(withFixturePassword(base, 'local_fixture')).toBe(
      'postgresql://nq1_super:local_fixture@127.0.0.1:55481/g2_nq1_disposable',
    );
    expect(withFixturePassword(base, 'local_fixture', 'service_role')).toBe(
      'postgresql://service_role:local_fixture@127.0.0.1:55481/g2_nq1_disposable',
    );
    expect(withFixturePassword(base, 'local_fixture', 'postgres')).toBe(
      'postgresql://postgres:local_fixture@127.0.0.1:55481/g2_nq1_disposable',
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
      '',
    ]) {
      expect(() => withFixturePassword(base, 'local_fixture', role)).toThrow();
    }
    expect(() => withFixturePassword(base, undefined)).toThrow();
    expect(() => withFixturePassword(base, '')).toThrow();
    expect(() => withFixturePassword(base, 'has space')).toThrow();
    expect(() => withFixturePassword(base, 'a@b')).toThrow();
  });
});
