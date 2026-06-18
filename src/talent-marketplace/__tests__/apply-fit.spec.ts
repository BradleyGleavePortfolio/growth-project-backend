import { computeFitSignal, type FitInputs } from '../apply-fit';

// apply-fit is a pure, deterministic function — no Prisma, no IO, no PII. These
// tests pin the two-way scoring axes (specialty overlap + compensation shape),
// the three-level mapping, clamping, and reproducibility.

function inputs(over: Partial<FitInputs> = {}): FitInputs {
  return {
    applicantSpecialties: [],
    listingSpecialty: null,
    listingCompensationType: 'flat',
    ...over,
  };
}

describe('computeFitSignal — determinism & purity', () => {
  it('returns identical output for identical input (reproducible chip)', () => {
    const a = computeFitSignal(
      inputs({ applicantSpecialties: ['Strength'], listingSpecialty: 'strength' }),
    );
    const b = computeFitSignal(
      inputs({ applicantSpecialties: ['Strength'], listingSpecialty: 'strength' }),
    );
    expect(a).toEqual(b);
  });

  it('does not mutate its input arrays', () => {
    const specialties = ['Strength', 'Mobility'];
    const snapshot = [...specialties];
    computeFitSignal(inputs({ applicantSpecialties: specialties, listingSpecialty: 'strength' }));
    expect(specialties).toEqual(snapshot);
  });
});

describe('computeFitSignal — specialty axis', () => {
  it('scores a direct specialty hit as a strong match', () => {
    const result = computeFitSignal(
      inputs({
        applicantSpecialties: ['Strength & Conditioning'],
        listingSpecialty: 'Strength',
        listingCompensationType: 'flat',
      }),
    );
    expect(result.level).toBe('strong');
    expect(result.score).toBeGreaterThanOrEqual(67);
  });

  it('is case-insensitive and matches either containment direction', () => {
    const result = computeFitSignal(
      inputs({ applicantSpecialties: ['NUTRITION'], listingSpecialty: 'nutrition coaching' }),
    );
    // applicant "nutrition" is contained in listing "nutrition coaching"
    expect(result.score).toBeGreaterThanOrEqual(67);
  });

  it('treats a missing listing specialty as neutral (cannot signal direction)', () => {
    const result = computeFitSignal(
      inputs({ applicantSpecialties: ['Strength'], listingSpecialty: null, listingCompensationType: 'flat' }),
    );
    // neutral 50 specialty * 0.7 + 100 comp * 0.3 = 65 → moderate, not strong
    expect(result.level).toBe('moderate');
  });

  it('scores listed-but-unmatched specialties as a weak fit', () => {
    const result = computeFitSignal(
      inputs({
        applicantSpecialties: ['Yoga'],
        listingSpecialty: 'Powerlifting',
        listingCompensationType: 'commission',
      }),
    );
    // 20 * 0.7 + 45 * 0.3 = 27.5 → 28 → exploratory
    expect(result.level).toBe('exploratory');
  });

  it('ignores blank specialty entries when matching', () => {
    const result = computeFitSignal(
      inputs({ applicantSpecialties: ['  ', ''], listingSpecialty: 'Strength' }),
    );
    // no real specialty listed → neutral 50 path, not weak 20
    expect(result.score).toBeGreaterThan(28);
  });
});

describe('computeFitSignal — compensation axis', () => {
  const matched = (type: FitInputs['listingCompensationType']) =>
    computeFitSignal(
      inputs({
        applicantSpecialties: ['Strength'],
        listingSpecialty: 'Strength',
        listingCompensationType: type,
      }),
    ).score;

  it('ranks flat >= hybrid >= rev_share >= commission for the same specialty fit', () => {
    expect(matched('flat')).toBeGreaterThanOrEqual(matched('hybrid'));
    expect(matched('hybrid')).toBeGreaterThanOrEqual(matched('rev_share'));
    expect(matched('rev_share')).toBeGreaterThanOrEqual(matched('commission'));
  });
});

describe('computeFitSignal — output contract', () => {
  it('always emits an integer score within 0..100', () => {
    for (const type of ['commission', 'rev_share', 'flat', 'hybrid'] as const) {
      const { score } = computeFitSignal(
        inputs({ applicantSpecialties: ['Strength'], listingSpecialty: 'Strength', listingCompensationType: type }),
      );
      expect(Number.isInteger(score)).toBe(true);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    }
  });

  it('emits exactly one of the three known levels with a human label', () => {
    const { level, label } = computeFitSignal(
      inputs({ applicantSpecialties: ['Strength'], listingSpecialty: 'Strength' }),
    );
    expect(['strong', 'moderate', 'exploratory']).toContain(level);
    expect(label.length).toBeGreaterThan(0);
  });
});
