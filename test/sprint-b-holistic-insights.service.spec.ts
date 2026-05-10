import { HolisticInsightsService } from '../src/insights/holistic-insights.service';

// computeEnvelope is pure: it takes pre-shaped fitness + finance
// weekly buckets and returns the public envelope. We test the
// thresholding logic (>= 4 weeks AND |r| >= 0.3) and the empty-
// state copy without mocking Prisma or the federation client.

const service = new HolisticInsightsService(
  // @ts-expect-error — Prisma & finance client unused in computeEnvelope.
  null,
  null,
);

const buckets = (
  pairs: Array<[string, number]>,
): { weekKey: string; value: number; sampleCount: number }[] =>
  pairs.map(([weekKey, value]) => ({ weekKey, value, sampleCount: 1 }));

describe('HolisticInsightsService.computeEnvelope', () => {
  const generatedAt = '2026-05-09T00:00:00.000Z';

  it('returns insufficient_data when only 3 weeks overlap (below 4-week threshold)', () => {
    const fitness = {
      cardio: buckets([
        ['2026-W18', 60],
        ['2026-W19', 90],
        ['2026-W20', 120],
      ]),
      strength: [],
      weight: [],
      sleep: [],
    };
    const finance = [
      { weekKey: '2026-W18', savings_rate_pct: 5, spending_kusd: 1, debt_to_income: 0.3 },
      { weekKey: '2026-W19', savings_rate_pct: 7, spending_kusd: 1, debt_to_income: 0.3 },
      { weekKey: '2026-W20', savings_rate_pct: 9, spending_kusd: 1, debt_to_income: 0.3 },
    ];
    const env = service.computeEnvelope(fitness, finance, 90, generatedAt);
    expect(env.status).toBe('insufficient_data');
    expect(env.insights).toEqual([]);
    expect(env.notes[0]).toMatch(/more data/i);
  });

  it('returns insights when correlation is strong over 4+ aligned weeks', () => {
    const cardio = buckets([
      ['2026-W17', 30],
      ['2026-W18', 45],
      ['2026-W19', 60],
      ['2026-W20', 75],
    ]);
    const fitness = { cardio, strength: [], weight: [], sleep: [] };
    const finance = [
      { weekKey: '2026-W17', savings_rate_pct: 5, spending_kusd: 1, debt_to_income: 0.3 },
      { weekKey: '2026-W18', savings_rate_pct: 7, spending_kusd: 1, debt_to_income: 0.3 },
      { weekKey: '2026-W19', savings_rate_pct: 9, spending_kusd: 1, debt_to_income: 0.3 },
      { weekKey: '2026-W20', savings_rate_pct: 11, spending_kusd: 1, debt_to_income: 0.3 },
    ];
    const env = service.computeEnvelope(fitness, finance, 90, generatedAt);
    expect(env.status).toBe('ok');
    expect(env.insights.length).toBeGreaterThan(0);
    const top = env.insights[0];
    expect(top.weeks).toBe(4);
    expect(top.correlation).toBeCloseTo(1, 2);
    expect(top.text).toMatch(/cardio minutes/);
  });

  it('drops weak correlations below |r| = 0.3', () => {
    const cardio = buckets([
      ['2026-W17', 60],
      ['2026-W18', 60],
      ['2026-W19', 60.1],
      ['2026-W20', 60.05],
    ]);
    const fitness = { cardio, strength: [], weight: [], sleep: [] };
    // Wildly different finance series — variance high but correlation
    // with the near-flat cardio series is essentially noise.
    const finance = [
      { weekKey: '2026-W17', savings_rate_pct: 1, spending_kusd: 1, debt_to_income: 0.3 },
      { weekKey: '2026-W18', savings_rate_pct: 50, spending_kusd: 1, debt_to_income: 0.3 },
      { weekKey: '2026-W19', savings_rate_pct: 12, spending_kusd: 1, debt_to_income: 0.3 },
      { weekKey: '2026-W20', savings_rate_pct: 32, spending_kusd: 1, debt_to_income: 0.3 },
    ];
    const env = service.computeEnvelope(fitness, finance, 90, generatedAt);
    // r should not be strong with near-flat input
    expect(env.insights.every((i) => Math.abs(i.correlation) >= 0.3)).toBe(true);
  });

  it('emits envelope version 1 always', () => {
    const env = service.computeEnvelope(
      { cardio: [], strength: [], weight: [], sleep: [] },
      [],
      90,
      generatedAt,
    );
    expect(env.version).toBe(1);
    expect(env.generated_at).toBe(generatedAt);
  });
});
