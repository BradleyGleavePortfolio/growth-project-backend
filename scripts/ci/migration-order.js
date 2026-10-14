'use strict';

// No database or dependencies. Run from the repository root after fetching main.
const { execFileSync } = require('node:child_process');

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function directories(ref) {
  return git('ls-tree', '-d', '--name-only', '-z', `${ref}:prisma/migrations`)
    .split('\0')
    .filter(Boolean);
}

function check() {
  const main = git('rev-parse', '--verify', 'origin/main^{commit}').trim();
  const base = git('merge-base', main, 'HEAD').trim();
  const mainDirs = directories(main);
  // Default string sort, not locale/numeric sort: Prisma orders by directory name.
  const newest = [...mainDirs].sort().pop();
  if (!newest) throw new Error('origin/main has no migration directories');
  const baseDirs = new Set(directories(base));
  const headDirs = directories('HEAD');
  const headSet = new Set(headDirs);
  const addedFiles = git(
    'diff', '--name-only', '-z', '--diff-filter=A', '--no-renames',
    base, 'HEAD', '--', 'prisma/migrations/',
  ).split('\0');
  const addedDirs = [...new Set(addedFiles
    .map((file) => /^prisma\/migrations\/([^/]+)\//.exec(file)?.[1])
    .filter((dir) => dir && headSet.has(dir) && !baseDirs.has(dir)))].sort();

  process.stdout.write(`migration-order: main's newest is ${newest}.\n`);
  process.stdout.write(`migration-order: new directories: ${addedDirs.join(', ') || '(none)'}.\n`);
  let failed = false;
  function fail(dir, reason) {
    process.stderr.write(
      `migration-order: ${dir} ${reason}; main's newest is ${newest}; rename it above ${newest} with a unique timestamp prefix.\n`,
    );
    failed = true;
  }
  for (const dir of addedDirs) {
    if (dir <= newest) fail(dir, 'sorts at or below main');
  }

  // Check the whole tree, not just the additions. Include main to catch a stale
  // PR whose prefix now collides with a directory that will arrive on merge.
  const prefixes = new Map();
  for (const dir of [...new Set([...mainDirs, ...headDirs])].sort()) {
    const prefix = /^(\d+)(?:_|$)/.exec(dir)?.[1];
    if (!prefix) continue;
    const previous = prefixes.get(prefix);
    if (previous) fail(dir, `shares timestamp prefix ${prefix} with ${previous}`);
    else prefixes.set(prefix, dir);
  }
  if (!failed) {
    process.stdout.write(addedDirs.length
      ? 'migration-order: all new migrations sort above main; timestamp prefixes are unique.\n'
      : 'migration-order: no new migrations; timestamp prefixes are unique.\n');
  }
  return failed ? 1 : 0;
}

try {
  process.exitCode = check();
} catch (error) {
  process.stderr.write(`migration-order: unable to check migrations: ${error.message}\n`);
  process.exitCode = 2;
}
