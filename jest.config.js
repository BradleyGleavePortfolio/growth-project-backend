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
  // v3-1 adds `src/community/challenges` as a FOURTH narrowly-scoped root so the
  // pagination-enforcement specs colocated under
  // src/community/challenges/__tests__/*.spec.ts (D-040) are discovered. Same
  // rationale: the slice owns those spec files in the source tree, and the root
  // is intentionally NOT the whole `src/` tree (unrelated src-colocated specs
  // were never part of this default suite).
  // Roman P4 (Option C) adds '<rootDir>/src/notifications/__tests__' as a FIFTH
  // narrowly-scoped root so the first-payment specs colocated under
  // src/notifications/__tests__/*.spec.ts are discovered. Same rationale as the
  // roots above: this slice owns those spec files in the source tree, and the
  // root is intentionally the __tests__ folder ONLY — NOT the whole
  // src/notifications tree (the pre-existing src/notifications/
  // notifications-category.spec.ts was never part of this default suite and is
  // not pulled in by this scoped root). Both new specs use mocked Prisma/tx and
  // need no live DB.
  // v3-3 adds `src/community/voice` as a SIXTH narrowly-scoped root so the
  // voice-notes unit specs colocated under src/community/voice/__tests__/*.spec.ts
  // (service tenancy/upload-confirm/bucket-binding, provider TTL/namespace,
  // limit enforcement, and the R0 forbidden-cast scan) are discovered. Same
  // rationale as the roots above: this slice owns those spec files in the
  // source tree, and the root is intentionally NOT the whole `src/` tree
  // (unrelated src-colocated specs were never part of this default suite). All
  // four voice unit specs use mocked deps and need no live DB; the voice RLS
  // spec lives under test/rls/ and runs only via jest.rls.config.js.
  // v3-4 adds `src/community/search` and `src/community/wearable-prompts` as the
  // SEVENTH and EIGHTH narrowly-scoped roots so the community-search and
  // wearable-prompts unit specs colocated under those slices'
  // __tests__/*.spec.ts (search service + indexer; prompt-generator,
  // degraded-connector-fallback, and wearable-prompts service) are discovered.
  // Same rationale as the roots above: each slice owns its spec files in the
  // source tree, and the roots are intentionally the slice subtrees ONLY — NOT
  // the whole `src/` tree (unrelated src-colocated specs were never part of
  // this default suite). All v3-4 unit specs use mocked Prisma/deps and need no
  // live DB; the v3-4 RLS specs live under test/rls/ and run only via
  // jest.rls.config.js.
  // F2 adds `src/regimes` as a NINTH narrowly-scoped root so the named-regimes
  // unit specs colocated under src/regimes/__tests__/*.spec.ts (revision
  // retention, partial-refund decision, regimes service, and the roles pin)
  // are discovered. Same rationale as the roots above: this slice owns its
  // spec files in the source tree, and the root is intentionally the slice
  // subtree ONLY — NOT the whole `src/` tree. All four specs use mocked
  // Prisma/tx (via the asPrismaDouble helper) and need no live DB.
  // D5=B+γ adds `src/feature-flags` as a TENTH narrowly-scoped root so the
  // GET /me/feature-flags service + controller specs colocated under
  // src/feature-flags/__tests__/*.spec.ts are discovered. Same rationale as
  // the roots above: this slice owns those spec files in the source tree, and
  // the root is intentionally the slice subtree ONLY — NOT the whole `src/`
  // tree. Both specs use plain unit doubles (no Prisma, no live DB).
  // TM-2 adds `src/talent-marketplace` as an ELEVENTH narrowly-scoped root so
  // the job-listing service + hirer-verified guard unit specs colocated under
  // src/talent-marketplace/__tests__/*.spec.ts are discovered. Same rationale
  // as the roots above: this slice owns those spec files in the source tree,
  // and the root is intentionally the slice subtree ONLY — NOT the whole
  // `src/` tree. Both specs use mocked Prisma and need no live DB; the
  // JobListing RLS coverage lives under test/rls/ from TM-1.
  // IMPORTER-D adds `src/extension-pair` as a TWELFTH narrowly-scoped root so
  // the pairing-code unit specs colocated under
  // src/extension-pair/__tests__/*.spec.ts (service init/status/redeem,
  // controller binding, feature-flag guard, and the AuthService mint helper)
  // are discovered. Same rationale as the roots above: this slice owns those
  // spec files in the source tree, and the root is intentionally the slice
  // subtree ONLY — NOT the whole `src/` tree. All specs mock Prisma/Supabase
  // and need no live DB; the ExtensionPairCode RLS coverage lives under
  // test/rls/.
  roots: [
    '<rootDir>/test',
    '<rootDir>/src/roman/voice',
    '<rootDir>/src/community/ack',
    '<rootDir>/src/community/challenges',
    '<rootDir>/src/notifications/__tests__',
    '<rootDir>/src/community/voice',
    '<rootDir>/src/community/search',
    '<rootDir>/src/community/wearable-prompts',
    '<rootDir>/src/regimes',
    '<rootDir>/src/feature-flags',
    '<rootDir>/src/talent-marketplace',
    '<rootDir>/src/extension-pair',
    // IMPORTER-E adds `src/scout` as a narrowly-scoped root so the scout
    // progress/completion unit specs colocated under src/scout/*.spec.ts are
    // discovered. Same rationale as the roots above: this slice owns those spec
    // files in the source tree, and the root is intentionally NOT the whole
    // `src/` tree. All scout unit specs use mocked Prisma/notifications/analytics
    // and need no live DB.
    '<rootDir>/src/scout',
  ],
  testRegex: '\\.spec\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'mjs', 'json'],
  transform: {
    // ts-jest handles .ts test/source files, TRANSPILE-ONLY (isolatedModules).
    //
    // Why (B-CI-116, root cause of the "Jest worker ran out of memory" crashes
    // in build-and-test): without isolatedModules, ts-jest builds a full
    // TypeScript LanguageService in EVERY jest worker and type-checks each file
    // it transforms against the whole program, including the ~24 MB generated
    // Prisma client typings. Measured on main (forced GC, --runInBand): the
    // first spec alone leaves ~1.4 GB of heap, and the program keeps growing as
    // the worker reaches more of the codebase, so each of CI's three
    // long-lived workers converges on a full-repo type-check plus its test
    // runtime and crosses the 4 GB heap after ~300-400 s, on whichever small
    // suite it holds at that moment (community-message-shape.live.spec.ts,
    // scout/induction/contract.spec.ts, diagnostic-quiz-off.spec.ts). The same
    // specs transpile-only sit at ~0.1-0.45 GB.
    //
    // No type gate is lost: build-and-test's "Type-check" step (`npx tsc
    // --noEmit`, tsconfig.json, strict) runs before "Test" in the same
    // required job and type-checks every file jest can load (all of test/ and
    // src/, spec files included) under STRICTER options than the relaxed
    // overrides below. test/ci/jest-typecheck-gate.spec.ts pins that
    // invariant, so jest never becomes the only type check for any file.
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: {
          strict: false,
          noImplicitAny: false,
          esModuleInterop: true,
          isolatedModules: true,
        },
      },
    ],
    // expo-server-sdk v6 ships pure-ESM .js in node_modules. ts-jest's
    // TypeScript transform refuses to rewrite .js, so we hand that one
    // dep to babel-jest (configured via babel.config.js to emit CJS for
    // the test environment only — our runtime build stays CJS via tsc).
    '^.+\\.(js|mjs)$': 'babel-jest',
  },
  setupFiles: ['<rootDir>/test/jest.setup.ts'],
  // Print each suite's worker heap next to its PASS/FAIL line, so a memory
  // regression shows up in the CI log long before it becomes an OOM crash
  // (B-CI-116). Costs one process.memoryUsage() call per suite.
  logHeapUsage: true,
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
  transformIgnorePatterns: ['node_modules/(?!(expo-server-sdk)/)'],
  collectCoverageFrom: ['src/**/*.ts'],
  coveragePathIgnorePatterns: ['/node_modules/', '/dist/'],
  testTimeout: 10000,
  // S-DUNNING-R6: recycle a worker whose heap stays above 2 GB after a test
  // file. The build-and-test lane runs every suite in a few long-lived
  // workers under a 4 GB heap (ci.yml NODE_OPTIONS); retained module
  // registries accumulate across files until one worker OOM-aborts ("Jest
  // worker ran out of memory") on whichever suite it happens to hold. A fresh
  // worker per threshold crossing keeps every suite under the heap limit
  // without changing what runs or how.
  workerIdleMemoryLimit: '2GB',
};
