import {
  DUNNING_V2_CADENCE_DAYS,
  DUNNING_V2_FINAL_STEP_INDEX,
  DUNNING_V2_LOCKOUT_GRACE_DAYS,
  DUNNING_V2_REVERSAL_COACH_GAP_DAYS,
  DUNNING_V2_REVERSAL_ENTRY_STEP,
  DUNNING_V2_REVERSAL_LOCKOUT_GAP_DAYS,
  DUNNING_LOCKOUT_SWEEP_CRON_EXPRESSION,
  LOCKED_DUNNING_CODE,
} from '../src/checkout/dunning-v2/dunning-v2.cadence';
import {
  DunningV2Service,
  addDays,
} from '../src/checkout/dunning-v2/dunning-v2.service';

// R66 gate 3 (cadence math): the operator-locked cadence numbers and the
// derived-state machine. These are pure-function tests (no prisma), so they
// run regardless of the flag.
describe('Dunning v2 cadence constants (operator-locked)', () => {
  it('is exactly the 4-attempt [0,1,3,7] cadence — no 5th attempt', () => {
    expect([...DUNNING_V2_CADENCE_DAYS]).toEqual([0, 1, 3, 7]);
    expect(DUNNING_V2_CADENCE_DAYS).toHaveLength(4);
  });

  it('locks out 3 days after the Day-7 final step (Day 10)', () => {
    expect(DUNNING_V2_LOCKOUT_GRACE_DAYS).toBe(3);
    // Day-7 offset + 3-day grace == Day 10.
    expect(DUNNING_V2_CADENCE_DAYS[DUNNING_V2_FINAL_STEP_INDEX] +
      DUNNING_V2_LOCKOUT_GRACE_DAYS).toBe(10);
  });

  it('final step index points at the Day-7 attempt', () => {
    expect(DUNNING_V2_FINAL_STEP_INDEX).toBe(3);
    expect(DUNNING_V2_CADENCE_DAYS[DUNNING_V2_FINAL_STEP_INDEX]).toBe(7);
  });

  it('late-reversal cycle enters at Step 2 with a compressed 4+3 schedule', () => {
    expect(DUNNING_V2_REVERSAL_ENTRY_STEP).toBe(2);
    expect(DUNNING_V2_REVERSAL_COACH_GAP_DAYS).toBe(4);
    expect(DUNNING_V2_REVERSAL_LOCKOUT_GAP_DAYS).toBe(3);
  });

  it('sweep cron is the fixed 02:00 UTC daily expression', () => {
    expect(DUNNING_LOCKOUT_SWEEP_CRON_EXPRESSION).toBe('0 2 * * *');
  });

  it('exposes the stable LOCKED 403 code', () => {
    expect(LOCKED_DUNNING_CODE).toBe('LOCKED_DUNNING');
  });
});

describe('addDays helper', () => {
  it('adds whole UTC days', () => {
    const base = new Date('2026-01-01T00:00:00.000Z');
    expect(addDays(base, 3).toISOString()).toBe('2026-01-04T00:00:00.000Z');
  });

  it('subtracts with a negative offset', () => {
    const base = new Date('2026-01-10T00:00:00.000Z');
    expect(addDays(base, -3).toISOString()).toBe('2026-01-07T00:00:00.000Z');
  });
});

// 100% state-transition coverage of the deriveState mapping (spec §1):
// INACTIVE → ACTIVE → LOCKED, ACTIVE → RECOVERED → ACTIVE (reversal),
// LOCKED → RECOVERED.
describe('DunningV2Service.deriveState (state machine)', () => {
  it('no row → INACTIVE', () => {
    expect(DunningV2Service.deriveState(null)).toBe('INACTIVE');
  });

  it('active + no lockout → ACTIVE', () => {
    expect(
      DunningV2Service.deriveState({
        status: 'active',
        locked_out_at: null,
        recovered_at: null,
      }),
    ).toBe('ACTIVE');
  });

  it('active + locked_out_at set → LOCKED', () => {
    expect(
      DunningV2Service.deriveState({
        status: 'active',
        locked_out_at: new Date(),
        recovered_at: null,
      }),
    ).toBe('LOCKED');
  });

  it('resolved + recovered_at set → RECOVERED', () => {
    expect(
      DunningV2Service.deriveState({
        status: 'resolved',
        locked_out_at: null,
        recovered_at: new Date(),
      }),
    ).toBe('RECOVERED');
  });

  it('resolved + no recovered_at → INACTIVE', () => {
    expect(
      DunningV2Service.deriveState({
        status: 'resolved',
        locked_out_at: null,
        recovered_at: null,
      }),
    ).toBe('INACTIVE');
  });

  it('abandoned → INACTIVE', () => {
    expect(
      DunningV2Service.deriveState({
        status: 'abandoned',
        locked_out_at: null,
        recovered_at: null,
      }),
    ).toBe('INACTIVE');
  });

  it('full forward path INACTIVE→ACTIVE→LOCKED then recovery LOCKED→RECOVERED', () => {
    // INACTIVE
    expect(DunningV2Service.deriveState(null)).toBe('INACTIVE');
    // ACTIVE (first failure recorded)
    const active = { status: 'active', locked_out_at: null, recovered_at: null };
    expect(DunningV2Service.deriveState(active)).toBe('ACTIVE');
    // LOCKED (Day-10 sweep stamps locked_out_at)
    const locked = {
      status: 'active',
      locked_out_at: new Date('2026-02-10T02:00:00Z'),
      recovered_at: null,
    };
    expect(DunningV2Service.deriveState(locked)).toBe('LOCKED');
    // RECOVERED (immediate clear flips status resolved + recovered_at)
    const recovered = {
      status: 'resolved',
      locked_out_at: null,
      recovered_at: new Date('2026-02-11T09:00:00Z'),
    };
    expect(DunningV2Service.deriveState(recovered)).toBe('RECOVERED');
  });
});
