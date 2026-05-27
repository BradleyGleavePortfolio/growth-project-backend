module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
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
