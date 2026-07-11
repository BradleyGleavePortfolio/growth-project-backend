// Regression tests for the Danger lockfile-relevance check (dangerfile.js §3)
// and its module scripts/lockfile-relevance.js. The check demands a lockfile
// update only when a package.json DEPENDENCY field changes, and — per R109 —
// fails CLOSED (requires the lockfile, no green message) on a read error or an
// unrecognized-but-non-throwing diff shape.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  lockfileUpdateRequired,
  classifyPackageJsonDiff,
  shouldRequireLockfile,
  DEPENDENCY_FIELDS,
} = require('../../scripts/lockfile-relevance');

// Mirrors danger.git.JSONDiffForFile(): each changed key maps to {before, after}.
const diff = (field: string, before: unknown, after: unknown) => ({ [field]: { before, after } });

describe('classifyPackageJsonDiff', () => {
  it.each([
    ['empty object', {}, 'unchanged'],
    ['scripts-only', diff('scripts', { a: '1' }, { a: '1', b: '2' }), 'unchanged'],
    ['version-only', diff('version', '1.0.0', '1.1.0'), 'unchanged'],
    ['dependency change', diff('dependencies', { a: '1' }, { a: '2' }), 'changed'],
    ['null', null, 'unrecognized'],
    ['string', 'x', 'unrecognized'],
    ['array', [], 'unrecognized'],
    // Well-formed object, wrong VALUE shape (future {added,removed} API, raw
    // string, null) — must never be read as safe.
    ['dep value not an entry', { dependencies: 'axios@^1' }, 'unrecognized'],
    ['dep value wrong keys', { dependencies: { added: {} } }, 'unrecognized'],
    ['good entry + weird key', { ...diff('scripts', 1, 2), weird: 'x' }, 'unrecognized'],
  ])('classifies %s as %s', (_name, input, expected) => {
    expect(classifyPackageJsonDiff(input)).toBe(expected);
  });
});

describe('lockfileUpdateRequired (fail-closed boolean)', () => {
  it.each([null, 'x', { dependencies: 'axios@^1' }])(
    'FAILS CLOSED (true) on hostile/missing diff %p (R109)',
    (bad) => expect(lockfileUpdateRequired(bad)).toBe(true),
  );

  it.each([
    diff('dependencies', undefined, { zod: '^4' }), // block appears
    diff('optionalDependencies', { sharp: '^0.33' }, undefined), // block removed
    diff('dependencies', { a: '1', z: '4' }, { z: '4', a: '1' }), // reorder → conservative true
  ])('requires a lockfile on dependency change #%#', (d) => {
    expect(lockfileUpdateRequired(d)).toBe(true);
  });

  it.each([
    {},
    diff('scripts', { a: '1' }, { a: '1', b: '2' }),
    diff('dependencies', { axios: '^1' }, { axios: '^1' }),
  ])('clears (false) only for a recognized no-dependency-change diff #%#', (d) => {
    expect(lockfileUpdateRequired(d)).toBe(false);
  });

  it('detects a change in each tracked field, and no-op when identical', () => {
    for (const field of DEPENDENCY_FIELDS) {
      expect(lockfileUpdateRequired(diff(field, {}, { pkg: '^1' }))).toBe(true);
      expect(lockfileUpdateRequired(diff(field, { pkg: '^1' }, { pkg: '^1' }))).toBe(false);
    }
  });

  it('requires a lockfile when only one of several changed fields is a dependency', () => {
    expect(
      lockfileUpdateRequired({
        ...diff('version', '1.0.0', '1.1.0'),
        ...diff('devDependencies', { jest: '^30.0.0' }, { jest: '^30.4.2' }),
      }),
    ).toBe(true);
  });
});

describe('shouldRequireLockfile (async seam over the real JSONDiffForFile path)', () => {
  it('queries the provider for package.json specifically', async () => {
    const seen: string[] = [];
    await shouldRequireLockfile(async (f: string) => (seen.push(f), {}));
    expect(seen).toEqual(['package.json']);
  });

  it('clears only on a recognized no-dependency-change diff', async () => {
    const v = await shouldRequireLockfile(async () => diff('scripts', { a: '1' }, { a: '2' }));
    expect(v).toEqual({ required: false, recognized: true, reason: 'no-dependency-change' });
  });

  it('requires the lockfile on a real dependency change', async () => {
    const v = await shouldRequireLockfile(async () => diff('dependencies', { a: '1' }, { a: '2' }));
    expect(v).toEqual({ required: true, recognized: true, reason: 'dependency-field-changed' });
  });

  it('FAILS CLOSED (no success path, no read-error) on an unrecognized shape', async () => {
    const onReadError = jest.fn();
    const v = await shouldRequireLockfile(async () => ({ dependencies: 'axios@^1' }), {
      onReadError,
    });
    expect(v).toEqual({ required: true, recognized: false, reason: 'unrecognized-diff-shape' });
    expect(onReadError).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED and reports the read error when the provider throws', async () => {
    const onReadError = jest.fn();
    const boom = new Error('diff unavailable');
    const v = await shouldRequireLockfile(
      async () => {
        throw boom;
      },
      { onReadError },
    );
    expect(v).toEqual({ required: true, recognized: false, reason: 'diff-read-failed' });
    expect(onReadError).toHaveBeenCalledWith(boom);
  });
});
