import { readFileSync } from 'fs';
import { join } from 'path';
import { runInNewContext } from 'vm';
import ts from 'typescript';

interface Read {
  screen: string;
  path: string;
  check: (body: string) => string | null;
}
function catalogue(): Read[] {
  const file = join(__dirname, 'coach-busy-reads.speed.spec.ts');
  const captured: { lensReads?: (now: Date) => Read[] } = {};
  const noSuite = () => undefined;
  const compiled = ts.transpileModule(
    readFileSync(file, 'utf8') + '\nmodule.exports.lensReads = reads;',
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  runInNewContext(compiled, {
    require, URL, URLSearchParams, exports: captured, module: { exports: captured },
    process: { env: {} }, console: { log: noSuite },
    describe: Object.assign(noSuite, { skip: noSuite }),
  }, { filename: file });
  if (!captured.lensReads) throw new Error('Actual read catalogue missing');
  return captured.lensReads(new Date('2026-11-05T12:00:00Z'));
}
const client = '5bee0000-0000-4000-8000-000000000001';
const macros = `/coach/clients/${client}/macros/current`;
const week = `/coach/clients/${client}/week`;

function check(path: string, body: unknown): string | null {
  const read = catalogue().find((r) => r.path.split('?')[0] === path);
  if (!read) throw new Error(`Missing catalogue read ${path}`);
  return read.check(JSON.stringify(body));
}

describe('LS-1224R2 B3: populated answers must contain seeded values, not just shape', () => {
  // The actual seed writes 2200/160/230/70 for each macro target (:227),
  // real workout assignments (:228-230), and paid purchase/ledger rows (:260-269).
  it.each([
    ['a missing macro value', macros, { calories_kcal: null }],
    ['a zero/default macro target', macros, { calories_kcal: 0, protein_g: 0, carbs_g: 0, fats_g: 0 }],
    ['five empty charges', '/v1/coach/money/charges', { charges: [{}, {}, {}, {}, {}] }],
    ['an empty assignment row', week, { assignments: [{}] }],
  ])('rejects %s despite valid JSON and expected keys/counts', (_label, path, body) => {
    expect(check(path, body)).not.toBeNull();
  });

  it('control: the actual seeded macro values are accepted', () => {
    expect(check(macros, {
      client_id: client,
      coach_id: '5bee0000-0000-4000-8000-000000000000',
      calories_kcal: 2200, protein_g: 160, carbs_g: 230, fats_g: 70,
      effective_from: '2026-08-02T00:00:00Z',
    })).toBeNull();
  });

  it('control: null macro response is already rejected', () => {
    expect(check(macros, null)).not.toBeNull();
  });
});
