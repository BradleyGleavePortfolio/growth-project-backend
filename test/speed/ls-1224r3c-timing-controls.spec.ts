/**
 * LS-1224R3C independent timing controls. B-TEST only; never merge.
 * Executes the actual reviewed shared loop and budget assertion using a
 * controlled clock. No app startup, database or product edits.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { runInNewContext } from 'vm';
import ts from 'typescript';

const file = join(__dirname, 'coach-busy-reads.speed.spec.ts');
const source = readFileSync(file, 'utf8');
const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
let loop: string | undefined;
let budget: string | undefined;
const walk = (node: ts.Node): void => {
  if (ts.isForOfStatement(node) && node.expression.getText(ast) === 'reads(now)') loop = node.getText(ast);
  if (
    ts.isCallExpression(node) && node.expression.getText(ast) === 'it' &&
    node.arguments[0]?.getText(ast).includes("every read's median and worst timed call")
  ) budget = node.arguments[1]?.getText(ast);
  ts.forEachChild(node, walk);
};
walk(ast);
if (!loop || !budget) throw new Error('Actual timing loop or budget assertion missing');
const transpile = (text: string) => ts.transpileModule(text, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

interface Row { problem: string | null; median: number; worst: number }

async function runDurations(measured: number[], warm = 0) {
  const results: Row[] = [];
  let calls = 0;
  let clock = 0;
  let ending = false;
  await runInNewContext(transpile(`(async () => { ${loop} })()`), {
    reads: () => [{ screen: 'probe', path: '/actual', check: () => null }],
    now: new Date('2026-11-05T12:00:00Z'),
    base: 'http://fixture.invalid/api',
    TOKEN: 'reviewer-fixture-token',
    WARMUP: 1,
    TIMED: measured.length,
    performance: {
      now: () => {
        if (ending) {
          clock += calls === 1 ? warm : measured[calls - 2];
          ending = false;
        } else ending = true;
        return clock;
      },
    },
    Buffer,
    median: (xs: number[]) => [...xs].sort((a, b) => a - b)[7],
    results,
    fetch: async () => {
      calls += 1;
      return { status: 200, text: async () => '{"ok":true}' };
    },
  }, { filename: 'actual-speed-timing-loop.js' });
  expect(calls).toBe(1 + measured.length);
  expect(results).toHaveLength(1);
  expect(results[0].problem).toBeNull();
  let thrown: unknown;
  try {
    runInNewContext(transpile(`(${budget})()`), { results, BUDGET_MS: 500, expect });
  } catch (error) { thrown = error; }
  return thrown;
}

describe('LS-1224R3C actual shared-loop timing controls', () => {
  it.each(Array.from({ length: 15 }, (_, n) => n))(
    'fails when measured position %i alone exceeds the limit',
    async (position) => {
      const runs = Array(15).fill(10);
      runs[position] = 501;
      expect(await runDurations(runs)).toBeDefined();
    },
  );

  it('accepts 499 ms on every measured read', async () => {
    expect(await runDurations(Array(15).fill(499))).toBeUndefined();
  });

  it('accepts exactly 500 ms as the inclusive budget', async () => {
    expect(await runDurations(Array(15).fill(500))).toBeUndefined();
  });

  it('does not count a slow warm-up as measured latency', async () => {
    expect(await runDurations(Array(15).fill(10), 900)).toBeUndefined();
  });

  it('rejects a fractional overrun, not only whole-millisecond delays', async () => {
    expect(await runDurations(Array(15).fill(500.1))).toBeDefined();
  });
});
