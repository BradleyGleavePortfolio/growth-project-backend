import { cpSync, mkdtempSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { REPO_ROOT } from './member-content-scan';

/** Mutations never touch the checkout, including when Jest runs suites in parallel. */
export function createProbeCopy(): string {
  const copy = mkdtempSync(join(tmpdir(), 'ls1185-copy-'));
  const omit = new Set(['.git', 'node_modules', 'dist', 'coverage']);
  cpSync(REPO_ROOT, copy, {
    recursive: true,
    filter: (file) => file === REPO_ROOT || !omit.has(basename(file)),
  });
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(copy, 'node_modules'), 'dir');
  return copy;
}
