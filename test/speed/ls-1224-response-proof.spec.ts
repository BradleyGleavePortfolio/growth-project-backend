import { readFileSync } from 'fs';
import { join } from 'path';
import { runInNewContext } from 'vm';
import ts from 'typescript';

interface TimedRead {
  screen: string;
  path: string;
  check: (body: string) => string | null;
}

function catalogue(): TimedRead[] {
  const file = join(__dirname, 'coach-busy-reads.speed.spec.ts');
  const source = readFileSync(file, 'utf8') + '\nmodule.exports.lensReads = reads;';
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const captured: { lensReads?: (now: Date) => TimedRead[] } = {};
  const noSuite = () => undefined;
  runInNewContext(compiled, {
    require,
    URL,
    URLSearchParams,
    exports: captured,
    module: { exports: captured },
    process: { env: {} },
    console: { log: noSuite },
    describe: Object.assign(noSuite, { skip: noSuite }),
  }, { filename: file });
  if (!captured.lensReads) throw new Error('speed catalogue was not captured');
  return captured.lensReads(new Date('2026-11-05T12:00:00Z'));
}

describe('LS-1224 B2: populated reads cannot pass with no seeded data', () => {
  // The real summary handler returns a 200 {error} when scope lookup finds
  // no client (coach.service.ts:741-746). The fixture currently accepts it.
  // Seeded incoming messages and 45 purchases also require nonempty answers.
  it.each([
    ['/coach/messages/unread-count', '{}'],
    ['/coach/clients/5bee0000-0000-4000-8000-000000000001/summary', '{"error":"Client not found"}'],
    ['/v1/coach/money/summary', '{}'],
    ['/v1/coach/money/charges', '{"charges":[]}'],
  ])('rejects a 200 empty/error response for %s', (path, body) => {
    const read = catalogue().find((entry) => entry.path.split('?')[0] === path);
    if (!read) throw new Error(`speed catalogue is missing ${path}`);
    expect(read.check(body)).not.toBeNull();
  });
});
