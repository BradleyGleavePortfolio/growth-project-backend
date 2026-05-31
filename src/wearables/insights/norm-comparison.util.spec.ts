import { compareToNorm } from './norm-comparison.util';
import { WearableMetricType } from '@prisma/client';

// PR-HK-4 norm-comparison contract tests. Percentile literals below are
// computed from the documented population means/SDs via the standard
// normal CDF (Abramowitz-Stegun erf approximation). Any change to a norm
// constant MUST update these anchors in lockstep.

describe('compareToNorm', () => {
  it('places HRV 28ms in the low band, ~13th percentile (adult norm 40±15)', () => {
    const res = compareToNorm(WearableMetricType.HRV_MS, 28);
    expect(res.percentile).toBe(13);
    expect(res.band).toBe('low');
    expect(res.norm_text).toContain('13th percentile');
    expect(res.norm_text).toContain('HRV');
  });

  it('places HRV at the mean (40ms) at the 50th percentile, typical band', () => {
    const res = compareToNorm(WearableMetricType.HRV_MS, 40);
    expect(res.percentile).toBe(50);
    expect(res.band).toBe('typical');
  });

  it('age-adjusts HRV for a 55yo (mean shifts to 30ms): 28ms → 43rd percentile, typical', () => {
    const res = compareToNorm(WearableMetricType.HRV_MS, 28, 55);
    expect(res.percentile).toBe(43);
    expect(res.band).toBe('typical');
    expect(res.norm_text).toContain('age-adjusted');
  });

  it('flags resting HR 80bpm as high (98th percentile, higher-is-worse)', () => {
    const res = compareToNorm(WearableMetricType.RESTING_HEART_RATE_BPM, 80);
    expect(res.percentile).toBe(98);
    expect(res.band).toBe('high');
    expect(res.norm_text).toContain('above');
  });

  it('places resting HR at the mean (65bpm) at the 50th percentile', () => {
    const res = compareToNorm(WearableMetricType.RESTING_HEART_RATE_BPM, 65);
    expect(res.percentile).toBe(50);
    expect(res.band).toBe('typical');
  });

  it('places 7000 steps at the 50th percentile (typical)', () => {
    const res = compareToNorm(WearableMetricType.STEPS, 7000);
    expect(res.percentile).toBe(50);
    expect(res.band).toBe('typical');
  });

  it('places 13000 steps at the 100th percentile (high)', () => {
    const res = compareToNorm(WearableMetricType.STEPS, 13000);
    expect(res.percentile).toBe(100);
    expect(res.band).toBe('high');
  });

  it('places sleep efficiency 88% at the 50th percentile', () => {
    const res = compareToNorm(WearableMetricType.SLEEP_EFFICIENCY_PCT, 88);
    expect(res.percentile).toBe(50);
    expect(res.norm_text).toContain('88%');
  });

  it('places SpO2 97% at the 50th percentile', () => {
    const res = compareToNorm(WearableMetricType.SPO2_PCT, 97);
    expect(res.percentile).toBe(50);
  });

  it('returns a neutral typical/50th for a metric with no norm entry', () => {
    const res = compareToNorm(WearableMetricType.STRAIN_SCORE, 12);
    expect(res.percentile).toBe(50);
    expect(res.band).toBe('typical');
    expect(res.norm_text).toContain('No population norm');
  });

  it('returns neutral for a non-finite value', () => {
    const res = compareToNorm(WearableMetricType.HRV_MS, NaN);
    expect(res.percentile).toBe(50);
    expect(res.band).toBe('typical');
  });
});
