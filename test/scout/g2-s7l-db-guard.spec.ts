import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  G2_S7L_CLUSTER_MARKER,
  G2_S7L_DATABASE_MARKER,
  g2S7lTestTarget,
  withFixturePassword,
} from '../utils/g2-s7l-db';

const base = 'postgresql://s7l_super@127.0.0.1:55641/g2_s7l_disposable';
const ack = 'g2_s7l_disposable:55641';

describe('S7-L PG17 disposable target guard', () => {
  it('accepts a confirmed loopback target and strips only Prisma options for psql', () => {
    expect(g2S7lTestTarget(`${base}?schema=public&connection_limit=2`, ack)).toEqual({
      prismaUrl: `${base}?schema=public&connection_limit=2&connect_timeout=5`,
      psqlUrl: `${base}?connect_timeout=5`,
      maintenanceUrl: `postgresql://s7l_super@127.0.0.1:55641/postgres?connect_timeout=5`,
      port: 55641,
    });
  });
  it.each([
    base.replace('127.0.0.1', 'localhost'),
    base.replace('127.0.0.1', 'db.supabase.co'),
    base.replace('55641', '5432'),
    base.replace('55641', '6543'),
    base.replace('55641', '55439'),
    base.replace('55641', '70000'),
    base.replace('55641', '55461'),
    base.replace('55641', '55471'),
    base.replace('55641', '55481'),
    base.replace('55641', '55491'),
    base.replace('55641', '55501'),
    base.replace('55641', '55511'),
    base.replace('55641', '55642'),
    base.replace('g2_s7l_disposable', 'g2_b_drain_disposable'),
    base.replace('g2_s7l_disposable', 'g2_r_ready_disposable'),
    base.replace('g2_s7l_disposable', 'g2_nq1_disposable'),
    base.replace('g2_s7l_disposable', 'g2_c_disposable'),
    base.replace('g2_s7l_disposable', 'g2_s8b_disposable'),
    base.replace('s7l_super@', 'b_super@'),
    base.replace('s7l_super@', 'r_super@'),
    base.replace('s7l_super@', 'nq1_super@'),
    base.replace('s7l_super@', 'c_super@'),
    base.replace('s7l_super@', 's8b_super@'),
    base.replace('g2_s7l_disposable', 'g2_tq0_disposable'),
    base.replace('g2_s7l_disposable', 'g2_s5_etq0_disposable'),
    base.replace('55641', '54325'),
    base.replace('g2_s7l_disposable', 'g2_ledger_expand_disposable'),
    base.replace('g2_s7l_disposable', 'postgres'),
    base.replace('s7l_super@', 'service_role@'),
    base.replace('s7l_super@', 's7l_super:secret@'),
    base.replace('s7l_super@', 'postgres@'),
    base.replace('55641', '54321'),
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
    expect(() => g2S7lTestTarget(url, ack)).toThrow();
  });
  it('refuses absent, mistaken or port-mismatched confirmation', () => {
    expect(() => g2S7lTestTarget(base)).toThrow();
    expect(() => g2S7lTestTarget(base, 'g2_s7l_disposable')).toThrow();
    expect(() => g2S7lTestTarget(base, 'g2_s7l_disposable:55643')).toThrow();
    expect(() => g2S7lTestTarget(base, 'g2_tq0_disposable:55641')).toThrow();
    expect(() => g2S7lTestTarget(base, 'g2_b_drain_disposable:55641')).toThrow();
    expect(() => g2S7lTestTarget(base, 'g2_r_ready_disposable:55641')).toThrow();
    expect(() => g2S7lTestTarget(base, 'g2_nq1_disposable:55641')).toThrow();
    expect(() => g2S7lTestTarget(base, 'g2_c_disposable:55641')).toThrow();
    expect(() => g2S7lTestTarget(base, 'g2_s8b_disposable:55641')).toThrow();
  });
  it('pins distinctive, non-blank fixture markers that bootstrap carries verbatim', () => {
    // Both markers are literals: nothing in process.env can change them, so a blank or foreign
    // cluster_name / database comment is refused before DROP or bootstrap touches a server.
    expect(G2_S7L_CLUSTER_MARKER).toBe('s7l-disposable-pg17');
    expect(G2_S7L_DATABASE_MARKER).toBe(
      's7l-g2-run-lifecycle-synthetic-disposable-fixture-safe-to-drop',
    );
    for (const marker of [G2_S7L_CLUSTER_MARKER, G2_S7L_DATABASE_MARKER]) {
      expect(marker).toMatch(/^s7l-[a-z0-9-]{8,}$/);
      expect(marker).toContain('disposable');
    }
    const bootstrap = readFileSync(resolve(__dirname, '../utils/g2-s7l-bootstrap.sh'), 'utf8');
    expect(bootstrap).toContain(`CLUSTER_MARKER=${G2_S7L_CLUSTER_MARKER}\n`);
    expect(bootstrap).toContain(`DB_MARKER=${G2_S7L_DATABASE_MARKER}\n`);
    expect(bootstrap).not.toMatch(/CLUSTER_MARKER=\$\{|DB_MARKER=\$\{/);
  });
  it('attaches the fixture password only from the environment and only in plain form', () => {
    expect(withFixturePassword(base, 'local_fixture')).toBe(
      'postgresql://s7l_super:local_fixture@127.0.0.1:55641/g2_s7l_disposable',
    );
    expect(withFixturePassword(base, 'local_fixture', 'service_role')).toBe(
      'postgresql://service_role:local_fixture@127.0.0.1:55641/g2_s7l_disposable',
    );
    expect(withFixturePassword(base, 'local_fixture', 'postgres')).toBe(
      'postgresql://postgres:local_fixture@127.0.0.1:55641/g2_s7l_disposable',
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
});
