'use strict';

// R107 lockfile hygiene. A package.json edit needs a package-lock.json update
// only when a DEPENDENCY-manifest field actually changes. R109: this is a
// dependency-INTEGRITY gate, so every uncertain case fails CLOSED (require the
// lockfile) and never prints a green message — we clear only on a positively
// confirmed no-dependency-change diff. Standalone CommonJS, unit-testable
// without the Danger DSL.

const DEPENDENCY_FIELDS = Object.freeze([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'overrides', // manifest pins that resolve into the lockfile tree
  'bundledDependencies',
  'bundleDependencies',
]);

// A JSONDiffForFile result maps each changed top-level key to { before, after }.
function isDiffEntry(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'before' in value &&
    'after' in value
  );
}

// 'changed' | 'unchanged' | 'unrecognized'. Unrecognized = not a plain object,
// or any top-level value that is not a { before, after } entry (a shape we do
// not understand and must not treat as safe).
function classifyPackageJsonDiff(jsonDiff) {
  if (jsonDiff === null || typeof jsonDiff !== 'object' || Array.isArray(jsonDiff)) {
    return 'unrecognized';
  }
  for (const key of Object.keys(jsonDiff)) {
    if (!isDiffEntry(jsonDiff[key])) return 'unrecognized';
  }
  const dependencyChanged = DEPENDENCY_FIELDS.some((field) => {
    const entry = jsonDiff[field];
    return entry && JSON.stringify(entry.before) !== JSON.stringify(entry.after);
  });
  return dependencyChanged ? 'changed' : 'unchanged';
}

// Fail closed: required unless we can positively confirm a recognized shape with
// no dependency change. Both 'changed' and 'unrecognized' therefore return true.
function lockfileUpdateRequired(jsonDiff) {
  return classifyPackageJsonDiff(jsonDiff) !== 'unchanged';
}

// Async seam over danger.git.JSONDiffForFile so the real integration path is
// unit-testable with a fake provider. The verdict lets the caller fail closed
// and never emit a success checkmark on an unknown shape / read failure.
async function shouldRequireLockfile(getJSONDiff, opts = {}) {
  let jsonDiff;
  try {
    jsonDiff = await getJSONDiff('package.json');
  } catch (err) {
    if (typeof opts.onReadError === 'function') opts.onReadError(err);
    return { required: true, recognized: false, reason: 'diff-read-failed' };
  }
  const klass = classifyPackageJsonDiff(jsonDiff);
  if (klass === 'unrecognized') {
    return { required: true, recognized: false, reason: 'unrecognized-diff-shape' };
  }
  if (klass === 'changed') {
    return { required: true, recognized: true, reason: 'dependency-field-changed' };
  }
  return { required: false, recognized: true, reason: 'no-dependency-change' };
}

module.exports = {
  DEPENDENCY_FIELDS,
  isDiffEntry,
  classifyPackageJsonDiff,
  lockfileUpdateRequired,
  shouldRequireLockfile,
};
