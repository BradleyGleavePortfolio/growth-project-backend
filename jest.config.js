module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testRegex: '\\.spec\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: { strict: false, noImplicitAny: false, esModuleInterop: true } }],
  },
  setupFiles: ['<rootDir>/test/jest.setup.ts'],
  // jose ships ESM-only source that ts-jest's CJS transform can't parse. Tests
  // don't exercise JWT verification (they stub JwksService directly), so the
  // mock just needs to make the import resolve.
  moduleNameMapper: {
    '^jose$': '<rootDir>/test/__mocks__/jose.ts',
  },
  collectCoverageFrom: ['src/**/*.ts'],
  coveragePathIgnorePatterns: ['/node_modules/', '/dist/'],
  testTimeout: 10000,
};
