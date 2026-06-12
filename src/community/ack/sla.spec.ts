/**
 * v2-2 SLA helper unit tests.
 *
 * Pins the threshold-resolution + classification contract: env overrides,
 * defaults, the inclusive upper boundaries (soft → warning, hard → breached),
 * clock-skew clamping, and the full snapshot shape. No DB, no Nest.
 */
import {
  DEFAULT_SLA_HARD_MS,
  DEFAULT_SLA_SOFT_MS,
  buildSlaSnapshot,
  classifySla,
  resolveSlaThresholds,
} from './sla';

const HOUR = 60 * 60 * 1000;

/**
 * `NodeJS.ProcessEnv` has the index signature `[k: string]: string | undefined`,
 * so a plain string-valued record is directly assignable to it. Typing the
 * helper return as `NodeJS.ProcessEnv` keeps the fakes cast-free (R0).
 */
function env(vars: Record<string, string> = {}): NodeJS.ProcessEnv {
  return vars;
}

describe('resolveSlaThresholds', () => {
  it('falls back to 24h soft / 48h hard when env is unset', () => {
    const t = resolveSlaThresholds(env());
    expect(t.softMs).toBe(DEFAULT_SLA_SOFT_MS);
    expect(t.hardMs).toBe(DEFAULT_SLA_HARD_MS);
  });

  it('reads positive integer overrides from the environment', () => {
    const t = resolveSlaThresholds(
      env({
        COMMUNITY_ACK_SLA_SOFT_MS: String(2 * HOUR),
        COMMUNITY_ACK_SLA_HARD_MS: String(6 * HOUR),
      }),
    );
    expect(t.softMs).toBe(2 * HOUR);
    expect(t.hardMs).toBe(6 * HOUR);
  });

  it('ignores a non-positive / non-numeric soft override (fails safe)', () => {
    const t = resolveSlaThresholds(env({ COMMUNITY_ACK_SLA_SOFT_MS: '-5' }));
    expect(t.softMs).toBe(DEFAULT_SLA_SOFT_MS);
  });

  it('preserves soft < hard when hard is not strictly greater than soft', () => {
    const t = resolveSlaThresholds(
      env({
        COMMUNITY_ACK_SLA_SOFT_MS: String(10 * HOUR),
        COMMUNITY_ACK_SLA_HARD_MS: String(5 * HOUR),
      }),
    );
    expect(t.softMs).toBe(10 * HOUR);
    expect(t.hardMs).toBe(20 * HOUR); // soft * 2 guard
    expect(t.hardMs).toBeGreaterThan(t.softMs);
  });
});

describe('classifySla', () => {
  const thresholds = { softMs: 24 * HOUR, hardMs: 48 * HOUR };

  it('is within before the soft target', () => {
    expect(classifySla(HOUR, thresholds)).toBe('within');
    expect(classifySla(24 * HOUR - 1, thresholds)).toBe('within');
  });

  it('is warning at and after the soft target, before hard', () => {
    expect(classifySla(24 * HOUR, thresholds)).toBe('warning');
    expect(classifySla(36 * HOUR, thresholds)).toBe('warning');
    expect(classifySla(48 * HOUR - 1, thresholds)).toBe('warning');
  });

  it('is breached at and after the hard target', () => {
    expect(classifySla(48 * HOUR, thresholds)).toBe('breached');
    expect(classifySla(100 * HOUR, thresholds)).toBe('breached');
  });

  it('clamps negative elapsed (clock skew) to within', () => {
    expect(classifySla(-5000, thresholds)).toBe('within');
  });
});

describe('buildSlaSnapshot', () => {
  it('produces the full snapshot shape from receivedAt + now', () => {
    const receivedAt = new Date('2026-01-01T00:00:00.000Z');
    const now = new Date(receivedAt.getTime() + 30 * HOUR); // +30h
    const snap = buildSlaSnapshot({
      receivedAt,
      now,
      thresholds: { softMs: 24 * HOUR, hardMs: 48 * HOUR },
    });
    expect(snap.sla_state).toBe('warning');
    expect(snap.elapsed_ms).toBe(30 * HOUR);
    expect(snap.soft_target_ms).toBe(24 * HOUR);
    expect(snap.hard_target_ms).toBe(48 * HOUR);
  });

  it('clamps a future receivedAt to zero elapsed (within)', () => {
    const receivedAt = new Date('2026-01-02T00:00:00.000Z');
    const now = new Date('2026-01-01T00:00:00.000Z');
    const snap = buildSlaSnapshot({ receivedAt, now });
    expect(snap.elapsed_ms).toBe(0);
    expect(snap.sla_state).toBe('within');
  });
});
