/**
 * LS-1224R3C independent timing controls. B-TEST only; never merge.
 * Executes the reviewed shared request loop and budget assertion in a VM,
 * not a substitute reimplementation. No app startup, database or product edits.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(__dirname, 'coach-busy-reads.speed.spec.ts'), 'utf8');
const start = source.indexOf('  const timings:');
const end = source.indexOf("  it('prints the run once", start);
if (start < 0 || end < 0) throw new Error('reviewed shared loop not found');
const loop = source.slice(start, end)
  .replace('const timings: { screen: string; read: string; path: string; runs: number[] }[]', 'const timings')
  .replace('new Map<string, unknown>()', 'new Map()')
  .replace('new Map<string, string>()', 'new Map()')
  .replace('const runs: number[]', 'const runs')
  .replace('const samples: unknown[]', 'const samples');
const budgetStart = source.indexOf("  it('keeps every timed read under half a second'");
if (budgetStart < 0) throw new Error('reviewed budget assertion not found');
const budget = source.slice(budgetStart, source.lastIndexOf('\n});'));

async function runDurations(measured: number[], warm = 0) {
  let index = -1;
  let clock = 0;
  let nextNowEnds = false;
  const routes: Array<() => Promise<void> | void> = [];
  const context: Record<string, unknown> = {
    root: '/api',
    seed: { coachId: 'seed-coach', clientIds: ['seed-client'] },
    app: { getHttpServer: () => ({}) },
    timings: undefined,
    seen: undefined,
    problem: undefined,
    WARM: 1,
    MEASURE: measured.length,
    BUDGET_MS: 500,
    SCREENS: [{ screen: 'probe', reads: [{ key: 'route', path: '/actual', hasSeededRows: () => true }] }],
    performance: {
      now: () => {
        if (nextNowEnds) {
          clock += index === 0 ? warm : measured[(index - 1) % measured.length];
          nextNowEnds = false;
        } else nextNowEnds = true;
        return clock;
      },
    },
    request: () => ({
      get: () => ({
        set: async () => {
          index += 1;
          return { status: 200, type: 'application/json', body: { ok: true } };
        },
      }),
    }),
    coachJwt: () => 'fixture',
    responseBodyProblem: () => null,
    percentile: (xs: number[], p: number) => {
      const sorted = [...xs].sort((a, b) => a - b);
      return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
    },
    expect,
    console: { table: () => undefined },
    it: (_title: string, fn: () => Promise<void> | void) => { routes.push(fn); },
  };
  const sandbox = vm.createContext(context);
  vm.runInContext(`${loop}\n${budget}`, sandbox);
  await routes[0]();
  expect(routes).toHaveLength(2);
  let thrown: unknown;
  try { await routes[1](); } catch (error) { thrown = error; }
  expect(index + 1).toBe(1 + measured.length);
  return thrown;
}

describe('LS-1224R3C actual shared-loop timing controls', () => {
  it.each(Array.from({ length: 15 }, (_, n) => n))(
    'fails when measured position %i alone exceeds the limit',
    async (position) => {
      const runs = Array(15).fill(10);
      runs[position] = 501;
      expect(String(await runDurations(runs))).toContain('over budget');
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
    expect(String(await runDurations(Array(15).fill(500.1)))).toContain('over budget');
  });
});
