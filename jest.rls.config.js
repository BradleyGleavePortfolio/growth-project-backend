// Live-DB RLS suite config. These specs connect to a real Postgres
// (TEST_DATABASE_URL/DATABASE_URL) and HARD-FAIL when the DB is configured but
// unreachable, so they must NOT run in the default `build-and-test` job (no DB
// service). They run only in the `rls-live-tests` CI job, which provisions a
// postgres:15 service container. The default config (jest.config.js) excludes
// every path matched here via testPathIgnorePatterns — keep the two in sync.
const base = require('./jest.config.js');

module.exports = {
  ...base,
  displayName: 'rls-live',
  // The base config selects specs via testRegex; jest rejects testRegex and
  // testMatch together, so drop the inherited regex before setting testMatch.
  testRegex: undefined,
  // Match every DB-requiring RLS spec: the PR-RLS-01 helper suite under
  // test/rls/, plus the root-level test/rls-*.spec.ts policy/helper suites.
  testMatch: [
    '<rootDir>/test/rls/**/*.spec.ts',
    '<rootDir>/test/rls-*.spec.ts',
  ],
  // The base config ignores these paths; this config exists to run them, so
  // clear the inherited RLS ignores (keep node_modules/dist out regardless).
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
};
