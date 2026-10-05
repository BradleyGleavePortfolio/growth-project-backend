// Roman approve-to-adjust: the deterministic recovery rule (pure functions).
import {
  ADJUST_THRESHOLDS,
  applyChange,
  cutVolume,
  decideVolumeCut,
  evaluateSignals,
  romanProposalText,
  setsChange,
  whenWord,
  type AdjustExercise,
  type AdjustSample,
} from '../../src/roman-adjust/roman-adjust.rules';

const TZ = 'America/Los_Angeles';
// 2026-10-02 09:00 in Los Angeles.
const NOW = new Date('2026-10-02T16:00:00Z');

function daysAgo(n: number, hourUtc = 15): Date {
  return new Date(Date.UTC(2026, 9, 2 - n, hourUtc));
}

function series(metric: string, valueFor: (daysAgo: number) => number | null, days = 30): AdjustSample[] {
  const out: AdjustSample[] = [];
  for (let d = 0; d < days; d += 1) {
    const v = valueFor(d);
    if (v === null) continue;
    out.push({ metric, value: v, start_at: daysAgo(d), end_at: daysAgo(d) });
  }
  return out;
}

const EX = (order: number, sets: number): AdjustExercise => ({
  exercise_external_id: `ex-${order}`,
  order,
  sets,
  reps_or_duration_seconds: 8,
  weight_lbs: 100,
  rest_seconds: 90,
  superset_group_id: null,
  notes: null,
});

describe('evaluateSignals', () => {
  it('flags an HRV drop of 20% against a 4-week baseline, and a resting HR rise', () => {
    const samples = [
      ...series('HRV_MS', (d) => (d < 3 ? 48 : 60)),
      ...series('RESTING_HEART_RATE_BPM', (d) => (d < 3 ? 61 : 55)),
    ];
    const s = evaluateSignals({ samples, completions: [], now: NOW, timeZone: TZ });
    expect(s.map((x) => x.key).sort()).toEqual(['hrv_drop', 'rhr_rise']);
    expect(s.find((x) => x.key === 'hrv_drop')).toMatchObject({ value: 20, baseline: 60, marked: false });
    expect(s.find((x) => x.key === 'rhr_rise')).toMatchObject({ value: 6, marked: false });
  });

  it('needs a baseline of at least 7 days: a new wearable never triggers a change', () => {
    const samples = series('HRV_MS', (d) => (d < 3 ? 30 : 60), 8);
    expect(evaluateSignals({ samples, completions: [], now: NOW, timeZone: TZ })).toEqual([]);
  });

  it('short sleep needs two nights; the longer of two providers counts, never the sum', () => {
    const night = (d: number, min: number): AdjustSample => ({
      metric: 'SLEEP_TOTAL_MIN',
      value: min,
      start_at: daysAgo(d + 1, 6),
      end_at: daysAgo(d, 14),
    });
    const one = evaluateSignals({ samples: [night(0, 280)], completions: [], now: NOW, timeZone: TZ });
    expect(one).toEqual([]);
    const two = evaluateSignals({
      samples: [night(0, 280), night(0, 200), night(1, 320)],
      completions: [],
      now: NOW,
      timeZone: TZ,
    });
    expect(two).toEqual([{ key: 'short_sleep', marked: false, value: 5, baseline: null }]);
  });

  it('training load spike: 7-day sRPE at 1.5x the prior 4-week weekly average', () => {
    const completions = [
      // acute: 4 sessions at RPE 8 = 32
      ...[0, 1, 3, 5].map((d) => ({ completed_at: daysAgo(d), post_rpe: 8 })),
      // chronic: 12 sessions at RPE 6 over 4 weeks = 72 / 4 = 18 per week
      ...[8, 10, 12, 15, 17, 19, 22, 24, 26, 29, 31, 33].map((d) => ({ completed_at: daysAgo(d), post_rpe: 6 })),
    ];
    const s = evaluateSignals({ samples: [], completions, now: NOW, timeZone: TZ });
    expect(s).toEqual([{ key: 'load_spike', marked: false, value: 1.8, baseline: 18 }]);
  });
});

describe('decideVolumeCut', () => {
  it('one recovery signal alone never triggers a change', () => {
    expect(decideVolumeCut([{ key: 'hrv_drop', marked: false, value: 16, baseline: 60 }])).toBeNull();
  });
  it('load alone never triggers a change (that is the coach programming)', () => {
    expect(
      decideVolumeCut([
        { key: 'load_spike', marked: false, value: 1.8, baseline: 18 },
        { key: 'high_effort', marked: false, value: 9.3, baseline: null },
      ]),
    ).toBeNull();
  });
  it('two recovery signals: moderate 15%', () => {
    expect(
      decideVolumeCut([
        { key: 'hrv_drop', marked: false, value: 16, baseline: 60 },
        { key: 'short_sleep', marked: false, value: 5.5, baseline: null },
      ]),
    ).toEqual({ severity: 'moderate', volume_pct: ADJUST_THRESHOLDS.moderatePct });
  });
  it('a marked signal or three signals: 25%', () => {
    expect(
      decideVolumeCut([
        { key: 'hrv_drop', marked: true, value: 30, baseline: 60 },
        { key: 'load_spike', marked: false, value: 1.6, baseline: 20 },
      ]),
    ).toEqual({ severity: 'marked', volume_pct: ADJUST_THRESHOLDS.markedPct });
  });
});

describe('cutVolume / setsChange / applyChange', () => {
  it('15% of 18 sets is 15 sets; sets come off the exercise with the most sets first (the later one on a tie), reps and load untouched', () => {
    const ex = [EX(0, 5), EX(1, 4), EX(2, 3), EX(3, 3), EX(4, 3)];
    const c = cutVolume(ex, 15);
    // 18 -> 15 is a 17% cut: the stored percentage is the realized one (B-655-6).
    expect(c).toMatchObject({ volume_pct: 17, sets_before: 18, sets_after: 15 });
    expect(c.exercises.map((e) => e.sets_after)).toEqual([3, 3, 3, 3, 3]);
    const after = applyChange(ex, c);
    expect(after.map((e) => [e.reps_or_duration_seconds, e.weight_lbs, e.rest_seconds])).toEqual(
      ex.map((e) => [e.reps_or_duration_seconds, e.weight_lbs, e.rest_seconds]),
    );
  });
  it('never drops an exercise below one set', () => {
    const c = cutVolume([EX(0, 1), EX(1, 1), EX(2, 2)], 50);
    expect(c.exercises.map((e) => e.sets_after)).toEqual([1, 1, 1]);
    // B-655-6: the floor stops the cut at 4 -> 3 sets, which is 25%, not the 50% asked for.
    expect(c).toMatchObject({ volume_pct: 25, sets_before: 4, sets_after: 3 });
  });
  it('explicit set counts compute the honest percentage', () => {
    const c = setsChange([EX(0, 4), EX(1, 4)], new Map([[1, 2]]));
    expect(c).toMatchObject({ sets_before: 8, sets_after: 6, volume_pct: 25 });
  });
});

describe("Roman's phrasing", () => {
  it('names the evidence, the change and the question; no exclamation marks, no medical words', () => {
    const t = romanProposalText({
      clientFirstName: 'Maya',
      signals: [
        { key: 'hrv_drop', marked: false, value: 18, baseline: 60 },
        { key: 'short_sleep', marked: false, value: 5.6, baseline: null },
      ],
      change: { volume_pct: 15, sets_before: 18, sets_after: 15, exercises: [] },
      planName: 'Lower Body A',
      when: "Saturday's",
    });
    expect(t).toBe(
      "Maya's recovery has dipped. Heart-rate variability is 18% below the usual and sleep has averaged 5.6 hours on the nights tracked in the last 3 days. Roman suggests trimming Saturday's Lower Body A by 15%, from 18 to 15 sets. Reps and loads stay as you set them. Approve to apply it.",
    );
    expect(t).not.toMatch(/!|diagnos|illness|sick|treat|injur/i);
    // B-655-9: no first person; B-655-5: the sleep figure claims only the nights actually tracked.
    expect(t).not.toMatch(/\bI\b|\bI'|\bme\b|\bmy\b|\bwe\b|\bus\b/i);
    expect(t).not.toMatch(/last 3 nights/);
  });
  it('when-word is the weekday on the client calendar, never today/tomorrow (B-655-3: true whenever it is read)', () => {
    expect(whenWord(new Date('2026-10-03T01:00:00Z'), TZ)).toBe("Friday's"); // 18:00 Oct 2 local
    expect(whenWord(new Date('2026-10-03T16:00:00Z'), TZ)).toBe("Saturday's");
    expect(whenWord(new Date('2026-10-05T16:00:00Z'), TZ)).toBe("Monday's");
  });
});
