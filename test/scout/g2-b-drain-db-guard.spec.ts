import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  G2_B_CLUSTER_MARKER,
  G2_B_DATABASE_MARKER,
  g2BDrainTestTarget,
  withFixturePassword,
} from '../utils/g2-b-drain-db';

const base = 'postgresql://b_super@127.0.0.1:55461/g2_b_drain_disposable';
const ack = 'g2_b_drain_disposable:55461';

describe('S7-3 B/drain PG17 disposable target guard', () => {
  it('accepts a confirmed loopback target and strips only Prisma options for psql', () => {
    expect(g2BDrainTestTarget(`${base}?schema=public&connection_limit=2`, ack)).toEqual({
      prismaUrl: `${base}?schema=public&connection_limit=2&connect_timeout=5`,
      psqlUrl: `${base}?connect_timeout=5`,
      maintenanceUrl: `postgresql://b_super@127.0.0.1:55461/postgres?connect_timeout=5`,
      port: 55461,
    });
  });
  it.each([
    base.replace('127.0.0.1', 'localhost'),
    base.replace('127.0.0.1', 'db.supabase.co'),
    base.replace('55461', '5432'),
    base.replace('55461', '6543'),
    base.replace('55461', '55439'),
    base.replace('55461', '70000'),
    base.replace('g2_b_drain_disposable', 'g2_tq0_disposable'),
    base.replace('g2_b_drain_disposable', 'g2_s5_etq0_disposable'),
    base.replace('55461', '54325'),
    base.replace('g2_b_drain_disposable', 'g2_ledger_expand_disposable'),
    base.replace('g2_b_drain_disposable', 'postgres'),
    base.replace('b_super@', 'service_role@'),
    base.replace('b_super@', 'b_super:secret@'),
    base.replace('b_super@', 'postgres@'),
    base.replace('55461', '54321'),
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
    expect(() => g2BDrainTestTarget(url, ack)).toThrow();
  });
  it('refuses absent, mistaken or port-mismatched confirmation', () => {
    expect(() => g2BDrainTestTarget(base)).toThrow();
    expect(() => g2BDrainTestTarget(base, 'g2_b_drain_disposable')).toThrow();
    expect(() => g2BDrainTestTarget(base, 'g2_b_drain_disposable:55462')).toThrow();
    expect(() => g2BDrainTestTarget(base, 'g2_tq0_disposable:55461')).toThrow();
  });
  it('pins distinctive, non-blank fixture markers that bootstrap carries verbatim', () => {
    // Both markers are literals: nothing in process.env can change them, so a blank or foreign
    // cluster_name / database comment is refused before DROP or bootstrap touches a server.
    expect(G2_B_CLUSTER_MARKER).toBe('b-disposable-pg17');
    expect(G2_B_DATABASE_MARKER).toBe('b-g2-drain-synthetic-disposable-fixture-safe-to-drop');
    for (const marker of [G2_B_CLUSTER_MARKER, G2_B_DATABASE_MARKER]) {
      expect(marker).toMatch(/^b-[a-z0-9-]{8,}$/);
      expect(marker).toContain('disposable');
    }
    const bootstrap = readFileSync(resolve(__dirname, '../utils/g2-b-drain-bootstrap.sh'), 'utf8');
    expect(bootstrap).toContain(`CLUSTER_MARKER=${G2_B_CLUSTER_MARKER}\n`);
    expect(bootstrap).toContain(`DB_MARKER=${G2_B_DATABASE_MARKER}\n`);
    expect(bootstrap).not.toMatch(/CLUSTER_MARKER=\$\{|DB_MARKER=\$\{/);
  });
  it('attaches the fixture password only from the environment and only in plain form', () => {
    expect(withFixturePassword(base, 'local_fixture')).toBe(
      'postgresql://b_super:local_fixture@127.0.0.1:55461/g2_b_drain_disposable',
    );
    expect(withFixturePassword(base, 'local_fixture', 'service_role')).toBe(
      'postgresql://service_role:local_fixture@127.0.0.1:55461/g2_b_drain_disposable',
    );
    expect(withFixturePassword(base, 'local_fixture', 'postgres')).toBe(
      'postgresql://postgres:local_fixture@127.0.0.1:55461/g2_b_drain_disposable',
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
