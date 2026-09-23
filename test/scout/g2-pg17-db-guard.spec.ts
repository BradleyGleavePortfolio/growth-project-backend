import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  G2_PG17_CLUSTER_MARKER,
  G2_PG17_DATABASE_MARKER,
  g2Pg17TestTarget,
  withFixturePassword,
} from '../utils/g2-pg17-db';

const base = 'postgresql://s5_super@127.0.0.1:55417/g2_s5_etq0_disposable';
const ack = 'g2_s5_etq0_disposable:55417';

describe('S5 G2 PG17 disposable target guard', () => {
  it('accepts a confirmed loopback target and strips only Prisma options for psql', () => {
    expect(g2Pg17TestTarget(`${base}?schema=public&connection_limit=2`, ack)).toEqual({
      prismaUrl: `${base}?schema=public&connection_limit=2&connect_timeout=5`,
      psqlUrl: `${base}?connect_timeout=5`,
      maintenanceUrl: `postgresql://s5_super@127.0.0.1:55417/postgres?connect_timeout=5`,
      port: 55417,
    });
  });
  it.each([
    base.replace('127.0.0.1', 'localhost'),
    base.replace('127.0.0.1', 'db.supabase.co'),
    base.replace('55417', '5432'),
    base.replace('55417', '6543'),
    base.replace('55417', '55439'),
    base.replace('55417', '70000'),
    base.replace('g2_s5_etq0_disposable', 'g2_tq0_disposable'),
    base.replace('g2_s5_etq0_disposable', 'g2_ledger_expand_disposable'),
    base.replace('g2_s5_etq0_disposable', 'postgres'),
    base.replace('s5_super@', 'service_role@'),
    base.replace('s5_super@', 's5_super:secret@'),
    base.replace('s5_super@', 'postgres@'),
    base.replace('55417', '54321'),
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
    expect(() => g2Pg17TestTarget(url, ack)).toThrow();
  });
  it('refuses absent, mistaken or port-mismatched confirmation', () => {
    expect(() => g2Pg17TestTarget(base)).toThrow();
    expect(() => g2Pg17TestTarget(base, 'g2_s5_etq0_disposable')).toThrow();
    expect(() => g2Pg17TestTarget(base, 'g2_s5_etq0_disposable:55418')).toThrow();
    expect(() => g2Pg17TestTarget(base, 'g2_tq0_disposable:55417')).toThrow();
  });
  it('pins distinctive, non-blank fixture markers that bootstrap carries verbatim', () => {
    // Both markers are literals: nothing in process.env can change them, so a blank or foreign
    // cluster_name / database comment is refused before DROP or bootstrap touches a server.
    expect(G2_PG17_CLUSTER_MARKER).toBe('s5-disposable-pg17');
    expect(G2_PG17_DATABASE_MARKER).toBe('s5-g2-etq0-synthetic-disposable-fixture-safe-to-drop');
    for (const marker of [G2_PG17_CLUSTER_MARKER, G2_PG17_DATABASE_MARKER]) {
      expect(marker).toMatch(/^s5-[a-z0-9-]{8,}$/);
      expect(marker).toContain('disposable');
    }
    const bootstrap = readFileSync(resolve(__dirname, '../utils/g2-pg17-bootstrap.sh'), 'utf8');
    expect(bootstrap).toContain(`CLUSTER_MARKER=${G2_PG17_CLUSTER_MARKER}\n`);
    expect(bootstrap).toContain(`DB_MARKER=${G2_PG17_DATABASE_MARKER}\n`);
    expect(bootstrap).not.toMatch(/CLUSTER_MARKER=\$\{|DB_MARKER=\$\{/);
  });
  it('attaches the fixture password only from the environment and only in plain form', () => {
    expect(withFixturePassword(base, 'local_fixture')).toBe(
      'postgresql://s5_super:local_fixture@127.0.0.1:55417/g2_s5_etq0_disposable',
    );
    expect(withFixturePassword(base, 'local_fixture', 'service_role')).toBe(
      'postgresql://service_role:local_fixture@127.0.0.1:55417/g2_s5_etq0_disposable',
    );
    expect(withFixturePassword(base, 'local_fixture', 'postgres')).toBe(
      'postgresql://postgres:local_fixture@127.0.0.1:55417/g2_s5_etq0_disposable',
    );
    // Only the explicit fixture matrix may log in; API roles and arbitrary names are refused.
    for (const role of ['anon', 'authenticated', 'authenticator', 'user', 'g2_ledger_owner', '']) {
      expect(() => withFixturePassword(base, 'local_fixture', role)).toThrow();
    }
    expect(() => withFixturePassword(base, undefined)).toThrow();
    expect(() => withFixturePassword(base, '')).toThrow();
    expect(() => withFixturePassword(base, 'has space')).toThrow();
    expect(() => withFixturePassword(base, 'a@b')).toThrow();
  });
});
