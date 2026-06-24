// auto-flipper.spec.ts — coverage for the prod-readiness auto-flipper (H4.F).
//
// Exercises every branch of plan()/commit()/flip() with inline RegistryRow
// fixtures and a mocked child_process.execFileSync, asserting the three
// binding security invariants in particular:
//   - real mutation is refused unless READINESS_AUTO_FLIP=true
//   - the default runner shells out via execFileSync (argv, no shell string)
//   - no secret VALUE is ever emitted to a log — only `KEY=***`
//
// execFileSync is module-mocked so the default runFlyctl path can be driven
// without a real flyctl binary; the injectable `run` hook covers the
// success/failure/partial-failure matrix deterministically.

import { execFileSync } from 'node:child_process';
import {
  plan,
  commit,
  flip,
  __runFlyctlForTest,
  targetValueFor,
  autoFlipEnabled,
  auditEntry,
  redactSecretValues,
  flyErrorMessage,
  collectSecretValues,
  shouldCommit,
  FlyctlTimeoutError,
  AutoFlipperRegistryError,
  AUTO_FLIP_ENV,
  AUDIT_OPERATOR,
  FLY_BIN,
  FLY_BIN_ENV,
  FLY_BIN_DEFAULT,
  FLY_INSTALL_DOCS,
  FLY_TIMEOUT_MS,
  safeCauseName,
  assertFlyBinUnchanged,
  FlyBinIdentityMismatch,
  __resolveFlyBinForTest,
  __getResolvedFlyBinPathForTest,
  __getResolvedFlyBinIdentityForTest,
  __resetResolvedFlyBinForTest,
  __seedResolvedFlyBinPathWithoutIdentityForTest,
  type FlipPlan,
  type FlipResult,
  type FlyRunner,
  type RecheckCurrent,
  type FlyBinFs,
  type FlyBinStat,
} from './auto-flipper';
import * as autoFlipperExports from './auto-flipper';
import { RegistryParseError, type RegistryRow } from './registry-loader';

jest.mock('node:child_process', () => ({ execFileSync: jest.fn() }));
const execFileSyncMock = jest.mocked(execFileSync);

/** Build a well-formed auto-flippable row, overriding any field under test. */
function row(overrides: Partial<RegistryRow> = {}): RegistryRow {
  return {
    name: 'FEATURE_X',
    tier: 'feature',
    prod_default: 'ON',
    auto_flip_on_in_prod: true,
    owner: 'platform',
    description: 'a feature switch that defaults on in prod',
    ...overrides,
  };
}

/** A fixed clock so audit timestamps are deterministic in assertions. */
const FIXED_NOW = new Date('2026-06-19T12:00:00.000Z');
const fixedClock = (): Date => FIXED_NOW;

/** Env that authorises real mutation. */
const ENABLED_ENV: NodeJS.ProcessEnv = { [AUTO_FLIP_ENV]: 'true' };

/** Capture sink for log/audit lines. */
function makeSink(): { lines: string[]; log: (l: string) => void } {
  const lines: string[] = [];
  return { lines, log: (l: string) => lines.push(l) };
}

beforeEach(() => {
  execFileSyncMock.mockReset();
});

describe('targetValueFor', () => {
  it('maps prod_default ON to "true"', () => {
    expect(targetValueFor(row({ prod_default: 'ON' }))).toBe('true');
  });

  it('maps prod_default OFF to "false"', () => {
    expect(targetValueFor(row({ prod_default: 'OFF' }))).toBe('false');
  });

  it('returns null for MUST_SET (needs human judgement)', () => {
    expect(targetValueFor(row({ prod_default: 'MUST_SET' }))).toBeNull();
  });

  it('returns null for STUB_ALLOWED', () => {
    expect(targetValueFor(row({ prod_default: 'STUB_ALLOWED' }))).toBeNull();
  });
});

describe('autoFlipEnabled', () => {
  it('is true only for the exact string "true"', () => {
    expect(autoFlipEnabled({ [AUTO_FLIP_ENV]: 'true' })).toBe(true);
  });

  it('is false for "1", "TRUE", or unset', () => {
    expect(autoFlipEnabled({ [AUTO_FLIP_ENV]: '1' })).toBe(false);
    expect(autoFlipEnabled({ [AUTO_FLIP_ENV]: 'TRUE' })).toBe(false);
    expect(autoFlipEnabled({})).toBe(false);
  });
});

describe('plan', () => {
  it('dry-run with empty Fly secrets: every prod-required row is in to_set', () => {
    const registry = [
      row({ name: 'FEATURE_A', prod_default: 'ON' }),
      row({ name: 'FEATURE_B', prod_default: 'OFF' }),
      row({ name: 'FEATURE_C', prod_default: 'ON' }),
    ];
    const p = plan({ registry, current: {} });
    expect(p.to_set.map((r) => r.row.name)).toEqual(['FEATURE_A', 'FEATURE_B', 'FEATURE_C']);
    expect(p.already_set).toHaveLength(0);
    expect(p.to_skip).toHaveLength(0);
  });

  it('derives the correct target value per row in to_set', () => {
    const registry = [
      row({ name: 'ON_ONE', prod_default: 'ON' }),
      row({ name: 'OFF_ONE', prod_default: 'OFF' }),
    ];
    const p = plan({ registry, current: {} });
    const byName = Object.fromEntries(p.to_set.map((r) => [r.row.name, r.target]));
    expect(byName).toEqual({ ON_ONE: 'true', OFF_ONE: 'false' });
  });

  it('all Fly secrets present and matching: every row is already_set', () => {
    const registry = [
      row({ name: 'FEATURE_A', prod_default: 'ON' }),
      row({ name: 'FEATURE_B', prod_default: 'OFF' }),
    ];
    const current = { FEATURE_A: 'true', FEATURE_B: 'false' };
    const p = plan({ registry, current });
    expect(p.already_set.map((r) => r.row.name)).toEqual(['FEATURE_A', 'FEATURE_B']);
    expect(p.to_set).toHaveLength(0);
  });

  it('stale value (Fly has old, registry wants new) puts the row in to_set', () => {
    const registry = [row({ name: 'FEATURE_A', prod_default: 'ON' })];
    const p = plan({ registry, current: { FEATURE_A: 'false' } });
    expect(p.to_set.map((r) => r.row.name)).toEqual(['FEATURE_A']);
    expect(p.already_set).toHaveLength(0);
  });

  it('row with auto_flip_on_in_prod=false lands in to_skip (not-auto-flip)', () => {
    const registry = [row({ name: 'MANUAL', auto_flip_on_in_prod: false })];
    const p = plan({ registry, current: {} });
    expect(p.to_skip).toEqual([{ row: registry[0], reason: 'not-auto-flip' }]);
    expect(p.to_set).toHaveLength(0);
  });

  it('MUST_SET row is skipped as needs-human-judgement even if auto_flip is true', () => {
    const registry = [row({ name: 'DB_URL', prod_default: 'MUST_SET' })];
    const p = plan({ registry, current: {} });
    expect(p.to_skip).toEqual([{ row: registry[0], reason: 'needs-human-judgement' }]);
  });

  it('STUB_ALLOWED row is skipped as needs-human-judgement', () => {
    const registry = [row({ name: 'STUBBY', prod_default: 'STUB_ALLOWED' })];
    const p = plan({ registry, current: {} });
    expect(p.to_skip[0]).toEqual({ row: registry[0], reason: 'needs-human-judgement' });
  });

  it('partitions a mixed registry across all three buckets', () => {
    const registry = [
      row({ name: 'SET_ME', prod_default: 'ON' }), // to_set (missing)
      row({ name: 'OK_ALREADY', prod_default: 'ON' }), // already_set
      row({ name: 'SKIP_MANUAL', auto_flip_on_in_prod: false }), // skip
      row({ name: 'SKIP_MUST', prod_default: 'MUST_SET' }), // skip
    ];
    const p = plan({ registry, current: { OK_ALREADY: 'true' } });
    expect(p.to_set.map((r) => r.row.name)).toEqual(['SET_ME']);
    expect(p.already_set.map((r) => r.row.name)).toEqual(['OK_ALREADY']);
    expect(p.to_skip.map((r) => r.row.name)).toEqual(['SKIP_MANUAL', 'SKIP_MUST']);
  });

  it('treats an empty registry as a no-op plan', () => {
    const p = plan({ registry: [], current: {} });
    expect(p).toEqual({ to_set: [], already_set: [], to_skip: [] });
  });
});

describe('commit — refusal gate', () => {
  it('refuses without READINESS_AUTO_FLIP=true and never invokes the runner', async () => {
    const run = jest.fn();
    const p: FlipPlan = plan({ registry: [row()], current: {} });
    await expect(commit({ plan: p, env: {}, run })).rejects.toThrow(/READINESS_AUTO_FLIP=true/);
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses when the flag is set to a non-"true" value', async () => {
    const run = jest.fn();
    const p = plan({ registry: [row()], current: {} });
    await expect(commit({ plan: p, env: { [AUTO_FLIP_ENV]: 'yes' }, run })).rejects.toThrow(
      /refusing to commit/,
    );
    expect(run).not.toHaveBeenCalled();
  });
});

describe('commit — execution', () => {
  it('invokes the runner once per to_set row with the correct flyctl argv', async () => {
    const run = jest.fn<void, [readonly string[]]>();
    const p = plan({
      registry: [row({ name: 'FEATURE_A', prod_default: 'ON' })],
      current: {},
    });
    const res = await commit({ plan: p, env: ENABLED_ENV, run });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(['secrets', 'set', 'FEATURE_A=true']);
    expect(res.succeeded.map((r) => r.name)).toEqual(['FEATURE_A']);
    expect(res.failed).toHaveLength(0);
  });

  it('passes OFF rows the value "false" over argv', async () => {
    const run = jest.fn<void, [readonly string[]]>();
    const p = plan({ registry: [row({ name: 'KILL_SWITCH', prod_default: 'OFF' })], current: {} });
    await commit({ plan: p, env: ENABLED_ENV, run });
    expect(run).toHaveBeenCalledWith(['secrets', 'set', 'KILL_SWITCH=false']);
  });

  it('captures stderr into result.failed when a flip throws', async () => {
    const run: FlyRunner = () => {
      throw new Error('Error: insufficient permissions for app');
    };
    const p = plan({ registry: [row({ name: 'FEATURE_A' })], current: {} });
    const res = await commit({ plan: p, env: ENABLED_ENV, run });
    expect(res.succeeded).toHaveLength(0);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].row.name).toBe('FEATURE_A');
    expect(res.failed[0].error).toMatch(/insufficient permissions/);
  });

  it('does not early-abort: 5 rows, 1 fails -> 4 succeeded, 1 failed', async () => {
    const names = ['R1', 'R2', 'R3', 'R4', 'R5'];
    const registry = names.map((n) => row({ name: n, prod_default: 'ON' }));
    const run: FlyRunner = (args) => {
      if (args[2] === 'R3=true') throw new Error('R3 boom');
    };
    const p = plan({ registry, current: {} });
    const res = await commit({ plan: p, env: ENABLED_ENV, run });
    expect(res.succeeded.map((r) => r.name)).toEqual(['R1', 'R2', 'R4', 'R5']);
    expect(res.failed.map((f) => f.row.name)).toEqual(['R3']);
  });

  it('runs flips strictly sequentially (one inflight at a time, in order)', async () => {
    const registry = [
      row({ name: 'A', prod_default: 'ON' }),
      row({ name: 'B', prod_default: 'ON' }),
      row({ name: 'C', prod_default: 'ON' }),
    ];
    const order: string[] = [];
    let inflight = 0;
    const run: FlyRunner = (args) => {
      inflight += 1;
      expect(inflight).toBe(1); // never more than one concurrent flyctl
      order.push(String(args[2]));
      inflight -= 1;
    };
    const p = plan({ registry, current: {} });
    await commit({ plan: p, env: ENABLED_ENV, run });
    expect(order).toEqual(['A=true', 'B=true', 'C=true']);
  });

  it('is a no-op when to_set is empty (nothing to commit)', async () => {
    const run = jest.fn();
    const p = plan({
      registry: [row({ name: 'OK', prod_default: 'ON' })],
      current: { OK: 'true' },
    });
    const res = await commit({ plan: p, env: ENABLED_ENV, run });
    expect(run).not.toHaveBeenCalled();
    expect(res).toEqual({ succeeded: [], failed: [], skipped: [] });
  });
});

describe('commit — fatal security signals abort the per-row loop (R5 F002)', () => {
  it('FlyBinIdentityMismatch on row A aborts: commit throws, runner NOT invoked for row B', async () => {
    const run = jest.fn<void, [readonly string[]]>(() => {
      throw new FlyBinIdentityMismatch('FLY_BIN swapped: ino 2 -> 999, refusing');
    });
    const p = plan({
      registry: [
        row({ name: 'FEATURE_A', prod_default: 'ON' }),
        row({ name: 'FEATURE_B', prod_default: 'ON' }),
      ],
      current: {},
    });
    await expect(commit({ plan: p, env: ENABLED_ENV, run })).rejects.toThrow(
      FlyBinIdentityMismatch,
    );
    expect(run.mock.calls).toHaveLength(1);
    expect(run.mock.calls[0][0]).toEqual(['secrets', 'set', 'FEATURE_A=true']);
  });

  it('FlyctlTimeoutError on row A aborts: commit throws, runner NOT invoked for row B', async () => {
    const run = jest.fn<void, [readonly string[]]>(() => {
      throw new FlyctlTimeoutError('flyctl secrets set timed out after 60000ms');
    });
    const p = plan({
      registry: [
        row({ name: 'FEATURE_A', prod_default: 'ON' }),
        row({ name: 'FEATURE_B', prod_default: 'ON' }),
      ],
      current: {},
    });
    await expect(commit({ plan: p, env: ENABLED_ENV, run })).rejects.toThrow(FlyctlTimeoutError);
    expect(run.mock.calls).toHaveLength(1);
  });

  it('a generic Error on row A does NOT abort: row B is still attempted (per-row continue intact)', async () => {
    const run = jest.fn<void, [readonly string[]]>((args) => {
      if (args[2] === 'FEATURE_A=true') throw new Error('ordinary flyctl exec failure');
    });
    const p = plan({
      registry: [
        row({ name: 'FEATURE_A', prod_default: 'ON' }),
        row({ name: 'FEATURE_B', prod_default: 'ON' }),
      ],
      current: {},
    });
    const res = await commit({ plan: p, env: ENABLED_ENV, run });
    expect(run.mock.calls).toHaveLength(2);
    expect(res.failed.map((f) => f.row.name)).toEqual(['FEATURE_A']);
    expect(res.succeeded.map((r) => r.name)).toEqual(['FEATURE_B']);
  });

  it('after a FlyBinIdentityMismatch abort the commit-chain mutex is released (next commit proceeds)', async () => {
    const swap = jest.fn<void, [readonly string[]]>(() => {
      throw new FlyBinIdentityMismatch('FLY_BIN swapped, refusing');
    });
    const p1 = plan({ registry: [row({ name: 'FEATURE_A', prod_default: 'ON' })], current: {} });
    await expect(commit({ plan: p1, env: ENABLED_ENV, run: swap })).rejects.toThrow(
      FlyBinIdentityMismatch,
    );
    // The mutex must have released on the throw, so a subsequent commit runs.
    const ok = jest.fn<void, [readonly string[]]>();
    const p2 = plan({ registry: [row({ name: 'FEATURE_B', prod_default: 'ON' })], current: {} });
    const res = await commit({ plan: p2, env: ENABLED_ENV, run: ok });
    expect(ok.mock.calls).toHaveLength(1);
    expect(res.succeeded.map((r) => r.name)).toEqual(['FEATURE_B']);
  });
});

describe('runFlyctl is module-private — only the gated entries are exported (R5 F003)', () => {
  it('the exported surface does NOT include a bare `runFlyctl`', () => {
    expect(Object.keys(autoFlipperExports)).not.toContain('runFlyctl');
  });

  it('exposes the `__runFlyctlForTest` seam as a callable function', () => {
    expect(typeof __runFlyctlForTest).toBe('function');
  });
});

describe('commit — secret redaction in logs', () => {
  it('emits KEY=*** in the operator log and never the value', async () => {
    const sink = makeSink();
    const run: FlyRunner = () => undefined;
    const p = plan({ registry: [row({ name: 'API_KEY', prod_default: 'ON' })], current: {} });
    await commit({ plan: p, env: ENABLED_ENV, run, log: sink.log, now: fixedClock });
    const joined = sink.lines.join('\n');
    expect(joined).toContain('API_KEY=***');
    // The literal target value must NEVER appear in any log line.
    for (const line of sink.lines) {
      expect(line).not.toMatch(/API_KEY=true/);
    }
  });

  it('the structured audit line carries the key NAME but no value', async () => {
    const sink = makeSink();
    const run: FlyRunner = () => undefined;
    const p = plan({ registry: [row({ name: 'TOKEN_X', prod_default: 'ON' })], current: {} });
    await commit({ plan: p, env: ENABLED_ENV, run, log: sink.log, now: fixedClock });
    const auditLine = sink.lines.find((l) => l.startsWith('{'));
    expect(auditLine).toBeDefined();
    const parsed = JSON.parse(auditLine as string);
    expect(parsed.key).toBe('TOKEN_X');
    expect(JSON.stringify(parsed)).not.toContain('true');
  });

  it('does not emit a value even when the flyctl call fails', async () => {
    const sink = makeSink();
    const run: FlyRunner = () => {
      throw new Error('boom while setting SECRET_Z');
    };
    const p = plan({ registry: [row({ name: 'SECRET_Z', prod_default: 'ON' })], current: {} });
    await commit({ plan: p, env: ENABLED_ENV, run, log: sink.log, now: fixedClock });
    for (const line of sink.lines) {
      expect(line).not.toMatch(/SECRET_Z=true/);
    }
  });
});

describe('commit — audit trail', () => {
  it('emits a structured jsonl entry per successful flip', async () => {
    const sink = makeSink();
    const run: FlyRunner = () => undefined;
    const p = plan({ registry: [row({ name: 'AUD_1', prod_default: 'ON' })], current: {} });
    await commit({ plan: p, env: ENABLED_ENV, run, log: sink.log, now: fixedClock });
    const auditLine = sink.lines.find((l) => l.startsWith('{'));
    const parsed = JSON.parse(auditLine as string);
    expect(parsed).toEqual({
      operator: AUDIT_OPERATOR,
      action: 'set',
      key: 'AUD_1',
      before: 'missing',
      after: 'set',
      timestamp: FIXED_NOW.toISOString(),
    });
  });

  it('records before=stale when the key had a (stale) value at plan time (F003)', async () => {
    const sink = makeSink();
    const run: FlyRunner = () => undefined;
    // F003: `before` is derived from the PLAN's observed value (planned.was),
    // NOT from process env. A stale Fly value at plan time => before='stale'.
    const p = plan({
      registry: [row({ name: 'STALE_K', prod_default: 'ON' })],
      current: { STALE_K: 'false' },
    });
    await commit({ plan: p, env: ENABLED_ENV, run, log: sink.log, now: fixedClock });
    const parsed = JSON.parse(sink.lines.find((l) => l.startsWith('{')) as string);
    expect(parsed.before).toBe('stale');
  });

  it('does not emit an audit entry for a failed flip', async () => {
    const sink = makeSink();
    const run: FlyRunner = () => {
      throw new Error('nope');
    };
    const p = plan({ registry: [row({ name: 'FAIL_K', prod_default: 'ON' })], current: {} });
    await commit({ plan: p, env: ENABLED_ENV, run, log: sink.log, now: fixedClock });
    // The only jsonl line allowed here is the no-recheck warning (no key/value).
    const auditLines = sink.lines.filter((l) => l.startsWith('{'));
    expect(auditLines).toHaveLength(0);
  });
});

describe('auditEntry', () => {
  it('stamps the operator, action, and ISO timestamp', () => {
    const e = auditEntry(row({ name: 'K' }), 'missing', fixedClock);
    expect(e.operator).toBe(AUDIT_OPERATOR);
    expect(e.action).toBe('set');
    expect(e.after).toBe('set');
    expect(e.timestamp).toBe(FIXED_NOW.toISOString());
  });
});

describe('runFlyctl — default execFileSync runner', () => {
  it('calls execFileSync with the flyctl binary and an argv array (no shell)', () => {
    execFileSyncMock.mockReturnValue(Buffer.from(''));
    __runFlyctlForTest(['secrets', 'set', 'FEATURE_A=true']);
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    const [bin, args, options] = execFileSyncMock.mock.calls[0];
    expect(bin).toBe(FLY_BIN);
    expect(Array.isArray(args)).toBe(true);
    expect(args).toEqual(['secrets', 'set', 'FEATURE_A=true']);
    // No `shell: true` option — execFileSync never spawns a shell.
    expect(options?.shell).toBeUndefined();
  });

  it('maps ENOENT to a clear "install flyctl" error pointing at the docs', () => {
    const enoent = Object.assign(new Error('spawn flyctl ENOENT'), { code: 'ENOENT' });
    execFileSyncMock.mockImplementation(() => {
      throw enoent;
    });
    expect(() => __runFlyctlForTest(['secrets', 'set', 'X=true'])).toThrow(
      new RegExp(`not found on PATH.*${FLY_INSTALL_DOCS.replace(/[/.]/g, '\\$&')}`),
    );
  });

  it('surfaces captured stderr from a non-zero flyctl exit', () => {
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('Command failed'), {
        stderr: Buffer.from('Error: app not found\n'),
      });
    });
    expect(() => __runFlyctlForTest(['secrets', 'set', 'X=true'])).toThrow(/app not found/);
  });

  it('falls back to the error message when no stderr is present', () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('generic failure');
    });
    expect(() => __runFlyctlForTest(['secrets', 'set', 'X=true'])).toThrow(/generic failure/);
  });
});

describe('plan — ordering and multiplicity', () => {
  it('preserves registry order across to_set when several rows need setting', () => {
    const registry = [
      row({ name: 'Z_LAST', prod_default: 'ON' }),
      row({ name: 'A_FIRST', prod_default: 'OFF' }),
      row({ name: 'M_MID', prod_default: 'ON' }),
    ];
    const p = plan({ registry, current: {} });
    // Order follows the registry, NOT alphabetical — callers rely on this for
    // a stable, reviewable diff of what would be flipped.
    expect(p.to_set.map((r) => r.row.name)).toEqual(['Z_LAST', 'A_FIRST', 'M_MID']);
  });

  it('keeps each skip reason attached to the right row in a mixed batch', () => {
    const registry = [
      row({ name: 'MANUAL_ONE', auto_flip_on_in_prod: false }),
      row({ name: 'HUMAN_ONE', prod_default: 'MUST_SET' }),
      row({ name: 'MANUAL_TWO', auto_flip_on_in_prod: false }),
    ];
    const p = plan({ registry, current: {} });
    expect(p.to_skip).toEqual([
      { row: registry[0], reason: 'not-auto-flip' },
      { row: registry[1], reason: 'needs-human-judgement' },
      { row: registry[2], reason: 'not-auto-flip' },
    ]);
  });

  it('treats a non-canonical Fly value ("1") as stale and re-sets it', () => {
    // The registry's canonical target is "true"/"false"; anything else is stale.
    const registry = [row({ name: 'TRUTHY', prod_default: 'ON' })];
    const p = plan({ registry, current: { TRUTHY: '1' } });
    expect(p.to_set.map((r) => r.row.name)).toEqual(['TRUTHY']);
    expect(p.already_set).toHaveLength(0);
  });

  it('treats an empty-string Fly value as stale for an ON switch', () => {
    const registry = [row({ name: 'EMPTY', prod_default: 'ON' })];
    const p = plan({ registry, current: { EMPTY: '' } });
    expect(p.to_set).toHaveLength(1);
  });

  it('an OFF switch already "false" on Fly is already_set, not re-flipped', () => {
    const registry = [row({ name: 'OFFK', prod_default: 'OFF' })];
    const p = plan({ registry, current: { OFFK: 'false' } });
    expect(p.already_set.map((r) => r.row.name)).toEqual(['OFFK']);
    expect(p.to_set).toHaveLength(0);
  });
});

describe('commit — multi-row argv and ordering', () => {
  it('emits one redacted operator log line per to_set row', async () => {
    const sink = makeSink();
    const registry = [
      row({ name: 'K1', prod_default: 'ON' }),
      row({ name: 'K2', prod_default: 'OFF' }),
    ];
    const p = plan({ registry, current: {} });
    await commit({
      plan: p,
      env: ENABLED_ENV,
      run: () => undefined,
      log: sink.log,
      now: fixedClock,
    });
    const redacted = sink.lines.filter((l) => l.includes('flyctl secrets set'));
    expect(redacted).toEqual([
      'flyctl secrets set K1=*** --app <prod>',
      'flyctl secrets set K2=*** --app <prod>',
    ]);
  });

  it('passes a fresh argv array per invocation (no shared mutation)', async () => {
    const seen: string[][] = [];
    const run: FlyRunner = (args) => {
      seen.push([...args]);
    };
    const registry = [
      row({ name: 'A', prod_default: 'ON' }),
      row({ name: 'B', prod_default: 'ON' }),
    ];
    await commit({ plan: plan({ registry, current: {} }), env: ENABLED_ENV, run });
    expect(seen).toEqual([
      ['secrets', 'set', 'A=true'],
      ['secrets', 'set', 'B=true'],
    ]);
  });

  it('records succeeded rows in the order they were set', async () => {
    const registry = ['P', 'Q', 'R'].map((n) => row({ name: n, prod_default: 'ON' }));
    const res = await commit({
      plan: plan({ registry, current: {} }),
      env: ENABLED_ENV,
      run: () => undefined,
    });
    expect(res.succeeded.map((r) => r.name)).toEqual(['P', 'Q', 'R']);
  });

  it('uses the real Date clock when none is injected', async () => {
    const sink = makeSink();
    const before = Date.now();
    await commit({
      plan: plan({ registry: [row({ name: 'NOWK', prod_default: 'ON' })], current: {} }),
      env: ENABLED_ENV,
      run: () => undefined,
      log: sink.log,
    });
    const after = Date.now();
    const entry = JSON.parse(sink.lines.find((l) => l.startsWith('{')) as string);
    const stamped = Date.parse(entry.timestamp);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);
  });

  it('stringifies a non-Error throw into the failed entry', async () => {
    const run: FlyRunner = () => {
      throw 'plain string failure';
    };
    const res = await commit({
      plan: plan({ registry: [row({ name: 'STR', prod_default: 'ON' })], current: {} }),
      env: ENABLED_ENV,
      run,
    });
    expect(res.failed[0].error).toBe('plain string failure');
  });
});

describe('runFlyctl — stdio and ENOENT message detail', () => {
  it('never passes shell:true and pipes stderr for capture', () => {
    execFileSyncMock.mockReturnValue(Buffer.from(''));
    __runFlyctlForTest(['secrets', 'set', 'A=true']);
    const options = execFileSyncMock.mock.calls[0][2] as { stdio?: unknown; shell?: unknown };
    expect(options.shell).toBeUndefined();
    expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
  });

  it('mentions flyctl by name in the not-found error', () => {
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('spawn flyctl ENOENT'), { code: 'ENOENT' });
    });
    expect(() => __runFlyctlForTest(['secrets', 'set', 'A=true'])).toThrow(new RegExp(FLY_BIN));
  });

  it('handles a string stderr (not only Buffer)', () => {
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('Command failed'), { stderr: 'Error: auth required' });
    });
    expect(() => __runFlyctlForTest(['secrets', 'set', 'A=true'])).toThrow(/auth required/);
  });

  it('falls back to a default message when stderr is empty whitespace', () => {
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error(''), { stderr: Buffer.from('   \n') });
    });
    expect(() => __runFlyctlForTest(['secrets', 'set', 'A=true'])).toThrow(
      /flyctl secrets set failed/,
    );
  });
});

describe('flip — orchestration', () => {
  it('returns a plan and null result when auto-flip is disabled', async () => {
    const registry = [row({ name: 'FEATURE_A', prod_default: 'ON' })];
    const out = await flip(() => registry, {}, { env: {} });
    expect(out.plan.to_set.map((r) => r.row.name)).toEqual(['FEATURE_A']);
    expect(out.result).toBeNull();
  });

  it('plans and commits when auto-flip env AND an explicit commit opt are both set (F004)', async () => {
    const run = jest.fn<void, [readonly string[]]>();
    const registry = [row({ name: 'FEATURE_A', prod_default: 'ON' })];
    // F004: env gate is no longer sufficient on its own — an explicit
    // `commit: true` API opt-in is also required before any mutation.
    const out = await flip(() => registry, {}, { env: ENABLED_ENV, run, commit: true });
    expect(out.result).not.toBeNull();
    expect((out.result as FlipResult).succeeded.map((r) => r.name)).toEqual(['FEATURE_A']);
    expect(run).toHaveBeenCalledWith(['secrets', 'set', 'FEATURE_A=true']);
  });

  it('re-throws a RegistryParseError with auto-flipper context', async () => {
    const boom = (): readonly RegistryRow[] => {
      throw new RegistryParseError('registry truncated');
    };
    await expect(flip(boom, {})).rejects.toThrow(RegistryParseError);
    await expect(flip(boom, {})).rejects.toThrow(/auto-flipper could not load the registry/);
  });

  it('wraps non-registry errors in a typed AutoFlipperRegistryError (F005)', async () => {
    // F005: a raw error from registryFor may embed a secret in its message, so
    // flip() no longer propagates it unchanged — it wraps it in a typed error
    // whose message is generic and carries only the non-sensitive cause name.
    const boom = (): readonly RegistryRow[] => {
      throw new TypeError('unrelated');
    };
    await expect(flip(boom, {})).rejects.toThrow(AutoFlipperRegistryError);
  });
});

// ---------------------------------------------------------------------------
// H4.F R1 — three Lens B fixes: secret redaction, flyctl timeout, TOCTOU recheck
// ---------------------------------------------------------------------------

describe('redactSecretValues (Fix 1 — secret leak)', () => {
  it('redacts a single KEY=VALUE pair embedded in an flyctl stderr message', () => {
    const stderr = 'Error: secret FEATURE_SECRET=true is rejected by Fly';
    expect(redactSecretValues(stderr)).toBe('Error: secret FEATURE_SECRET=*** is rejected by Fly');
  });

  it('redacts every KEY=VALUE pair when several appear in one message', () => {
    const text = 'set API_KEY=abc123 and DB_PASSWORD=hunter2 then TOKEN_X=zzz';
    const out = redactSecretValues(text);
    expect(out).toContain('API_KEY=***');
    expect(out).toContain('DB_PASSWORD=***');
    expect(out).toContain('TOKEN_X=***');
    expect(out).not.toMatch(/abc123|hunter2|zzz/);
  });

  it('drops the entire value (no prefix retained) even for long secrets', () => {
    const long = 'X'.repeat(64);
    const out = redactSecretValues(`SUPER_SECRET=${long}`);
    expect(out).toBe('SUPER_SECRET=***');
    // Not a single character of the real value survives.
    expect(out).not.toContain('X');
  });

  it('handles the --secret KEY=VALUE flag form', () => {
    expect(redactSecretValues('flyctl secrets set --secret FEATURE_SECRET=true')).toBe(
      'flyctl secrets set --secret FEATURE_SECRET=***',
    );
  });

  it('handles single- and double-quoted KEY=VALUE forms', () => {
    expect(redactSecretValues("rejected 'FEATURE_SECRET=true here'")).toBe(
      "rejected 'FEATURE_SECRET=***'",
    );
    expect(redactSecretValues('rejected "API_KEY=abc def"')).toBe('rejected "API_KEY=***"');
  });

  it('leaves text without an UPPER_SNAKE KEY=VALUE untouched', () => {
    expect(redactSecretValues('app not found')).toBe('app not found');
    // A lowercase assignment is not a secret-shaped key and is left alone.
    expect(redactSecretValues('count=5')).toBe('count=5');
  });

  it('returns the empty string unchanged', () => {
    expect(redactSecretValues('')).toBe('');
  });

  it('flyErrorMessage redacts a value echoed back in stderr', () => {
    const err = Object.assign(new Error('Command failed'), {
      stderr: Buffer.from('secret FEATURE_SECRET=true rejected\n'),
    });
    const msg = flyErrorMessage(err);
    expect(msg).toContain('FEATURE_SECRET=***');
    expect(msg).not.toContain('FEATURE_SECRET=true');
  });

  it('flyErrorMessage redacts a value carried in the error message field', () => {
    const msg = flyErrorMessage(new Error('rejected API_KEY=topsecret value'));
    expect(msg).toBe('rejected API_KEY=*** value');
  });

  it('commit never lets a runner-thrown KEY=VALUE reach result.failed[i].error', async () => {
    // A runner that leaks the value in its thrown message — the probe that
    // motivated this fix. result.failed[i].error MUST be redacted.
    const run: FlyRunner = () => {
      throw new Error('Fly rejected FEATURE_SECRET=true for the app');
    };
    const p = plan({
      registry: [row({ name: 'FEATURE_SECRET', prod_default: 'ON' })],
      current: {},
    });
    const res = await commit({ plan: p, env: ENABLED_ENV, run });
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].error).toContain('FEATURE_SECRET=***');
    expect(res.failed[0].error).not.toContain('FEATURE_SECRET=true');
  });
});

describe('runFlyctl timeout (Fix 2 — hang protection)', () => {
  it('passes a 60s timeout and SIGTERM killSignal to execFileSync', () => {
    execFileSyncMock.mockReturnValue(Buffer.from(''));
    __runFlyctlForTest(['secrets', 'set', 'A=true']);
    const options = execFileSyncMock.mock.calls[0][2] as {
      timeout?: number;
      killSignal?: string;
    };
    expect(options.timeout).toBe(FLY_TIMEOUT_MS);
    expect(FLY_TIMEOUT_MS).toBe(60_000);
    expect(options.killSignal).toBe('SIGTERM');
  });

  it('maps a SIGTERM-killed child to a FlyctlTimeoutError', () => {
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('Command failed'), { signal: 'SIGTERM', killed: true });
    });
    expect(() => __runFlyctlForTest(['secrets', 'set', 'A=true'])).toThrow(FlyctlTimeoutError);
  });

  it('maps an ETIMEDOUT code to a FlyctlTimeoutError mentioning the timeout', () => {
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('Command failed'), { code: 'ETIMEDOUT' });
    });
    expect(() => __runFlyctlForTest(['secrets', 'set', 'A=true'])).toThrow(
      /timed out after 60000ms/,
    );
  });

  it('the timeout error context never echoes the secret value from argv', () => {
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' });
    });
    let caught: unknown;
    try {
      __runFlyctlForTest(['secrets', 'set', 'FEATURE_SECRET=true']);
    } catch (e: unknown) {
      caught = e;
    }
    const message = (caught as Error).message;
    expect(message).toContain('secrets set');
    expect(message).not.toContain('FEATURE_SECRET=true');
  });

  it('commit aborts on a timeout — it re-throws FlyctlTimeoutError without leaking the value (R5 F002)', async () => {
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('Command failed'), {
        signal: 'SIGTERM',
        killed: true,
      });
    });
    // Use the DEFAULT runner (runFlyctl) so the timeout path is exercised end-to-end.
    const p = plan({
      registry: [row({ name: 'FEATURE_SECRET', prod_default: 'ON' })],
      current: {},
    });
    let caught: unknown;
    await commit({ plan: p, env: ENABLED_ENV }).catch((e: unknown) => {
      caught = e;
    });
    expect(caught).toBeInstanceOf(FlyctlTimeoutError);
    expect((caught as Error).message).toMatch(/timed out/);
    expect((caught as Error).message).not.toContain('FEATURE_SECRET=true');
  });

  it('FlyctlTimeoutError is an instanceof Error with the right name', () => {
    const e = new FlyctlTimeoutError('boom');
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(FlyctlTimeoutError);
    expect(e.name).toBe('FlyctlTimeoutError');
  });
});

describe('commit recheckCurrent (Fix 3 — TOCTOU)', () => {
  it('proceeds with the set when the live value matches the planned `was`', async () => {
    const run = jest.fn<void, [readonly string[]]>();
    // Stale at plan time (Fly had "false", target "true") and still "false" at commit.
    const p = plan({
      registry: [row({ name: 'FEATURE_A', prod_default: 'ON' })],
      current: { FEATURE_A: 'false' },
    });
    const recheckCurrent: RecheckCurrent = async () => 'false';
    const res = await commit({ plan: p, env: ENABLED_ENV, run, recheckCurrent });
    expect(run).toHaveBeenCalledWith(['secrets', 'set', 'FEATURE_A=true']);
    expect(res.succeeded.map((r) => r.name)).toEqual(['FEATURE_A']);
    expect(res.skipped).toHaveLength(0);
  });

  it('skips the set when the live value drifted from the planned `was`', async () => {
    const run = jest.fn<void, [readonly string[]]>();
    const p = plan({
      registry: [row({ name: 'FEATURE_A', prod_default: 'ON' })],
      current: { FEATURE_A: 'false' },
    });
    // Someone changed it between plan and commit.
    const recheckCurrent: RecheckCurrent = async () => 'changed-value';
    const res = await commit({ plan: p, env: ENABLED_ENV, run, recheckCurrent });
    expect(run).not.toHaveBeenCalled();
    expect(res.succeeded).toHaveLength(0);
    expect(res.skipped).toEqual([
      { row: p.to_set[0].row, reason: 'current state changed since plan' },
    ]);
  });

  it('force:true overrides a drift skip and applies the set anyway', async () => {
    const run = jest.fn<void, [readonly string[]]>();
    const p = plan({
      registry: [row({ name: 'FEATURE_A', prod_default: 'ON' })],
      current: { FEATURE_A: 'false' },
    });
    const recheckCurrent: RecheckCurrent = async () => 'changed-value';
    const res = await commit({ plan: p, env: ENABLED_ENV, run, recheckCurrent, force: true });
    expect(run).toHaveBeenCalledWith(['secrets', 'set', 'FEATURE_A=true']);
    expect(res.succeeded.map((r) => r.name)).toEqual(['FEATURE_A']);
    expect(res.skipped).toHaveLength(0);
  });

  it('handles a key that was missing at plan time and is still missing on recheck', async () => {
    const run = jest.fn<void, [readonly string[]]>();
    const p = plan({ registry: [row({ name: 'NEW_KEY', prod_default: 'ON' })], current: {} });
    const recheckCurrent: RecheckCurrent = async () => undefined; // matches `was` undefined
    const res = await commit({ plan: p, env: ENABLED_ENV, run, recheckCurrent });
    expect(run).toHaveBeenCalledWith(['secrets', 'set', 'NEW_KEY=true']);
    expect(res.skipped).toHaveLength(0);
  });

  it('skips when a key appeared (undefined at plan, present on recheck)', async () => {
    const run = jest.fn<void, [readonly string[]]>();
    const p = plan({ registry: [row({ name: 'NEW_KEY', prod_default: 'ON' })], current: {} });
    const recheckCurrent: RecheckCurrent = async () => 'true'; // someone set it meanwhile
    const res = await commit({ plan: p, env: ENABLED_ENV, run, recheckCurrent });
    expect(run).not.toHaveBeenCalled();
    expect(res.skipped[0].reason).toBe('current state changed since plan');
  });

  it('audit-logs a skip decision with the key but no value', async () => {
    const sink = makeSink();
    const p = plan({
      registry: [row({ name: 'FEATURE_A', prod_default: 'ON' })],
      current: { FEATURE_A: 'false' },
    });
    const recheckCurrent: RecheckCurrent = async () => 'changed';
    await commit({
      plan: p,
      env: ENABLED_ENV,
      run: () => undefined,
      log: sink.log,
      now: fixedClock,
      recheckCurrent,
    });
    const auditLine = sink.lines.find((l) => l.startsWith('{'));
    const parsed = JSON.parse(auditLine as string);
    expect(parsed.action).toBe('skip');
    expect(parsed.key).toBe('FEATURE_A');
    expect(parsed.reason).toBe('current state changed since plan');
    for (const line of sink.lines) {
      expect(line).not.toMatch(/FEATURE_A=true/);
    }
  });

  it('audit-logs a force decision with the key but no value', async () => {
    const sink = makeSink();
    const p = plan({
      registry: [row({ name: 'FEATURE_A', prod_default: 'ON' })],
      current: { FEATURE_A: 'false' },
    });
    const recheckCurrent: RecheckCurrent = async () => 'changed';
    await commit({
      plan: p,
      env: ENABLED_ENV,
      run: () => undefined,
      log: sink.log,
      now: fixedClock,
      recheckCurrent,
      force: true,
    });
    const forceLine = sink.lines.find((l) => l.startsWith('{') && l.includes('"force"'));
    const parsed = JSON.parse(forceLine as string);
    expect(parsed.action).toBe('force');
    expect(parsed.key).toBe('FEATURE_A');
    for (const line of sink.lines) {
      expect(line).not.toMatch(/FEATURE_A=true/);
    }
  });

  it('without a recheck callback, applies the plan and logs a no-recheck warning', async () => {
    const sink = makeSink();
    const run = jest.fn<void, [readonly string[]]>();
    const p = plan({ registry: [row({ name: 'FEATURE_A', prod_default: 'ON' })], current: {} });
    const res = await commit({ plan: p, env: ENABLED_ENV, run, log: sink.log, now: fixedClock });
    expect(run).toHaveBeenCalledWith(['secrets', 'set', 'FEATURE_A=true']);
    expect(res.succeeded.map((r) => r.name)).toEqual(['FEATURE_A']);
    expect(res.skipped).toHaveLength(0);
    expect(sink.lines.some((l) => l.includes('no recheckCurrent configured'))).toBe(true);
  });

  it('rechecks each key independently in a multi-row plan', async () => {
    const run = jest.fn<void, [readonly string[]]>();
    const registry = [
      row({ name: 'KEEP', prod_default: 'ON' }),
      row({ name: 'DRIFT', prod_default: 'ON' }),
    ];
    const p = plan({ registry, current: {} });
    const recheckCurrent: RecheckCurrent = async (key) =>
      key === 'DRIFT' ? 'someone-set-it' : undefined;
    const res = await commit({ plan: p, env: ENABLED_ENV, run, recheckCurrent });
    expect(res.succeeded.map((r) => r.name)).toEqual(['KEEP']);
    expect(res.skipped.map((s) => s.row.name)).toEqual(['DRIFT']);
  });
});

describe('redactSecretValues — additional shapes (Fix 1 hardening)', () => {
  it('redacts a KEY=VALUE that has surrounding spaces around the equals sign', () => {
    expect(redactSecretValues('FEATURE_SECRET = topsecret')).toBe('FEATURE_SECRET=***');
  });

  it('redacts a digit-bearing UPPER_SNAKE key', () => {
    expect(redactSecretValues('OAUTH2_TOKEN=abc.def.ghi rejected')).toBe(
      'OAUTH2_TOKEN=*** rejected',
    );
  });

  it('redacts multiple quoted pairs in one line', () => {
    const out = redactSecretValues(`set 'A_KEY=one' and "B_KEY=two three"`);
    expect(out).toContain("'A_KEY=***'");
    expect(out).toContain('"B_KEY=***"');
    expect(out).not.toMatch(/one|two|three/);
  });

  it('does not redact a value-only token with no UPPER_SNAKE key', () => {
    expect(redactSecretValues('just a normal sentence with no secrets')).toBe(
      'just a normal sentence with no secrets',
    );
  });

  it('commit timeout via default runner aborts (re-throws) without echoing the value (R5 F002)', async () => {
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('Command failed'), { code: 'ETIMEDOUT' });
    });
    const p = plan({ registry: [row({ name: 'HANGS', prod_default: 'ON' })], current: {} });
    let caught: unknown;
    await commit({ plan: p, env: ENABLED_ENV }).catch((e: unknown) => {
      caught = e;
    });
    expect(caught).toBeInstanceOf(FlyctlTimeoutError);
    expect((caught as Error).message).not.toContain('HANGS=true');
  });
});

// ============================================================================
// H4.F R2 — Lens B fixes F002–F007. Every secret-bearing error-path test below
// uses a SYNTHETIC `sk_test_FAKE_DO_NOT_REPLACE` value (never a real secret,
// brief constraint + R24) and asserts the secret is GONE from the captured
// output. execFileSync stays module-mocked; no real flyctl is ever invoked.
// ============================================================================

/** Canonical synthetic secret for the R2 error-path tests. NOT a real value. */
const FAKE_SECRET = 'sk_test_FAKE_DO_NOT_REPLACE_R2';

describe('F002 — recheckCurrent throw is a redacting error boundary (no abort, no leak)', () => {
  it('a callback that throws a KEY=VALUE message records a redacted failure and CONTINUES', async () => {
    const run = jest.fn<void, [readonly string[]]>();
    const registry = [
      row({ name: 'FEATURE_A', prod_default: 'ON' }),
      row({ name: 'FEATURE_B', prod_default: 'ON' }),
    ];
    const p = plan({ registry, current: {} });
    // The callback throws ONLY for the first row; the loop must keep going and
    // apply the second row's set unaffected.
    const recheckCurrent: RecheckCurrent = async (key) => {
      if (key === 'FEATURE_A') throw new Error(`upstream rejected API_KEY=${FAKE_SECRET}`);
      return undefined; // FEATURE_B: still missing -> proceeds
    };
    const res = await commit({ plan: p, env: ENABLED_ENV, run, recheckCurrent });
    // The throwing row is recorded as a redacted failure...
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].row.name).toBe('FEATURE_A');
    expect(res.failed[0].error).toContain('recheck failed:');
    expect(res.failed[0].error).not.toContain(FAKE_SECRET);
    expect(res.failed[0].error).toContain(`API_KEY=***`);
    // ...and the OTHER row is unaffected (commit did NOT abort).
    expect(res.succeeded.map((r) => r.name)).toEqual(['FEATURE_B']);
    expect(run).toHaveBeenCalledWith(['secrets', 'set', 'FEATURE_B=true']);
  });

  it('a callback that throws a BARE secret value redacts it via the value set', async () => {
    const run = jest.fn<void, [readonly string[]]>();
    // The plan target is the secret value, so collectSecretValues seeds the
    // value-based pass; the callback leaks that literal with no KEY=VAL shape.
    const registry = [row({ name: 'TOKEN_SECRET', prod_default: 'ON' })];
    const p = plan({ registry, current: { TOKEN_SECRET: FAKE_SECRET } });
    const recheckCurrent: RecheckCurrent = async () => {
      throw new Error(`network error talking to upstream: ${FAKE_SECRET} (no key context)`);
    };
    const res = await commit({ plan: p, env: ENABLED_ENV, run, recheckCurrent });
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].error).not.toContain(FAKE_SECRET);
    expect(res.failed[0].error).toContain('recheck failed:');
    expect(run).not.toHaveBeenCalled();
  });

  it('a callback that throws a JSON-formatted secret redacts the JSON field', async () => {
    const run = jest.fn<void, [readonly string[]]>();
    const registry = [row({ name: 'FEATURE_A', prod_default: 'ON' })];
    const p = plan({ registry, current: {} });
    const recheckCurrent: RecheckCurrent = async () => {
      throw new Error(`{"api_key":"${FAKE_SECRET}","app":"prod"}`);
    };
    const res = await commit({ plan: p, env: ENABLED_ENV, run, recheckCurrent });
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].error).not.toContain(FAKE_SECRET);
    expect(res.failed[0].error).toContain('"api_key":"***"');
  });

  it('a non-Error throw (string) is still stringified and redacted, loop continues', async () => {
    const run = jest.fn<void, [readonly string[]]>();
    const registry = [
      row({ name: 'FEATURE_A', prod_default: 'ON' }),
      row({ name: 'FEATURE_B', prod_default: 'ON' }),
    ];
    const p = plan({ registry, current: {} });
    const recheckCurrent: RecheckCurrent = async (key) => {
      if (key === 'FEATURE_A') {
        throw `raw string leak API_KEY=${FAKE_SECRET}`;
      }
      return undefined;
    };
    const res = await commit({ plan: p, env: ENABLED_ENV, run, recheckCurrent });
    expect(res.failed[0].error).not.toContain(FAKE_SECRET);
    expect(res.succeeded.map((r) => r.name)).toEqual(['FEATURE_B']);
  });
});

describe('F003 — audit `before` derived from planned.was, not env', () => {
  it("records before='missing' when the key was absent at plan time", async () => {
    const sink = makeSink();
    const run: FlyRunner = () => undefined;
    // Key absent in `current` => planned.was === undefined => 'missing'.
    const p = plan({ registry: [row({ name: 'NEW_KEY', prod_default: 'ON' })], current: {} });
    await commit({ plan: p, env: ENABLED_ENV, run, log: sink.log, now: fixedClock });
    const parsed = JSON.parse(sink.lines.find((l) => l.includes('"action":"set"')) as string);
    expect(parsed.before).toBe('missing');
  });

  it("records before='stale' even when the key IS present in process env (env is irrelevant)", async () => {
    const sink = makeSink();
    const run: FlyRunner = () => undefined;
    // The key is present in `env`, but `before` must follow the PLAN's `was`,
    // which is a stale Fly value here — so before='stale', NOT influenced by env.
    const env: NodeJS.ProcessEnv = { ...ENABLED_ENV, STALE_K: 'whatever-env-says' };
    const p = plan({
      registry: [row({ name: 'STALE_K', prod_default: 'ON' })],
      current: { STALE_K: 'false' },
    });
    await commit({ plan: p, env, run, log: sink.log, now: fixedClock });
    const parsed = JSON.parse(sink.lines.find((l) => l.includes('"action":"set"')) as string);
    expect(parsed.before).toBe('stale');
  });

  it("records before='missing' even when the key IS present in process env but absent on Fly", async () => {
    const sink = makeSink();
    const run: FlyRunner = () => undefined;
    const env: NodeJS.ProcessEnv = { ...ENABLED_ENV, NEW_KEY: 'present-in-env' };
    const p = plan({ registry: [row({ name: 'NEW_KEY', prod_default: 'ON' })], current: {} });
    await commit({ plan: p, env, run, log: sink.log, now: fixedClock });
    const parsed = JSON.parse(sink.lines.find((l) => l.includes('"action":"set"')) as string);
    expect(parsed.before).toBe('missing');
  });
});

describe('F004 — dry-run is the default; commit needs env gate AND explicit API opt-in', () => {
  const registry = [row({ name: 'FEATURE_A', prod_default: 'ON' })];

  it('env=true + no opt -> DRY-RUN (result null, runner never called)', async () => {
    const run = jest.fn<void, [readonly string[]]>();
    const out = await flip(() => registry, {}, { env: ENABLED_ENV, run });
    expect(out.result).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it('env=true + commit:true -> COMMITS', async () => {
    const run = jest.fn<void, [readonly string[]]>();
    const out = await flip(() => registry, {}, { env: ENABLED_ENV, run, commit: true });
    expect(out.result).not.toBeNull();
    expect((out.result as FlipResult).succeeded.map((r) => r.name)).toEqual(['FEATURE_A']);
  });

  it('env=true + dryRun:false -> COMMITS (dryRun:false is an equivalent opt-in)', async () => {
    const run = jest.fn<void, [readonly string[]]>();
    const out = await flip(() => registry, {}, { env: ENABLED_ENV, run, dryRun: false });
    expect(out.result).not.toBeNull();
    expect(run).toHaveBeenCalledWith(['secrets', 'set', 'FEATURE_A=true']);
  });

  it('env=false + commit:true -> DRY-RUN (env gate missing, never mutates)', async () => {
    const run = jest.fn<void, [readonly string[]]>();
    const out = await flip(() => registry, {}, { env: {}, run, commit: true });
    expect(out.result).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it('env=false + no opt -> DRY-RUN', async () => {
    const run = jest.fn<void, [readonly string[]]>();
    const out = await flip(() => registry, {}, { env: {}, run });
    expect(out.result).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it('shouldCommit truth table: only (opt-in AND env gate) authorises a commit', () => {
    expect(shouldCommit({ commit: true }, ENABLED_ENV)).toBe(true);
    expect(shouldCommit({ dryRun: false }, ENABLED_ENV)).toBe(true);
    expect(shouldCommit({ commit: true }, {})).toBe(false); // env gate missing
    expect(shouldCommit({}, ENABLED_ENV)).toBe(false); // opt-in missing
    expect(shouldCommit(undefined, ENABLED_ENV)).toBe(false);
    expect(shouldCommit({ dryRun: true }, ENABLED_ENV)).toBe(false); // explicit dry-run
  });
});

describe('F005 — registryFor errors are wrapped in a typed, redacted AutoFlipperRegistryError', () => {
  it('a raw Error carrying a secret is wrapped; the secret is NOT in the message', async () => {
    const boom = (): readonly RegistryRow[] => {
      throw new Error(`registry load failed: ${FAKE_SECRET}`);
    };
    await expect(flip(boom, {})).rejects.toBeInstanceOf(AutoFlipperRegistryError);
    const err = await flip(boom, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AutoFlipperRegistryError);
    const ae = err as AutoFlipperRegistryError;
    expect(ae.message).not.toContain(FAKE_SECRET);
    expect(ae.message).toContain('auto-flipper could not load the registry');
    // Only the non-sensitive class name of the cause is preserved.
    expect(ae.causeName).toBe('Error');
  });

  it('preserves the original error CLASS name as non-sensitive cause metadata', async () => {
    const boom = (): readonly RegistryRow[] => {
      throw new TypeError(`type boom ${FAKE_SECRET}`);
    };
    const err = (await flip(boom, {}).catch((e: unknown) => e)) as AutoFlipperRegistryError;
    expect(err).toBeInstanceOf(AutoFlipperRegistryError);
    expect(err.causeName).toBe('TypeError');
    expect(err.message).not.toContain(FAKE_SECRET);
  });

  it('a RegistryParseError keeps its type but still redacts its message', async () => {
    const boom = (): readonly RegistryRow[] => {
      throw new RegistryParseError(`bad row API_KEY=${FAKE_SECRET}`);
    };
    const err = (await flip(boom, {}).catch((e: unknown) => e)) as RegistryParseError;
    expect(err).toBeInstanceOf(RegistryParseError);
    expect(err.message).not.toContain(FAKE_SECRET);
    expect(err.message).toContain('API_KEY=***');
  });
});

describe('F006 — concurrent commit() calls are serialized (one inflight flyctl at a time)', () => {
  it('two concurrent commits never overlap: maxInflight === 1', async () => {
    let inflight = 0;
    let maxInflight = 0;
    // Instrumented async-ish runner: bump the inflight counter, yield to the
    // event loop (so any overlap WOULD be observed), then release.
    const makeRun = (): FlyRunner => () => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      // Synchronous runner, but the per-row await points around it give the
      // other commit a chance to interleave if the mutex were absent.
      inflight -= 1;
    };
    const registryA = [
      row({ name: 'A1', prod_default: 'ON' }),
      row({ name: 'A2', prod_default: 'ON' }),
    ];
    const registryB = [
      row({ name: 'B1', prod_default: 'ON' }),
      row({ name: 'B2', prod_default: 'ON' }),
    ];
    const pA = plan({ registry: registryA, current: {} });
    const pB = plan({ registry: registryB, current: {} });
    // A recheck callback that yields the event loop is the realistic overlap
    // window; both commits race through it.
    const recheckCurrent: RecheckCurrent = async () => {
      await Promise.resolve();
      await Promise.resolve();
      return undefined;
    };
    await Promise.all([
      commit({ plan: pA, env: ENABLED_ENV, run: makeRun(), recheckCurrent }),
      commit({ plan: pB, env: ENABLED_ENV, run: makeRun(), recheckCurrent }),
    ]);
    expect(maxInflight).toBe(1);
  });

  it('serialization is observable: the second commit starts only after the first settles', async () => {
    const order: string[] = [];
    const registryA = [row({ name: 'A1', prod_default: 'ON' })];
    const registryB = [row({ name: 'B1', prod_default: 'ON' })];
    const pA = plan({ registry: registryA, current: {} });
    const pB = plan({ registry: registryB, current: {} });
    const runA: FlyRunner = () => order.push('A:set');
    const runB: FlyRunner = () => order.push('B:set');
    const slowRecheck: RecheckCurrent = async () => {
      await new Promise((r) => setTimeout(r, 10));
      return undefined;
    };
    const fastRecheck: RecheckCurrent = async () => undefined;
    // A starts first with a slow recheck; B is fast. Without the mutex, B would
    // finish before A. With it, A must complete entirely before B begins.
    const cA = commit({ plan: pA, env: ENABLED_ENV, run: runA, recheckCurrent: slowRecheck });
    const cB = commit({ plan: pB, env: ENABLED_ENV, run: runB, recheckCurrent: fastRecheck });
    await Promise.all([cA, cB]);
    expect(order).toEqual(['A:set', 'B:set']);
  });

  it('a throwing commit still releases the mutex so the next caller proceeds', async () => {
    const registryA = [row({ name: 'A1', prod_default: 'ON' })];
    const registryB = [row({ name: 'B1', prod_default: 'ON' })];
    const pA = plan({ registry: registryA, current: {} });
    const pB = plan({ registry: registryB, current: {} });
    const throwingRecheck: RecheckCurrent = async () => {
      throw new Error('boom'); // recorded as failed, does not reject commit()
    };
    const runB = jest.fn<void, [readonly string[]]>();
    const resA = await commit({
      plan: pA,
      env: ENABLED_ENV,
      run: () => undefined,
      recheckCurrent: throwingRecheck,
    });
    const resB = await commit({ plan: pB, env: ENABLED_ENV, run: runB });
    expect(resA.failed).toHaveLength(1);
    expect(runB).toHaveBeenCalledWith(['secrets', 'set', 'B1=true']);
    expect(resB.succeeded.map((r) => r.name)).toEqual(['B1']);
  });
});

describe('F007 — FLY_BIN absolute-path validation and one-time PATH warning', () => {
  const ORIGINAL_FLY_BIN = process.env[FLY_BIN_ENV];

  afterEach(() => {
    if (ORIGINAL_FLY_BIN === undefined) delete process.env[FLY_BIN_ENV];
    else process.env[FLY_BIN_ENV] = ORIGINAL_FLY_BIN;
    jest.resetModules();
  });

  it('a non-absolute FLY_BIN override REJECTS at module load', () => {
    process.env[FLY_BIN_ENV] = 'flyctl-evil'; // relative -> spoof vector
    expect(() => {
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('./auto-flipper');
      });
    }).toThrow(/must be an absolute path/);
  });

  it('the bare default flyctl is permitted and WARNS exactly once on first use', () => {
    delete process.env[FLY_BIN_ENV];
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('./auto-flipper') as typeof import('./auto-flipper');
      expect(mod.FLY_BIN).toBe(mod.FLY_BIN_DEFAULT);
      const warnSink = jest.fn<void, [string]>();
      mod.__resetFlyBinWarnedForTest();
      mod.warnIfPathResolvedFlyBin(warnSink);
      mod.warnIfPathResolvedFlyBin(warnSink); // second call: latched, no-op
      expect(warnSink).toHaveBeenCalledTimes(1);
      expect(warnSink.mock.calls[0][0]).toMatch(/PATH to resolve "flyctl"/);
    });
  });

  it('the explicit bare value "flyctl" is treated as the default (no rejection)', () => {
    process.env[FLY_BIN_ENV] = FLY_BIN_DEFAULT;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('./auto-flipper') as typeof import('./auto-flipper');
      expect(mod.FLY_BIN).toBe(FLY_BIN_DEFAULT);
    });
  });
});

describe('F001 wiring — collectSecretValues gathers plan literals for the redactor', () => {
  it('collects both target and `was` values from to_set and already_set, deduped', () => {
    const p = plan({
      registry: [
        row({ name: 'A', prod_default: 'ON' }), // target 'true', was 'false'
        row({ name: 'B', prod_default: 'OFF' }), // already 'false'
      ],
      current: { A: 'false', B: 'false' },
    });
    const values = collectSecretValues(p);
    expect(values.has('true')).toBe(true); // A target
    expect(values.has('false')).toBe(true); // A was / B target+was
    // de-duplicated set, not a list with repeats
    expect(values.size).toBe(2);
  });

  it('the value-aware redactor scrubs a bare runner-thrown secret using plan literals', async () => {
    // The plan target value IS the synthetic secret; a custom runner leaks it
    // bare (no KEY=VAL). collectSecretValues -> value-based pass must catch it.
    const registry = [row({ name: 'SECRET_FLAG', prod_default: 'ON' })];
    const p = plan({ registry, current: { SECRET_FLAG: FAKE_SECRET } });
    const run: FlyRunner = () => {
      throw new Error(`fly rejected the value ${FAKE_SECRET} bare with no key`);
    };
    // make the planned target the secret by overriding via current/was path:
    const res = await commit({ plan: p, env: ENABLED_ENV, run });
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].error).not.toContain(FAKE_SECRET);
  });
});

// ---------------------------------------------------------------------------
// H4.F R3 — F003: FLY_BIN realpath resolution + regular-executable-file checks,
// production-strict bare rejection, and per-invocation TOCTOU revalidation.
// All fs calls are MOCKED via the injectable FlyBinFs — no real binary or
// filesystem is ever touched (brief constraint).
// ---------------------------------------------------------------------------

/**
 * Build a {@link FlyBinStat} carrying the five identity fields (F002) plus the
 * file-type predicate. Defaults describe a regular executable file with a fixed
 * canonical identity; pass overrides to simulate a same-path swap (different
 * inode, mtime, or size) or a non-regular target.
 */
function mkStat(over: Partial<FlyBinStat> = {}): FlyBinStat {
  return {
    isFile: () => true,
    dev: 100n,
    ino: 200n,
    mtimeNs: 1_700_000_000_000_000_000n,
    size: 4096n,
    mode: 0o100755n,
    ...over,
  };
}

describe('R3 F003 — FLY_BIN realpath + regular-executable verification (mocked fs)', () => {
  afterEach(() => __resetResolvedFlyBinForTest());

  function fsStub(over: Partial<FlyBinFs> = {}): FlyBinFs {
    return {
      realpathSync: (p: string) => `/real${p}`,
      statSync: () => mkStat(),
      accessSync: (_p: string, _mode: number) => undefined,
      ...over,
    };
  }

  it('absolute symlink to a regular executable file is ACCEPTED after realpath resolution', () => {
    const resolved = __resolveFlyBinForTest({ [FLY_BIN_ENV]: '/opt/bin/flyctl' }, fsStub());
    expect(resolved).toBe('/real/opt/bin/flyctl');
  });

  it('absolute symlink to a NON-EXECUTABLE target is REJECTED', () => {
    const fs = fsStub({
      accessSync: () => {
        throw new Error('EACCES');
      },
    });
    expect(() => __resolveFlyBinForTest({ [FLY_BIN_ENV]: '/opt/bin/flyctl' }, fs)).toThrow(
      /not executable/,
    );
  });

  it('absolute symlink to a NON-REGULAR file (directory) is REJECTED', () => {
    const fs = fsStub({ statSync: () => mkStat({ isFile: () => false }) });
    expect(() => __resolveFlyBinForTest({ [FLY_BIN_ENV]: '/opt/bin/flyctl' }, fs)).toThrow(
      /not a regular file/,
    );
  });

  it('DANGLING absolute symlink (realpath throws) is REJECTED', () => {
    const fs = fsStub({
      realpathSync: () => {
        throw new Error('ENOENT');
      },
    });
    expect(() => __resolveFlyBinForTest({ [FLY_BIN_ENV]: '/opt/bin/flyctl' }, fs)).toThrow(
      /could not be resolved/,
    );
  });

  it('a non-absolute FLY_BIN override is REJECTED before any fs call', () => {
    const realpathSync = jest.fn((p: string) => p);
    const fs = fsStub({ realpathSync });
    expect(() => __resolveFlyBinForTest({ [FLY_BIN_ENV]: 'flyctl-evil' }, fs)).toThrow(
      /must be an absolute path/,
    );
    expect(realpathSync).not.toHaveBeenCalled();
  });
});

describe('R3 F003 — production-strict bare-flyctl rejection', () => {
  afterEach(() => __resetResolvedFlyBinForTest());

  function fsStub(): FlyBinFs {
    return {
      realpathSync: (p: string) => p,
      statSync: () => mkStat(),
      accessSync: () => undefined,
    };
  }

  it('bare flyctl with NODE_ENV=production is REJECTED', () => {
    expect(() => __resolveFlyBinForTest({ NODE_ENV: 'production' }, fsStub())).toThrow(
      /not allowed[\s\S]*outside development/,
    );
  });

  it('bare flyctl with NODE_ENV=staging is REJECTED', () => {
    expect(() => __resolveFlyBinForTest({ NODE_ENV: 'staging' }, fsStub())).toThrow(/not allowed/);
  });

  it('bare flyctl with NODE_ENV=development is ACCEPTED', () => {
    expect(__resolveFlyBinForTest({ NODE_ENV: 'development' }, fsStub())).toBe(FLY_BIN_DEFAULT);
  });

  it('bare flyctl with FLY_BIN_REQUIRE_ABSOLUTE=true is REJECTED regardless of NODE_ENV', () => {
    expect(() =>
      __resolveFlyBinForTest(
        { NODE_ENV: 'development', FLY_BIN_REQUIRE_ABSOLUTE: 'true' },
        fsStub(),
      ),
    ).toThrow(/not allowed/);
  });

  it('bare flyctl with NODE_ENV unset is ACCEPTED (local shell)', () => {
    expect(__resolveFlyBinForTest({}, fsStub())).toBe(FLY_BIN_DEFAULT);
  });
});

describe('R3 F003 — TOCTOU revalidation catches a canonical-path swap mid-process', () => {
  afterEach(() => __resetResolvedFlyBinForTest());

  const goodFs: FlyBinFs = {
    realpathSync: (p: string) => p,
    statSync: () => mkStat(),
    accessSync: () => undefined,
  };

  it('assertFlyBinUnchanged is a no-op for the bare PATH default (no cached path)', () => {
    __resolveFlyBinForTest({ NODE_ENV: 'development' }, goodFs);
    expect(() => assertFlyBinUnchanged()).not.toThrow();
  });

  it('a path swapped to a NON-regular file mid-process is caught on revalidation', () => {
    __resolveFlyBinForTest({ [FLY_BIN_ENV]: '/opt/bin/flyctl' }, goodFs);
    expect(__getResolvedFlyBinPathForTest()).toBe('/opt/bin/flyctl');
    const swappedFs: FlyBinFs = {
      realpathSync: (p: string) => p,
      statSync: () => mkStat({ isFile: () => false }),
      accessSync: () => undefined,
    };
    expect(() => assertFlyBinUnchanged(swappedFs)).toThrow(/not a regular file/);
  });

  it('a path swapped to a NON-executable file mid-process is caught on revalidation', () => {
    __resolveFlyBinForTest({ [FLY_BIN_ENV]: '/opt/bin/flyctl' }, goodFs);
    const swappedFs: FlyBinFs = {
      realpathSync: (p: string) => p,
      statSync: () => mkStat(),
      accessSync: () => {
        throw new Error('EACCES');
      },
    };
    expect(() => assertFlyBinUnchanged(swappedFs)).toThrow(/not executable/);
  });
});

describe('R4 F002 — FLY_BIN stat-identity gate catches a same-path binary swap', () => {
  afterEach(() => __resetResolvedFlyBinForTest());

  /** A good fs whose stat returns the canonical identity from {@link mkStat}. */
  function goodFsWith(stat: () => FlyBinStat): FlyBinFs {
    return {
      realpathSync: (p: string) => p,
      statSync: stat,
      accessSync: () => undefined,
    };
  }

  it('captures the canonical identity at cache fill', () => {
    __resolveFlyBinForTest(
      { [FLY_BIN_ENV]: '/opt/bin/flyctl' },
      goodFsWith(() => mkStat()),
    );
    const id = __getResolvedFlyBinIdentityForTest();
    expect(id).toMatchObject({
      dev: 100n,
      ino: 200n,
      mtimeNs: 1_700_000_000_000_000_000n,
      size: 4096n,
      mode: 0o100755n,
    });
  });

  it('REFUSES when the INODE changes between cache and revalidation (same path)', () => {
    __resolveFlyBinForTest(
      { [FLY_BIN_ENV]: '/opt/bin/flyctl' },
      goodFsWith(() => mkStat()),
    );
    const swapped = goodFsWith(() => mkStat({ ino: 999n }));
    expect(() => assertFlyBinUnchanged(swapped)).toThrow(FlyBinIdentityMismatch);
    expect(() => assertFlyBinUnchanged(swapped)).toThrow(/changed identity \(ino: 200 -> 999\)/);
  });

  it('REFUSES when only the MTIME changes (in-place overwrite at the same inode)', () => {
    __resolveFlyBinForTest(
      { [FLY_BIN_ENV]: '/opt/bin/flyctl' },
      goodFsWith(() => mkStat()),
    );
    const swapped = goodFsWith(() => mkStat({ mtimeNs: 1_700_000_000_000_000_001n }));
    expect(() => assertFlyBinUnchanged(swapped)).toThrow(FlyBinIdentityMismatch);
    expect(() => assertFlyBinUnchanged(swapped)).toThrow(/mtimeNs:/);
  });

  it('REFUSES when only the SIZE changes', () => {
    __resolveFlyBinForTest(
      { [FLY_BIN_ENV]: '/opt/bin/flyctl' },
      goodFsWith(() => mkStat()),
    );
    const swapped = goodFsWith(() => mkStat({ size: 8192n }));
    expect(() => assertFlyBinUnchanged(swapped)).toThrow(FlyBinIdentityMismatch);
    expect(() => assertFlyBinUnchanged(swapped)).toThrow(/size: 4096 -> 8192/);
  });

  it('REFUSES when only the DEV (mount point) changes', () => {
    __resolveFlyBinForTest(
      { [FLY_BIN_ENV]: '/opt/bin/flyctl' },
      goodFsWith(() => mkStat()),
    );
    const swapped = goodFsWith(() => mkStat({ dev: 101n }));
    expect(() => assertFlyBinUnchanged(swapped)).toThrow(/dev: 100 -> 101/);
  });

  it('REFUSES when only the MODE (permission bits) changes', () => {
    __resolveFlyBinForTest(
      { [FLY_BIN_ENV]: '/opt/bin/flyctl' },
      goodFsWith(() => mkStat()),
    );
    const swapped = goodFsWith(() => mkStat({ mode: 0o100777n }));
    expect(() => assertFlyBinUnchanged(swapped)).toThrow(/mode:/);
  });

  it('PROCEEDS when the stat-identity is IDENTICAL across two consecutive validations', () => {
    __resolveFlyBinForTest(
      { [FLY_BIN_ENV]: '/opt/bin/flyctl' },
      goodFsWith(() => mkStat()),
    );
    const same = goodFsWith(() => mkStat());
    expect(() => assertFlyBinUnchanged(same)).not.toThrow();
    expect(() => assertFlyBinUnchanged(same)).not.toThrow(); // stable across repeats
  });

  it('FIRST-EVER validation (cached path, no identity yet) captures identity and PROCEEDS', () => {
    __seedResolvedFlyBinPathWithoutIdentityForTest('/opt/bin/flyctl');
    expect(__getResolvedFlyBinIdentityForTest()).toBeUndefined();
    const fs = goodFsWith(() => mkStat({ ino: 555n }));
    expect(() => assertFlyBinUnchanged(fs)).not.toThrow();
    // The first observed stat is adopted as canonical.
    expect(__getResolvedFlyBinIdentityForTest()).toMatchObject({ ino: 555n });
    // A subsequent swap is then caught against the adopted identity.
    const swapped = goodFsWith(() => mkStat({ ino: 556n }));
    expect(() => assertFlyBinUnchanged(swapped)).toThrow(FlyBinIdentityMismatch);
  });

  it('REFUSES a SYMLINK swap that changes the realpath (regression — F003 behavior preserved)', () => {
    __resolveFlyBinForTest(
      { [FLY_BIN_ENV]: '/opt/bin/flyctl' },
      goodFsWith(() => mkStat()),
    );
    // The symlink now points elsewhere AND the new target is not a regular file:
    // the realpath-based F003 check fires first, before identity comparison.
    const swapped: FlyBinFs = {
      realpathSync: () => '/tmp/evil/flyctl',
      statSync: () => mkStat({ isFile: () => false }),
      accessSync: () => undefined,
    };
    expect(() => assertFlyBinUnchanged(swapped)).toThrow(/not a regular file/);
  });

  it('REFUSES a symlink swap whose new realpath target is a DIFFERENT-identity executable', () => {
    __resolveFlyBinForTest(
      { [FLY_BIN_ENV]: '/opt/bin/flyctl' },
      goodFsWith(() => mkStat()),
    );
    // Realpath still equal, but the file behind it has a different inode — the
    // F003 file-type checks pass; the F002 identity gate must still REFUSE.
    const swapped: FlyBinFs = {
      realpathSync: () => '/opt/bin/flyctl',
      statSync: () => mkStat({ ino: 4242n }),
      accessSync: () => undefined,
    };
    expect(() => assertFlyBinUnchanged(swapped)).toThrow(FlyBinIdentityMismatch);
  });
});

// ---------------------------------------------------------------------------
// H4.F R3 — F002: AutoFlipperRegistryError.causeName is allowlisted + redacted.
// ---------------------------------------------------------------------------

describe('R3 F002 — causeName allowlist + value redaction', () => {
  const throwing =
    (err: unknown): (() => readonly RegistryRow[]) =>
    () => {
      throw err;
    };
  const NO_CURRENT: Record<string, string> = {};

  it('an attacker-named error class collapses to "UnknownError"', async () => {
    class SecretLeakedSk123 extends Error {}
    await expect(
      flip(throwing(new SecretLeakedSk123('boom')), NO_CURRENT, { env: {} }),
    ).rejects.toMatchObject({ causeName: 'UnknownError', name: 'AutoFlipperRegistryError' });
  });

  it('a built-in TypeError is preserved verbatim (allowlisted)', async () => {
    await expect(
      flip(throwing(new TypeError('bad type')), NO_CURRENT, { env: {} }),
    ).rejects.toMatchObject({ causeName: 'TypeError' });
  });

  it('a built-in SyntaxError is preserved verbatim (allowlisted)', async () => {
    await expect(
      flip(throwing(new SyntaxError('bad syntax')), NO_CURRENT, { env: {} }),
    ).rejects.toMatchObject({ causeName: 'SyntaxError' });
  });

  it('safeCauseName redacts a class name that itself embeds a plan secret', () => {
    const SECRET = 'sk_test_FAKE_NESTED_REDACTOR';
    // Build an error whose constructor.name embeds the secret AND is not on the
    // allowlist; it must collapse to UnknownError and never expose the secret.
    const err = new Error('x');
    Object.defineProperty(err.constructor, 'name', { value: `Error_${SECRET}` });
    const name = safeCauseName(err, [SECRET]);
    expect(name).not.toContain(SECRET);
    expect(name).toBe('UnknownError');
  });

  it('the thrown AutoFlipperRegistryError message never echoes the raw error text', async () => {
    const SECRET = 'sk_test_FAKE_NESTED_REDACTOR';
    class Weird extends Error {}
    await expect(
      flip(throwing(new Weird(`leak ${SECRET}`)), { K: SECRET }, { env: {} }),
    ).rejects.toMatchObject({ message: expect.not.stringContaining(SECRET) });
  });
});
