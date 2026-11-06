import { readFileSync } from 'fs';
import { join } from 'path';
import { runInNewContext } from 'vm';
import ts from 'typescript';

interface Read {
  screen: string;
  path: string;
}

function catalogue(): Read[] {
  const file = join(__dirname, 'coach-busy-reads.speed.spec.ts');
  const captured: { lensReads?: (now: Date) => Read[] } = {};
  const noSuite = () => undefined;
  const code = ts.transpileModule(
    readFileSync(file, 'utf8') + '\nmodule.exports.lensReads = reads;',
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  runInNewContext(code, {
    require, URL, URLSearchParams, module: { exports: captured }, exports: captured,
    process: { env: {} }, console: { log: noSuite },
    describe: Object.assign(noSuite, { skip: noSuite }),
  }, { filename: file });
  if (!captured.lensReads) throw new Error('Actual speed-read catalogue missing');
  return captured.lensReads(new Date('2026-11-06T12:00:00Z'));
}

function canonical(path: string): string {
  const url = new URL(path, 'http://fixture.invalid');
  url.searchParams.sort();
  return url.pathname + url.search;
}

describe('LS-1224R3C B1: client-file opening without a cached roster row', () => {
  // Mobile c26d4dab: client-detail/useClientDetailData.ts:64-83 calls
  // loadClients(coachId, 'all', { silent: true }) on mount if the row is absent.
  // store/coachStore.ts:85-109 sends status=all, take=50, no first cursor.
  // Existing mobile clientArchiveCopy132.test.tsx:181-185 proves this normal
  // opening path; navigation/incomingLinks.ts:94-96 routes into the file.
  it('times the client-file all-roster first page, not the setup take=1 probe', () => {
    const paths = catalogue().filter((r) => r.screen === 'Client file').map((r) => canonical(r.path));
    expect(paths).toContain('/coach/clients?status=all&take=50');
  });

  it('control: extracts the actual existing setup all-roster take=1 probe', () => {
    const paths = catalogue().filter((r) => r.screen === 'Needs you').map((r) => canonical(r.path));
    expect(paths).toContain('/coach/clients?status=all&take=1');
  });

  it('control: extracts the actual existing active-roster take=50 read', () => {
    const paths = catalogue().filter((r) => r.screen === 'Client list').map((r) => canonical(r.path));
    expect(paths).toContain('/coach/clients?status=active&take=50');
  });
});
