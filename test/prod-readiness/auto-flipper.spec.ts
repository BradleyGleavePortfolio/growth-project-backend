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
  runFlyctl,
  targetValueFor,
  autoFlipEnabled,
  auditEntry,
  AUTO_FLIP_ENV,
  AUDIT_OPERATOR,
  FLY_BIN,
  FLY_INSTALL_DOCS,
  type FlipPlan,
  type FlipResult,
  type FlyRunner,
} from './auto-flipper';
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
    expect(p.to_skip).toEqual([
      { row: registry[0], reason: 'not-auto-flip' },
    ]);
    expect(p.to_set).toHaveLength(0);
  });

  it('MUST_SET row is skipped as needs-human-judgement even if auto_flip is true', () => {
    const registry = [row({ name: 'DB_URL', prod_default: 'MUST_SET' })];
    const p = plan({ registry, current: {} });
    expect(p.to_skip).toEqual([
      { row: registry[0], reason: 'needs-human-judgement' },
    ]);
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
  it('refuses without READINESS_AUTO_FLIP=true and never invokes the runner', () => {
    const run = jest.fn();
    const p: FlipPlan = plan({ registry: [row()], current: {} });
    expect(() => commit({ plan: p, env: {}, run })).toThrow(/READINESS_AUTO_FLIP=true/);
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses when the flag is set to a non-"true" value', () => {
    const run = jest.fn();
    const p = plan({ registry: [row()], current: {} });
    expect(() => commit({ plan: p, env: { [AUTO_FLIP_ENV]: 'yes' }, run })).toThrow(
      /refusing to commit/,
    );
    expect(run).not.toHaveBeenCalled();
  });
});

describe('commit — execution', () => {
  it('invokes the runner once per to_set row with the correct flyctl argv', () => {
    const run = jest.fn<void, [readonly string[]]>();
    const p = plan({
      registry: [row({ name: 'FEATURE_A', prod_default: 'ON' })],
      current: {},
    });
    const res = commit({ plan: p, env: ENABLED_ENV, run });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(['secrets', 'set', 'FEATURE_A=true']);
    expect(res.succeeded.map((r) => r.name)).toEqual(['FEATURE_A']);
    expect(res.failed).toHaveLength(0);
  });

  it('passes OFF rows the value "false" over argv', () => {
    const run = jest.fn<void, [readonly string[]]>();
    const p = plan({ registry: [row({ name: 'KILL_SWITCH', prod_default: 'OFF' })], current: {} });
    commit({ plan: p, env: ENABLED_ENV, run });
    expect(run).toHaveBeenCalledWith(['secrets', 'set', 'KILL_SWITCH=false']);
  });

  it('captures stderr into result.failed when a flip throws', () => {
    const run: FlyRunner = () => {
      throw new Error('Error: insufficient permissions for app');
    };
    const p = plan({ registry: [row({ name: 'FEATURE_A' })], current: {} });
    const res = commit({ plan: p, env: ENABLED_ENV, run });
    expect(res.succeeded).toHaveLength(0);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].row.name).toBe('FEATURE_A');
    expect(res.failed[0].error).toMatch(/insufficient permissions/);
  });

  it('does not early-abort: 5 rows, 1 fails -> 4 succeeded, 1 failed', () => {
    const names = ['R1', 'R2', 'R3', 'R4', 'R5'];
    const registry = names.map((n) => row({ name: n, prod_default: 'ON' }));
    const run: FlyRunner = (args) => {
      if (args[2] === 'R3=true') throw new Error('R3 boom');
    };
    const p = plan({ registry, current: {} });
    const res = commit({ plan: p, env: ENABLED_ENV, run });
    expect(res.succeeded.map((r) => r.name)).toEqual(['R1', 'R2', 'R4', 'R5']);
    expect(res.failed.map((f) => f.row.name)).toEqual(['R3']);
  });

  it('runs flips strictly sequentially (one inflight at a time, in order)', () => {
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
    commit({ plan: p, env: ENABLED_ENV, run });
    expect(order).toEqual(['A=true', 'B=true', 'C=true']);
  });

  it('is a no-op when to_set is empty (nothing to commit)', () => {
    const run = jest.fn();
    const p = plan({ registry: [row({ name: 'OK', prod_default: 'ON' })], current: { OK: 'true' } });
    const res = commit({ plan: p, env: ENABLED_ENV, run });
    expect(run).not.toHaveBeenCalled();
    expect(res).toEqual({ succeeded: [], failed: [] });
  });
});

describe('commit — secret redaction in logs', () => {
  it('emits KEY=*** in the operator log and never the value', () => {
    const sink = makeSink();
    const run: FlyRunner = () => undefined;
    const p = plan({ registry: [row({ name: 'API_KEY', prod_default: 'ON' })], current: {} });
    commit({ plan: p, env: ENABLED_ENV, run, log: sink.log, now: fixedClock });
    const joined = sink.lines.join('\n');
    expect(joined).toContain('API_KEY=***');
    // The literal target value must NEVER appear in any log line.
    for (const line of sink.lines) {
      expect(line).not.toMatch(/API_KEY=true/);
    }
  });

  it('the structured audit line carries the key NAME but no value', () => {
    const sink = makeSink();
    const run: FlyRunner = () => undefined;
    const p = plan({ registry: [row({ name: 'TOKEN_X', prod_default: 'ON' })], current: {} });
    commit({ plan: p, env: ENABLED_ENV, run, log: sink.log, now: fixedClock });
    const auditLine = sink.lines.find((l) => l.startsWith('{'));
    expect(auditLine).toBeDefined();
    const parsed = JSON.parse(auditLine as string);
    expect(parsed.key).toBe('TOKEN_X');
    expect(JSON.stringify(parsed)).not.toContain('true');
  });

  it('does not emit a value even when the flyctl call fails', () => {
    const sink = makeSink();
    const run: FlyRunner = () => {
      throw new Error('boom while setting SECRET_Z');
    };
    const p = plan({ registry: [row({ name: 'SECRET_Z', prod_default: 'ON' })], current: {} });
    commit({ plan: p, env: ENABLED_ENV, run, log: sink.log, now: fixedClock });
    for (const line of sink.lines) {
      expect(line).not.toMatch(/SECRET_Z=true/);
    }
  });
});

describe('commit — audit trail', () => {
  it('emits a structured jsonl entry per successful flip', () => {
    const sink = makeSink();
    const run: FlyRunner = () => undefined;
    const p = plan({ registry: [row({ name: 'AUD_1', prod_default: 'ON' })], current: {} });
    commit({ plan: p, env: ENABLED_ENV, run, log: sink.log, now: fixedClock });
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

  it('records before=stale when the key already exists in env', () => {
    const sink = makeSink();
    const run: FlyRunner = () => undefined;
    const env: NodeJS.ProcessEnv = { ...ENABLED_ENV, STALE_K: 'false' };
    const p = plan({ registry: [row({ name: 'STALE_K', prod_default: 'ON' })], current: {} });
    commit({ plan: p, env, run, log: sink.log, now: fixedClock });
    const parsed = JSON.parse(sink.lines.find((l) => l.startsWith('{')) as string);
    expect(parsed.before).toBe('stale');
  });

  it('does not emit an audit entry for a failed flip', () => {
    const sink = makeSink();
    const run: FlyRunner = () => {
      throw new Error('nope');
    };
    const p = plan({ registry: [row({ name: 'FAIL_K', prod_default: 'ON' })], current: {} });
    commit({ plan: p, env: ENABLED_ENV, run, log: sink.log, now: fixedClock });
    expect(sink.lines.find((l) => l.startsWith('{'))).toBeUndefined();
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
    runFlyctl(['secrets', 'set', 'FEATURE_A=true']);
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
    expect(() => runFlyctl(['secrets', 'set', 'X=true'])).toThrow(
      new RegExp(`not found on PATH.*${FLY_INSTALL_DOCS.replace(/[/.]/g, '\\$&')}`),
    );
  });

  it('surfaces captured stderr from a non-zero flyctl exit', () => {
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('Command failed'), {
        stderr: Buffer.from('Error: app not found\n'),
      });
    });
    expect(() => runFlyctl(['secrets', 'set', 'X=true'])).toThrow(/app not found/);
  });

  it('falls back to the error message when no stderr is present', () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('generic failure');
    });
    expect(() => runFlyctl(['secrets', 'set', 'X=true'])).toThrow(/generic failure/);
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
  it('emits one redacted operator log line per to_set row', () => {
    const sink = makeSink();
    const registry = [
      row({ name: 'K1', prod_default: 'ON' }),
      row({ name: 'K2', prod_default: 'OFF' }),
    ];
    const p = plan({ registry, current: {} });
    commit({ plan: p, env: ENABLED_ENV, run: () => undefined, log: sink.log, now: fixedClock });
    const redacted = sink.lines.filter((l) => l.includes('flyctl secrets set'));
    expect(redacted).toEqual([
      'flyctl secrets set K1=*** --app <prod>',
      'flyctl secrets set K2=*** --app <prod>',
    ]);
  });

  it('passes a fresh argv array per invocation (no shared mutation)', () => {
    const seen: string[][] = [];
    const run: FlyRunner = (args) => {
      seen.push([...args]);
    };
    const registry = [
      row({ name: 'A', prod_default: 'ON' }),
      row({ name: 'B', prod_default: 'ON' }),
    ];
    commit({ plan: plan({ registry, current: {} }), env: ENABLED_ENV, run });
    expect(seen).toEqual([
      ['secrets', 'set', 'A=true'],
      ['secrets', 'set', 'B=true'],
    ]);
  });

  it('records succeeded rows in the order they were set', () => {
    const registry = ['P', 'Q', 'R'].map((n) => row({ name: n, prod_default: 'ON' }));
    const res = commit({
      plan: plan({ registry, current: {} }),
      env: ENABLED_ENV,
      run: () => undefined,
    });
    expect(res.succeeded.map((r) => r.name)).toEqual(['P', 'Q', 'R']);
  });

  it('uses the real Date clock when none is injected', () => {
    const sink = makeSink();
    const before = Date.now();
    commit({
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

  it('stringifies a non-Error throw into the failed entry', () => {
    const run: FlyRunner = () => {
      throw 'plain string failure';
    };
    const res = commit({
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
    runFlyctl(['secrets', 'set', 'A=true']);
    const options = execFileSyncMock.mock.calls[0][2] as { stdio?: unknown; shell?: unknown };
    expect(options.shell).toBeUndefined();
    expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
  });

  it('mentions flyctl by name in the not-found error', () => {
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('spawn flyctl ENOENT'), { code: 'ENOENT' });
    });
    expect(() => runFlyctl(['secrets', 'set', 'A=true'])).toThrow(new RegExp(FLY_BIN));
  });

  it('handles a string stderr (not only Buffer)', () => {
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('Command failed'), { stderr: 'Error: auth required' });
    });
    expect(() => runFlyctl(['secrets', 'set', 'A=true'])).toThrow(/auth required/);
  });

  it('falls back to a default message when stderr is empty whitespace', () => {
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error(''), { stderr: Buffer.from('   \n') });
    });
    expect(() => runFlyctl(['secrets', 'set', 'A=true'])).toThrow(/flyctl secrets set failed/);
  });
});

describe('flip — orchestration', () => {
  it('returns a plan and null result when auto-flip is disabled', () => {
    const registry = [row({ name: 'FEATURE_A', prod_default: 'ON' })];
    const out = flip(() => registry, {}, { env: {} });
    expect(out.plan.to_set.map((r) => r.row.name)).toEqual(['FEATURE_A']);
    expect(out.result).toBeNull();
  });

  it('plans and commits when auto-flip is enabled', () => {
    const run = jest.fn<void, [readonly string[]]>();
    const registry = [row({ name: 'FEATURE_A', prod_default: 'ON' })];
    const out = flip(() => registry, {}, { env: ENABLED_ENV, run });
    expect(out.result).not.toBeNull();
    expect((out.result as FlipResult).succeeded.map((r) => r.name)).toEqual(['FEATURE_A']);
    expect(run).toHaveBeenCalledWith(['secrets', 'set', 'FEATURE_A=true']);
  });

  it('re-throws a RegistryParseError with auto-flipper context', () => {
    const boom = (): readonly RegistryRow[] => {
      throw new RegistryParseError('registry truncated');
    };
    expect(() => flip(boom, {})).toThrow(RegistryParseError);
    expect(() => flip(boom, {})).toThrow(/auto-flipper could not load the registry/);
  });

  it('propagates non-registry errors unchanged', () => {
    const boom = (): readonly RegistryRow[] => {
      throw new TypeError('unrelated');
    };
    expect(() => flip(boom, {})).toThrow(TypeError);
  });
});
