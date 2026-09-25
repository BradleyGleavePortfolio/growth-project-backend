import {
  arbitrate,
  type ArbiterInput,
  FENCE_REASON_CODES,
  FENCE_TERMINALS,
  totalStaged,
} from '../../../src/scout/lifecycle/arbiter';
import {
  FENCE_REASONS,
  RUN_REASON_CODES,
  SERVER_TERMINAL_STATUSES,
} from '../../../src/scout/lifecycle/reason-codes';

// S7-L D-S7L-2 — the arbiter is a pure function; these are its precedence table.
// L03 (fence wins over a later /complete) and the "never complete without a
// verdict" invariant are pinned here at the unit level and again on real PG in
// test/rls-g2-s7l.spec.ts.

const base = (over: Partial<ArbiterInput> = {}): ArbiterInput => ({
  fence: null,
  claim: null,
  staged_by_family: {},
  ledger_by_family: {},
  unmapped_families: [],
  reconciliation: null,
  ...over,
});

describe('S7-L arbiter (pure)', () => {
  it('step 4: no fence, no failing claim, no verdict → partial / reconciliation_not_performed', () => {
    expect(arbitrate(base())).toEqual({
      terminal_status: 'partial',
      reason_code: 'reconciliation_not_performed',
    });
    expect(arbitrate(base({ claim: 'success', staged_by_family: { clients: 3 } }))).toEqual({
      terminal_status: 'partial',
      reason_code: 'reconciliation_not_performed',
    });
  });

  it('a `success` claim never produces `complete` or `success` — completion needs an S9 verdict', () => {
    const verdict = arbitrate(base({ claim: 'success', staged_by_family: { clients: 40 } }));
    const terminal: string = verdict.terminal_status;
    expect(terminal).not.toBe('complete');
    expect(terminal).not.toBe('success');
    expect(verdict).toEqual({
      terminal_status: 'partial',
      reason_code: 'reconciliation_not_performed',
    });
  });

  it('step 2: claim `failed` with zero staged rows → failed / transfer_failed', () => {
    expect(arbitrate(base({ claim: 'failed' }))).toEqual({
      terminal_status: 'failed',
      reason_code: 'transfer_failed',
    });
    expect(
      arbitrate(base({ claim: 'failed', staged_by_family: { clients: 0, workouts: 0 } })),
    ).toEqual({
      terminal_status: 'failed',
      reason_code: 'transfer_failed',
    });
  });

  it('claim `failed` WITH staged rows is not transfer_failed — evidence outranks the claim', () => {
    expect(arbitrate(base({ claim: 'failed', staged_by_family: { clients: 1 } }))).toEqual({
      terminal_status: 'partial',
      reason_code: 'reconciliation_not_performed',
    });
  });

  it('step 3: a reconciliation verdict is taken verbatim, including `complete`', () => {
    expect(
      arbitrate(
        base({ claim: 'success', reconciliation: { outcome: 'complete', reason_code: null } }),
      ),
    ).toEqual({ terminal_status: 'complete', reason_code: null });
    expect(
      arbitrate(
        base({
          claim: 'partial',
          staged_by_family: { clients: 2 },
          reconciliation: { outcome: 'blocked', reason_code: 'unresolved_family' },
        }),
      ),
    ).toEqual({ terminal_status: 'blocked', reason_code: 'unresolved_family' });
  });

  it('step 2 outranks step 3: failed claim + zero staged beats a verdict', () => {
    expect(
      arbitrate(
        base({ claim: 'failed', reconciliation: { outcome: 'complete', reason_code: null } }),
      ),
    ).toEqual({ terminal_status: 'failed', reason_code: 'transfer_failed' });
  });

  it('step 1: a fence wins over everything, with its fixed terminal and reason (L03)', () => {
    for (const fence of FENCE_REASONS) {
      const verdict = arbitrate(
        base({
          fence,
          claim: 'success',
          staged_by_family: { clients: 10 },
          reconciliation: { outcome: 'complete', reason_code: null },
        }),
      );
      expect(verdict).toEqual({
        terminal_status: FENCE_TERMINALS[fence],
        reason_code: FENCE_REASON_CODES[fence],
      });
    }
    expect(FENCE_TERMINALS).toEqual({
      cancelled: 'cancelled',
      timed_out: 'timed_out',
      revoked: 'blocked',
    });
    expect(FENCE_REASON_CODES).toEqual({
      cancelled: 'cancelled_by_coach',
      timed_out: 'deadline_exceeded',
      revoked: 'revoked',
    });
  });

  it('only emits vocabulary from the reason-code catalog', () => {
    const inputs: ArbiterInput[] = [
      base(),
      base({ claim: 'failed' }),
      base({ fence: 'cancelled' }),
      base({ fence: 'timed_out' }),
      base({ fence: 'revoked' }),
      base({ reconciliation: { outcome: 'complete', reason_code: null } }),
    ];
    for (const input of inputs) {
      const v = arbitrate(input);
      expect(SERVER_TERMINAL_STATUSES).toContain(v.terminal_status);
      if (v.reason_code !== null) expect(RUN_REASON_CODES).toContain(v.reason_code);
    }
  });

  it('totalStaged sums every family', () => {
    expect(totalStaged({})).toBe(0);
    expect(totalStaged({ a: 2, b: 3 })).toBe(5);
  });
});
