module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // `test/` holds the legacy/integration suites. `src/roman/voice` is added as
  // a SECOND, NARROWLY-SCOPED root so the Roman Phase 2 voice specs colocated
  // under src/roman/voice/__tests__/ are discovered (G9 requires the voice
  // specs to live in the source tree, and `npm test -- src/roman/voice` must
  // find them). The root is intentionally NOT the whole `src/` tree: dozens of
  // other src-colocated *.spec.ts files were never part of this default suite
  // (they predate this config and some need a live DB), so widening to all of
  // `src/` would silently pull unrelated, possibly-red suites into the
  // build-and-test lane. ts-jest transforms both roots identically.
  // v2-2 adds `src/community/ack` as a THIRD narrowly-scoped root so the coach
  // ack-signal specs colocated under src/community/ack/*.spec.ts are discovered
  // (the builder brief owns those spec files in the source tree). As with
  // src/roman/voice, the root is intentionally NOT the whole `src/` tree.
  roots: ['<rootDir>/test', '<rootDir>/src/roman/voice', '<rootDir>/src/community/ack'],
  testRegex: '\\.spec\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'mjs', 'json'],
  transform: {
    // ts-jest handles .ts test/source files.
    '^.+\\.ts$': ['ts-jest', { tsconfig: { strict: false, noImplicitAny: false, esModuleInterop: true } }],
    // expo-server-sdk v6 ships pure-ESM .js in node_modules. ts-jest's
    // TypeScript transform refuses to rewrite .js, so we hand that one
    // dep to babel-jest (configured via babel.config.js to emit CJS for
    // the test environment only — our runtime build stays CJS via tsc).
    '^.+\\.(js|mjs)$': 'babel-jest',
  },
  setupFiles: ['<rootDir>/test/jest.setup.ts'],
  // RLS specs connect to a real Postgres and hard-fail without one, so they are
  // excluded from this default suite (the build-and-test CI job has no DB) and
  // run only via jest.rls.config.js in the rls-live-tests job. Keep the two
  // configs in sync: anything ignored here must be matched there.
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    '<rootDir>/test/rls/',
    '<rootDir>/test/rls-.*\\.spec\\.ts$',
  ],
  // jose ships ESM-only source that ts-jest's CJS transform can't parse. Tests
  // don't exercise JWT verification (they stub JwksService directly), so the
  // mock just needs to make the import resolve.
  moduleNameMapper: {
    '^jose$': '<rootDir>/test/__mocks__/jose.ts',
  },
  // Whitelist expo-server-sdk (ESM-only since v6) so babel-jest transforms
  // it. Everything else under node_modules is still skipped — we don't want
  // a 10x test-startup penalty. This is the surgical "one ESM dep in a CJS
  // project" pattern documented at
  // https://jestjs.io/docs/ecmascript-modules#transformignorepatterns-customization
  transformIgnorePatterns: [
    'node_modules/(?!(expo-server-sdk)/)',
  ],
  collectCoverageFrom: ['src/**/*.ts'],
  coveragePathIgnorePatterns: ['/node_modules/', '/dist/'],
  testTimeout: 10000,
};
