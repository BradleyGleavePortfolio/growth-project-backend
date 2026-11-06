import { readFileSync } from 'fs';
import { join } from 'path';
import { runInNewContext } from 'vm';
import ts from 'typescript';

interface TimedRead {
  screen: string;
  path: string;
  check: (body: string) => string | null;
}
interface ProbeRow {
  problem: string | null;
}

const file = join(__dirname, 'coach-busy-reads.speed.spec.ts');
const source = readFileSync(file, 'utf8');
const transpile = (text: string) => ts.transpileModule(text, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function summaryRead(): TimedRead {
  const captured: { lensReads?: (now: Date) => TimedRead[] } = {};
  const noSuite = () => undefined;
  runInNewContext(transpile(source + '\nmodule.exports.lensReads = reads;'), {
    require, URL, URLSearchParams, exports: captured, module: { exports: captured },
    process: { env: {} }, console: { log: noSuite },
    describe: Object.assign(noSuite, { skip: noSuite }),
  }, { filename: file });
  const read = captured.lensReads?.(new Date('2026-11-05T12:00:00Z'))
    .find((r) => r.path.includes('/summary?date='));
  if (!read) throw new Error('Actual client summary predicate missing');
  return read;
}

// Extract the actual ForOfStatement, not a copy of the behavior under test.
function timingLoop(): string {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  let loop: string | undefined;
  const walk = (node: ts.Node): void => {
    if (ts.isForOfStatement(node) && node.expression.getText(ast) === 'reads(now)') loop = node.getText(ast);
    ts.forEachChild(node, walk);
  };
  walk(ast);
  if (!loop) throw new Error('Actual timing loop missing');
  return loop;
}

async function probe(badAt: number | null, body = '{}', status = 200): Promise<ProbeRow> {
  const results: ProbeRow[] = [];
  let calls = 0;
  let clock = 0;
  const read = summaryRead();
  const valid = JSON.stringify({ food: [{ name: 'Speed test oats' }] });
  expect(read.check(valid)).toBeNull();
  expect(read.check(body)).not.toBeNull();
  await runInNewContext(transpile(`(async () => { ${timingLoop()} })()`), {
    reads: () => [read],
    now: new Date('2026-11-05T12:00:00Z'),
    base: 'http://fixture.invalid/api',
    TOKEN: 'reviewer-fixture-token',
    WARMUP: 1,
    TIMED: 15,
    performance: { now: () => ++clock },
    Buffer,
    median: (values: number[]) => [...values].sort((a, b) => a - b)[7],
    results,
    fetch: async () => {
      calls += 1;
      const bad = calls === badAt;
      return { status: bad ? status : 200, text: async () => bad ? body : valid };
    },
  }, { filename: 'actual-speed-timing-loop.js' });
  expect(calls).toBe(16);
  expect(results).toHaveLength(1);
  return results[0];
}

describe('LS-1224R2 B1: every timed response must hold its seeded data', () => {
  it.each([
    ['JSON error', '{"error":"Client not found"}'],
    ['non-JSON', '<html>temporary error</html>'],
    ['empty JSON', '{}'],
  ])('rejects an early %s even when the last timed response is valid', async (_label, body) => {
    expect((await probe(2, body)).problem).not.toBeNull();
  });

  it('control: accepts all 15 populated successful responses', async () => {
    expect((await probe(null)).problem).toBeNull();
  });

  it('control: rejects an early non-200 even if the last timed response is valid', async () => {
    expect((await probe(2, '{}', 503)).problem).not.toBeNull();
  });

  it('control: rejects the last timed response when it has no seeded data', async () => {
    expect((await probe(16)).problem).not.toBeNull();
  });
});
