import type { FitSignalDto } from './apply.dto';

// TM-5 two-way fit. A PURE function: applicant's desired/offered profile vs the
// listing's offered/desired terms → ONE primary signal (a single chip), never a
// scorecard (luxury doctrine). Deterministic and side-effect free so it is
// trivially unit-tested and safe to call inside the idempotent apply path.
//
// Two cheap, explainable axes drive the one chip:
//   1. Specialty overlap — applicant.specialties ∩ listing.specialty (the
//      hirer's sought discipline). The strongest two-way signal: the hunter
//      does what the listing wants.
//   2. Compensation alignment — does the listing's compensation_type sit in the
//      shapes most pre-coaches accept (flat/hybrid carry a floor; pure
//      commission/rev_share is higher-variance, so a touch more exploratory).
// The blended 0–100 score maps to exactly one of three levels + a human label.

export interface FitInputs {
  applicantSpecialties: string[];
  listingSpecialty: string | null;
  listingCompensationType: 'commission' | 'rev_share' | 'flat' | 'hybrid';
}

const STRONG_THRESHOLD = 67;
const MODERATE_THRESHOLD = 34;

export function computeFitSignal(inputs: FitInputs): FitSignalDto {
  const specialtyScore = scoreSpecialty(
    inputs.applicantSpecialties,
    inputs.listingSpecialty,
  );
  const compScore = scoreCompensation(inputs.listingCompensationType);

  // Specialty is the dominant two-way axis; compensation nudges it. Clamp to
  // a stable 0–100 integer so the chip is reproducible across replays.
  const blended = Math.round(specialtyScore * 0.7 + compScore * 0.3);
  const score = Math.min(100, Math.max(0, blended));

  if (score >= STRONG_THRESHOLD) {
    return { level: 'strong', label: 'Strong match', score };
  }
  if (score >= MODERATE_THRESHOLD) {
    return { level: 'moderate', label: 'Good potential', score };
  }
  return { level: 'exploratory', label: 'Worth exploring', score };
}

// Case-insensitive containment either way: the listing specialty token appearing
// in any applicant specialty (or vice-versa) is a direct hit. No listing
// specialty → neutral 50 (cannot signal either direction).
function scoreSpecialty(
  applicantSpecialties: string[],
  listingSpecialty: string | null,
): number {
  if (!listingSpecialty || listingSpecialty.trim() === '') return 50;
  const target = listingSpecialty.trim().toLowerCase();
  const hit = applicantSpecialties.some((s) => {
    const a = s.trim().toLowerCase();
    return a !== '' && (a.includes(target) || target.includes(a));
  });
  if (hit) return 100;
  // The applicant listed specialties but none matched → weak fit. No listed
  // specialties at all is unknown rather than negative.
  return applicantSpecialties.length > 0 ? 20 : 50;
}

// Compensation shapes a pre-coach is likeliest to accept. A guaranteed floor
// (flat / hybrid) reads as higher mutual fit than pure variable pay.
function scoreCompensation(
  type: 'commission' | 'rev_share' | 'flat' | 'hybrid',
): number {
  switch (type) {
    case 'flat':
      return 100;
    case 'hybrid':
      return 80;
    case 'rev_share':
      return 55;
    case 'commission':
      return 45;
  }
}
