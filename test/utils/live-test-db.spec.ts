/**
 * D5 (REL-14): destructive live-DB RLS suites reach only a local test database.
 * Unit-proves test/utils/live-test-db.ts and pins that every RLS suite the
 * rls-live-tests runner owns reads its URL through it (never DATABASE_URL).
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { liveTestDatabaseUrl } from './live-test-db';

const ROOT = path.join(__dirname, '..', '..');
const saved = { test: process.env.TEST_DATABASE_URL, app: process.env.DATABASE_URL };
afterEach(() => {
  for (const [k, v] of [
    ['TEST_DATABASE_URL', saved.test],
    ['DATABASE_URL', saved.app],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const ACCEPTED = [
  'postgresql://u:p@localhost:5432/rls_suite_01?connection_limit=1',
  'postgresql://u:p@127.0.0.1:5432/x?schema=emoji&connect_timeout=5',
  'postgresql://u:p@[::1]:5432/x',
  'postgres://u:p@postgres:5432/postgres',
];
const REFUSED = [
  'postgresql://u:p@db.abcdefgh.supabase.co:5432/postgres',
  'postgresql://u:p@aws-0-us-west-1.pooler.supabase.com:6543/postgres',
  'postgresql://u:p@localhost.evil.example:5432/postgres',
  'postgresql://u:p@10.0.0.5:5432/postgres',
  'not a url',
  // local-looking URLs whose options reroute the connection
  'postgresql://u:p@localhost:5432/throwaway?host=remote.example.invalid',
  'postgresql://u:p@localhost:5432/throwaway?hostaddr=203.0.113.7',
  'postgresql://u:p@localhost:5432/throwaway?ho%73t=remote.example.invalid',
  'postgresql://u:p@localhost:5432/throwaway?service=prod',
  'postgresql://u:p@localhost/throwaway?port=6543',
  'postgresql://u:p@localhost:5432,remote.example.invalid:5432/throwaway',
  'postgresql://u:p@localhost/throwaway%3Fhost%3Dremote.example.invalid',
  'postgresql:///throwaway?host=/var/run/postgresql',
  // duplicate and unknown options
  'postgresql://u:p@localhost/throwaway?schema=a&schema=b',
  'postgresql://u:p@localhost/throwaway?connection_limit=1&connection_limit=9',
  'postgresql://u:p@localhost/throwaway?sslmode=disable',
  'mysql://u:p@localhost/throwaway',
];

describe('liveTestDatabaseUrl', () => {
  it('never falls back to DATABASE_URL', () => {
    delete process.env.TEST_DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/app';
    expect(liveTestDatabaseUrl()).toBe('');
    expect(() => liveTestDatabaseUrl({ required: true })).toThrow(/TEST_DATABASE_URL is not set/);
  });

  it.each(ACCEPTED)('accepts %s', (url) => {
    process.env.TEST_DATABASE_URL = url;
    expect(liveTestDatabaseUrl({ required: true })).toBe(url);
  });

  it.each(REFUSED)('refuses %s', (url) => {
    process.env.TEST_DATABASE_URL = url;
    expect(() => liveTestDatabaseUrl()).toThrow(/refusing to run a destructive live-DB suite/);
  });

  // Non-connecting: the CI scripts' validator must give the same verdicts.
  it.each([...ACCEPTED.map((u) => [u, 0]), ...REFUSED.map((u) => [u, 1])])(
    'scripts/ci/local-db-url.mjs agrees on %s',
    (url, code) => {
      const run = spawnSync('node', [path.join(ROOT, 'scripts/ci/local-db-url.mjs'), String(url)]);
      expect(run.status).toBe(code);
    },
  );
});

describe('RLS suites use the guard', () => {
  // The G2/C1 operator proofs keep their own stricter guards (127.0.0.1 only,
  // pinned cluster markers, refused ports, typed confirmations).
  const own = /^test\/rls-(g2-|c1-)/;
  const suites = [
    ...fs.readdirSync(path.join(ROOT, 'test', 'rls')).map((f) => `test/rls/${f}`),
    ...fs
      .readdirSync(path.join(ROOT, 'test'))
      .filter((f) => /^rls-.*\.spec\.ts$/.test(f))
      .map((f) => `test/${f}`),
  ].filter((f) => f.endsWith('.spec.ts') && !own.test(f));

  it.each(suites)('%s reads its database only through liveTestDatabaseUrl', (suite) => {
    const src = fs.readFileSync(path.join(ROOT, suite), 'utf8');
    expect(src).toMatch(/liveTestDatabaseUrl\(/);
    expect(src).not.toMatch(/process\.env\.[A-Z0-9_]*DATABASE_URL\s*(\|\||\?\?|\)|;|,)/);
  });
});
