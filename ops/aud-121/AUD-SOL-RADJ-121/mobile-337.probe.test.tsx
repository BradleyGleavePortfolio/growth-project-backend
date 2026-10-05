import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import RomanAdjustmentCard from '../RomanAdjustmentCard';
import { adjustErrorView } from '../romanAdjustCopy';
import { RomanAdjustmentSchema, type RomanAdjustment } from '../../../../api/romanAdjustApi';
import { captureError } from '../../../../services/sentry';

jest.mock('../../../../services/sentry', () => ({ captureError: jest.fn() }));
jest.mock('../../../../ui/haptics/haptics.service', () => ({
  HapticService: { selection: jest.fn(), success: jest.fn(), warning: jest.fn() },
}));

function proposal(): RomanAdjustment {
  return {
    id: 'p1', status: 'pending', severity: 'moderate',
    roman_text: 'Roman proposes a lighter workout.',
    client: { id: 'c1', first_name: 'Client' },
    workout: { assignment_id: 'a1', plan_name: 'Lower A', scheduled_for: '2026-10-03T16:00:00Z' },
    signals: [], proposed_change: {
      volume_pct: 15, sets_before: 18, sets_after: 15,
      exercises: [{ order: 0, exercise_external_id: 'ex-1', sets_before: 5, sets_after: 4 }],
    },
    applied_change: null, exercise_names: {}, created_at: '2026-10-02T16:00:00Z',
    decided_at: null, undo_until: null,
  };
}

beforeEach(() => { jest.useFakeTimers(); jest.clearAllMocks(); });
afterEach(() => { jest.useRealTimers(); });

describe('AUD-SOL-RADJ-121 lifecycle and truthful copy at m337 exact head', () => {
  it('B unknown mutation outcome: a lost approve response does not assert workouts are unchanged', () => {
    const error = new Error('Network Error');
    // Same error is possible after the POST was committed and its response was lost.
    expect(adjustErrorView(error, 'approve').message).not.toMatch(/workouts are unchanged/i);
  });

  it('B successful POST with contract drift does not assert workouts are unchanged', () => {
    const result = RomanAdjustmentSchema.safeParse({ ...proposal(), status: 'new_server_status' });
    if (result.success) throw new Error('fixture must be an invalid reply');
    expect(adjustErrorView(result.error, 'edit').message).not.toMatch(/workouts are unchanged/i);
  });

  it('B privacy: invalid health-bearing enum is never forwarded to Sentry as the raw ZodError', () => {
    const secret = 'PRIVATE_CLIENT_KNEE_AND_SLEEP_NOTE';
    const result = RomanAdjustmentSchema.safeParse({ ...proposal(), status: secret });
    if (result.success) throw new Error('fixture must be an invalid reply');
    adjustErrorView(result.error, 'approve');
    const captured = jest.mocked(captureError).mock.calls[0][0];
    const errorText = captured instanceof Error ? captured.message : JSON.stringify(captured);
    expect(errorText).not.toContain(secret);
  });

  it('B lifecycle: late approve response cannot invoke the parent callback after unmount', async () => {
    let resolve!: (value: RomanAdjustment) => void;
    const approve = jest.fn(() => new Promise<RomanAdjustment>((r) => { resolve = r; }));
    const onChanged = jest.fn();
    const r = await render(<RomanAdjustmentCard proposal={proposal()} onSettled={jest.fn()} onChanged={onChanged} deps={{ approve }} />);
    await fireEvent.press(r.getByTestId('roman-adjust-card-approve'));
    await act(async () => { jest.advanceTimersByTime(5000); });
    expect(approve).toHaveBeenCalledTimes(1);
    await r.unmount();
    await act(async () => { resolve({ ...proposal(), status: 'approved' }); });
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('C expiry: mounted card removes Undo when the actual server window elapses', async () => {
    const now = Date.now();
    const p = { ...proposal(), status: 'approved' as const, applied_change: proposal().proposed_change,
      undo_until: new Date(now + 2000).toISOString() };
    const r = await render(<RomanAdjustmentCard proposal={p} onSettled={jest.fn()} onChanged={jest.fn()} />);
    expect(r.getByTestId('roman-adjust-card-undo-server')).toBeTruthy();
    await act(async () => { jest.advanceTimersByTime(3000); });
    expect(r.queryByTestId('roman-adjust-card-undo-server')).toBeNull();
  });

  it('C edit cancel: reopening starts from the displayed proposal, not a discarded set edit', async () => {
    const edit = jest.fn(async () => ({ ...proposal(), status: 'edited' as const }));
    const r = await render(<RomanAdjustmentCard proposal={proposal()} onSettled={jest.fn()} onChanged={jest.fn()} deps={{ edit }} />);
    await fireEvent.press(r.getByTestId('roman-adjust-card-edit-open'));
    await fireEvent.press(r.getByTestId('roman-adjust-card-minus-0'));
    await fireEvent.press(r.getByTestId('roman-adjust-card-cancel'));
    await fireEvent.press(r.getByTestId('roman-adjust-card-edit-open'));
    await fireEvent.press(r.getByTestId('roman-adjust-card-save'));
    await act(async () => { jest.advanceTimersByTime(5000); });
    expect(edit).toHaveBeenCalledWith('p1', { volume_pct: 15 });
  });
});
