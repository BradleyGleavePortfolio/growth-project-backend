// S8-F guard unit test: derived by substitution from test/scout/g2-s8b-db-guard.spec.ts (unchanged).
// 55643 is only an EXAMPLE loopback port for the guard test; the real lane port is chosen by S1.
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  G2_S8F_CLUSTER_MARKER,
  G2_S8F_DATABASE_MARKER,
  g2S8fTestTarget,
  withFixturePassword,
} from '../utils/g2-s8f-db';

const base = 'postgresql://s8f_super@127.0.0.1:55643/g2_s8f_disposable';
const ack = 'g2_s8f_disposable:55643';

describe('S8-F PG17 disposable target guard', () => {
  it('accepts a confirmed loopback target and strips only Prisma options for psql', () => {
    expect(g2S8fTestTarget(`${base}?schema=public&connection_limit=2`, ack)).toEqual({
      prismaUrl: `${base}?schema=public&connection_limit=2&connect_timeout=5`,
      psqlUrl: `${base}?connect_timeout=5`,
      maintenanceUrl: `postgresql://s8f_super@127.0.0.1:55643/postgres?connect_timeout=5`,
      port: 55643,
    });
  });
  it.each([
    base.replace('127.0.0.1', 'localhost'),
    base.replace('127.0.0.1', 'db.supabase.co'),
    base.replace('55643', '5432'),
    base.replace('55643', '6543'),
    base.replace('55643', '55439'),
    base.replace('55643', '70000'),
    base.replace('55643', '55461'),
    base.replace('55643', '55471'),
    base.replace('55643', '55481'),
    base.replace('55643', '55491'),
    base.replace('55643', '55501'),
    base.replace('55643', '55511'),
    base.replace('55643', '55641'),
    base.replace('55643', '55642'),
    base.replace('g2_s8f_disposable', 'g2_b_drain_disposable'),
    base.replace('g2_s8f_disposable', 'g2_r_ready_disposable'),
    base.replace('g2_s8f_disposable', 'g2_nq1_disposable'),
    base.replace('g2_s8f_disposable', 'g2_c_disposable'),
    base.replace('g2_s8f_disposable', 'g2_s7l_disposable'),
    base.replace('g2_s8f_disposable', 'g2_s8b_disposable'),
    base.replace('g2_s8f_disposable', 'g2_s8c_disposable'),
    base.replace('s8f_super@', 'b_super@'),
    base.replace('s8f_super@', 'r_super@'),
    base.replace('s8f_super@', 'nq1_super@'),
    base.replace('s8f_super@', 'c_super@'),
    base.replace('s8f_super@', 's7l_super@'),
    base.replace('s8f_super@', 's8b_super@'),
    base.replace('s8f_super@', 's8c_super@'),
    base.replace('g2_s8f_disposable', 'g2_tq0_disposable'),
    base.replace('g2_s8f_disposable', 'g2_s5_etq0_disposable'),
    base.replace('55643', '54325'),
    base.replace('g2_s8f_disposable', 'g2_ledger_expand_disposable'),
    base.replace('g2_s8f_disposable', 'postgres'),
    base.replace('s8f_super@', 'service_role@'),
    base.replace('s8f_super@', 's8f_super:secret@'),
    base.replace('s8f_super@', 'postgres@'),
    base.replace('55643', '54321'),
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
    expect(() => g2S8fTestTarget(url, ack)).toThrow();
  });
  it('refuses absent, mistaken or port-mismatched confirmation', () => {
    expect(() => g2S8fTestTarget(base)).toThrow();
    expect(() => g2S8fTestTarget(base, 'g2_s8f_disposable')).toThrow();
    expect(() => g2S8fTestTarget(base, 'g2_s8f_disposable:55644')).toThrow();
    expect(() => g2S8fTestTarget(base, 'g2_tq0_disposable:55643')).toThrow();
    expect(() => g2S8fTestTarget(base, 'g2_b_drain_disposable:55643')).toThrow();
    expect(() => g2S8fTestTarget(base, 'g2_r_ready_disposable:55643')).toThrow();
    expect(() => g2S8fTestTarget(base, 'g2_nq1_disposable:55643')).toThrow();
    expect(() => g2S8fTestTarget(base, 'g2_c_disposable:55643')).toThrow();
    expect(() => g2S8fTestTarget(base, 'g2_s7l_disposable:55643')).toThrow();
    expect(() => g2S8fTestTarget(base, 'g2_s8b_disposable:55643')).toThrow();
    expect(() => g2S8fTestTarget(base, 'g2_s8c_disposable:55643')).toThrow();
  });
  it('pins distinctive, non-blank fixture markers that bootstrap carries verbatim', () => {
    // Both markers are literals: nothing in process.env can change them, so a blank or foreign
    // cluster_name / database comment is refused before DROP or bootstrap touches a server.
    expect(G2_S8F_CLUSTER_MARKER).toBe('s8f-disposable-pg17');
    expect(G2_S8F_DATABASE_MARKER).toBe(
      's8f-g2-native-reader-synthetic-disposable-fixture-safe-to-drop',
    );
    for (const marker of [G2_S8F_CLUSTER_MARKER, G2_S8F_DATABASE_MARKER]) {
      expect(marker).toMatch(/^s8f-[a-z0-9-]{8,}$/);
      expect(marker).toContain('disposable');
    }
    const bootstrap = readFileSync(resolve(__dirname, '../utils/g2-s8f-bootstrap.sh'), 'utf8');
    expect(bootstrap).toContain(`CLUSTER_MARKER=${G2_S8F_CLUSTER_MARKER}\n`);
    expect(bootstrap).toContain(`DB_MARKER=${G2_S8F_DATABASE_MARKER}\n`);
    expect(bootstrap).not.toMatch(/CLUSTER_MARKER=\$\{|DB_MARKER=\$\{/);
  });
  it('attaches the fixture password only from the environment and only in plain form', () => {
    expect(withFixturePassword(base, 'local_fixture')).toBe(
      'postgresql://s8f_super:local_fixture@127.0.0.1:55643/g2_s8f_disposable',
    );
    expect(withFixturePassword(base, 'local_fixture', 'service_role')).toBe(
      'postgresql://service_role:local_fixture@127.0.0.1:55643/g2_s8f_disposable',
    );
    expect(withFixturePassword(base, 'local_fixture', 'postgres')).toBe(
      'postgresql://postgres:local_fixture@127.0.0.1:55643/g2_s8f_disposable',
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
