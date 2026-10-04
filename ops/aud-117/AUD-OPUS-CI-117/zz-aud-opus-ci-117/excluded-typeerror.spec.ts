// AUD-OPUS-CI-117 probe fixture (audit branch only, never merged).
// A spec inside an excluded fixture tree: tsconfig.json excludes test/**/__fixtures__/**,
// but jest.config.js still discovers it (testRegex \.spec\.ts$, no ignore pattern for
// __fixtures__). It carries a deliberate type error that only a type checker reports;
// transpile-only jest runs it green. The unchanged guard must therefore go red.
const count: number = String('not a number');

describe('excluded fixture spec (AUD-OPUS-CI-117)', () => {
  it('runs under transpile-only jest despite a type error', () => {
    expect(typeof count).toBe('string');
  });
});
