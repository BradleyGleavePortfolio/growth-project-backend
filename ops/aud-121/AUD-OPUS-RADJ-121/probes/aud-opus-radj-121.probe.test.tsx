// AUD-OPUS-RADJ-121 probes (Claude Opus 5.5 lens, agent 121) for growth-project-mobile#337 @ 63be1013 (+ origin/main b79ca594).
// Each `it` asserts the behaviour the PR must have; a FAIL at the audited head proves the finding in its title.
// (control) tests must PASS. Lives only on audit/* branches; never merge.
import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { z } from 'zod';
import RomanAdjustmentCard from '../RomanAdjustmentCard';
import {
  ADJUST_ERROR_FALLBACKS,
  DISMISS_REASONS,
  adjustErrorView,
  appliedLine,
  changeSummary,
  pendingLine,
  signalLabel,
} from '../romanAdjustCopy';
import type { RomanAdjustment } from '../../../../api/romanAdjustApi';

jest.mock('../../../../services/sentry', () => ({ captureError: jest.fn() }));
jest.mock('../../../../ui/haptics/haptics.service', () => ({
  HapticService: {
    selection: jest.fn(async () => undefined),
    success: jest.fn(async () => undefined),
    warning: jest.fn(async () => undefined),
  },
}));

const NOW = Date.parse('2026-10-02T16:00:00Z');

function proposal(over: Partial<RomanAdjustment> = {}): RomanAdjustment {
  return {
    id: 'p1',
    status: 'pending',
    severity: 'moderate',
    roman_text: "Maya's recovery has dipped. Heart-rate variability is 18% below the usual. I suggest trimming tomorrow's Lower Body A by 15%, from 18 to 15 sets. Reps and loads stay as you set them. Shall I apply it?",
    client: { id: 'c1', first_name: 'Maya' },
    workout: { assignment_id: 'a1', plan_name: 'Lower Body A', scheduled_for: '2026-10-03T16:00:00Z' },
    signals: [{ key: 'hrv_drop', marked: false, value: 18, baseline: 60 }],
    proposed_change: {
      volume_pct: 15,
      sets_before: 18,
      sets_after: 15,
      exercises: [{ order: 0, exercise_external_id: 'back-squat', sets_before: 5, sets_after: 4 }],
    },
    applied_change: null,
    exercise_names: { 'back-squat': 'Back squat' },
    created_at: '2026-10-02T15:00:00Z',
    decided_at: null,
    undo_until: null,
    ...over,
  };
}

const httpError = (status: number, data?: unknown) =>
  Object.assign(new Error(`HTTP ${status}`), { response: { status, data, headers: {} } });
// A ZodError can only come from parsing a 2xx reply: the server already applied the change.
const zodAfter2xx = () => z.object({ id: z.string() }).safeParse({}).error as z.ZodError;
const timeout = () => Object.assign(new Error('timeout of 15000ms exceeded'), { code: 'ECONNABORTED', request: {} });

describe('B-337-2 copy truth: a lost reply after Approve/Edit/Undo never claims "Your workouts are unchanged"', () => {
  it.each([
    ['timeout, no reply', 'approve', timeout()],
    ['timeout, no reply', 'edit', timeout()],
    ['timeout, no reply', 'undo', timeout()],
    ['500 after commit', 'approve', httpError(500, { statusCode: 500, message: 'Internal server error' })],
    ['502 from the edge', 'edit', httpError(502)],
    ['unreadable 2xx reply (change applied)', 'approve', zodAfter2xx()],
  ] as const)('%s on %s: no false "unchanged" claim, and the list is reloaded to show the truth', (_l, action, err) => {
    const v = adjustErrorView(err, action);
    expect({ unchangedClaim: /unchanged/i.test(v.message), refresh: v.refresh }).toEqual({ unchangedClaim: false, refresh: true });
  });
});

describe('C-337 probes (not blocking)', () => {
  it('C-337-a an Edit that raises sets is not summarised as a negative "less volume"', () => {
    expect(changeSummary({ volume_pct: -17, sets_before: 18, sets_after: 21, exercises: [] })).not.toMatch(/-\d+% less volume/);
  });

  it('C-337-b leaving the card during the 5 s countdown does not silently drop the decision the card announced', () => {
    jest.useFakeTimers();
    const approve = jest.fn(async () => proposal({ status: 'approved' }));
    const r = render(
      <RomanAdjustmentCard proposal={proposal()} onSettled={jest.fn()} onChanged={jest.fn()} deps={{ approve, now: () => NOW }} />,
    );
    fireEvent.press(r.getByTestId('roman-adjust-card-approve'));
    expect(r.getByTestId('roman-adjust-card-countdown')).toBeTruthy();
    r.unmount();
    act(() => {
      jest.advanceTimersByTime(6000);
    });
    jest.useRealTimers();
    expect(approve).toHaveBeenCalledTimes(1);
  });
});

describe('controls (must PASS at head)', () => {
  it('(control) app-chrome copy: no first person, no exclamation marks, no generic error words', () => {
    const lines: string[] = [
      ...Object.values(ADJUST_ERROR_FALLBACKS),
      ...(['load', 'approve', 'edit', 'dismiss', 'undo'] as const).flatMap((a) => [
        adjustErrorView(new Error('Network Error'), a).message,
        adjustErrorView(httpError(401), a).message,
        adjustErrorView(httpError(403), a).message,
        adjustErrorView(httpError(429), a).message,
        adjustErrorView(httpError(500), a).message,
      ]),
      pendingLine('approve', 5),
      pendingLine('dismiss', 5),
      appliedLine(proposal().proposed_change, 'Maya'),
      appliedLine(null, ''),
      ...DISMISS_REASONS.map((d) => d.label),
      ...(['hrv_drop', 'rhr_rise', 'short_sleep', 'low_readiness', 'load_spike', 'high_effort'] as const).map((key) =>
        signalLabel({ key, marked: false, value: 1, baseline: null }),
      ),
    ];
    const bad = lines.filter((l) => /\b(we|We|us|our|Our|I|me|my|My)\b|!|something went wrong|an error occurred/.test(l));
    expect(bad).toEqual([]);
  });

  it('(control) a settled refusal from the server shows the server sentence and asks for a refresh', () => {
    const v = adjustErrorView(
      httpError(409, { code: 'ADJUSTMENT_ALREADY_DECIDED', message: ADJUST_ERROR_FALLBACKS.ADJUSTMENT_ALREADY_DECIDED }),
      'approve',
    );
    expect(v).toEqual({ code: 'ADJUSTMENT_ALREADY_DECIDED', message: ADJUST_ERROR_FALLBACKS.ADJUSTMENT_ALREADY_DECIDED, refresh: true });
  });
});
