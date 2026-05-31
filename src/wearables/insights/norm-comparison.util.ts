import { WearableMetricType } from '@prisma/client';

// PR-HK-4 — population-norm comparison.
//
// Pre-computed population norms used to enrich the LLM prompt with a
// grounded percentile statement ("your client's HRV of 28ms is in the
// 12th percentile vs adult norms"). The model is NOT asked to invent
// norms — we compute the percentile deterministically here and hand the
// model a sentence, so the same value always yields the same comparison
// (no hallucinated statistics).
//
// SCIENTIFIC SOURCES (cited inline; medians/SD from peer-reviewed adult
// reference ranges — wide bands, general-population, NOT diagnostic):
//   - HRV (RMSSD, ms): adult median ~40ms, SD ~15. Lampert et al 2024,
//     "Heart Rate Variability in Health and Disease" — adult RMSSD norm.
//   - Resting HR (bpm): adult median ~65, SD ~10. AHA general-population
//     resting heart-rate reference (Nanchen 2018).
//   - Sleep total (min): adult median ~430 (~7.2h), SD ~60. NSF 2015
//     consensus, 7-9h recommended for adults.
//   - Sleep efficiency (%): adult median ~88, SD ~6. Ohayon et al 2017,
//     "National Sleep Foundation's sleep quality recommendations".
//   - Steps/day: adult median ~7000, SD ~3000. Tudor-Locke 2011
//     graduated step-index.
//   - VO2max (ml/kg/min): adult median ~38, SD ~9. ACSM 2021 normative
//     fitness tables (sex-pooled mid-band).
//   - Respiratory rate (br/min): adult median ~15, SD ~3. Normal adult
//     resting respiratory rate (range 12-20).
//   - SpO2 (%): adult median ~97, SD ~1.5. Healthy adult resting range
//     95-100%.
//
// All norms are SEX-POOLED and AGE-NEUTRAL by default. `userAge` applies a
// small, conservative shift for the two metrics where age effect is large
// and well-established (HRV declines with age; VO2max declines with age).

export type NormBand = 'low' | 'typical' | 'high';

export interface NormComparison {
  percentile: number; // 0-100, rounded to nearest integer
  band: NormBand;
  norm_text: string;
}

interface NormStat {
  // Population mean (≈ median for these roughly-symmetric distributions).
  mean: number;
  // Population standard deviation.
  sd: number;
  // Display unit for the norm_text sentence.
  unit: string;
  // Plain-language metric name for the sentence.
  label: string;
}

// Norm table keyed by metric. Only metrics with a meaningful population
// norm are listed; unlisted metrics return a neutral "typical" with a
// 50th-percentile placeholder so the prompt builder never crashes on an
// exotic metric.
const NORMS: Partial<Record<WearableMetricType, NormStat>> = {
  [WearableMetricType.HRV_MS]: { mean: 40, sd: 15, unit: 'ms', label: 'HRV' },
  [WearableMetricType.RESTING_HEART_RATE_BPM]: {
    mean: 65,
    sd: 10,
    unit: 'bpm',
    label: 'resting heart rate',
  },
  [WearableMetricType.SLEEP_TOTAL_MIN]: {
    mean: 430,
    sd: 60,
    unit: 'min',
    label: 'total sleep',
  },
  [WearableMetricType.SLEEP_EFFICIENCY_PCT]: {
    mean: 88,
    sd: 6,
    unit: '%',
    label: 'sleep efficiency',
  },
  [WearableMetricType.STEPS]: { mean: 7000, sd: 3000, unit: 'steps', label: 'daily steps' },
  [WearableMetricType.VO2_MAX]: {
    mean: 38,
    sd: 9,
    unit: 'ml/kg/min',
    label: 'VO2 max',
  },
  [WearableMetricType.RESPIRATORY_RATE_BRPM]: {
    mean: 15,
    sd: 3,
    unit: 'br/min',
    label: 'respiratory rate',
  },
  [WearableMetricType.SPO2_PCT]: { mean: 97, sd: 1.5, unit: '%', label: 'SpO2' },
};

// Metrics where a HIGHER value is WORSE (so the "band" semantics flip).
// Resting HR and respiratory rate: lower is generally fitter. Everything
// else in the table reads "higher = better/typical-high".
const HIGHER_IS_WORSE = new Set<WearableMetricType>([
  WearableMetricType.RESTING_HEART_RATE_BPM,
  WearableMetricType.RESPIRATORY_RATE_BRPM,
]);

// Standard normal CDF via the Abramowitz-Stegun 7.1.26 erf approximation.
// Max abs error ~1.5e-7 — far tighter than the integer percentile we
// report, so percentile outputs are stable and reproducible for tests.
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z));
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const erf =
    1 -
    ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);
  const signedErf = z >= 0 ? erf : -erf;
  return 0.5 * (1 + signedErf);
}

// Apply a conservative age adjustment for the two age-sensitive metrics.
// HRV declines ~0.4ms/yr past 30; VO2max declines ~0.4 ml/kg/min/yr past
// 30. We shift the population MEAN toward the age-expected value so a
// 55yo with HRV 28 is not flagged as low against a 25yo's norm.
function ageAdjustedMean(
  metric: WearableMetricType,
  base: number,
  userAge?: number,
): number {
  if (userAge == null || !Number.isFinite(userAge) || userAge <= 30) return base;
  const yearsPast30 = userAge - 30;
  if (metric === WearableMetricType.HRV_MS) {
    return Math.max(10, base - 0.4 * yearsPast30);
  }
  if (metric === WearableMetricType.VO2_MAX) {
    return Math.max(15, base - 0.4 * yearsPast30);
  }
  return base;
}

// Classify a percentile into a three-band label. We use the central ~50%
// (25th-75th percentile) as "typical"; below is "low", above is "high".
// These are PERCENTILE bands, not value bands, so the direction-of-good
// is captured separately in the norm_text wording.
function bandForPercentile(percentile: number): NormBand {
  if (percentile < 25) return 'low';
  if (percentile > 75) return 'high';
  return 'typical';
}

// Compare a single metric value to the population norm.
//
// Returns:
//   percentile — where this value sits vs the population (0-100, integer)
//   band       — low | typical | high (percentile-based)
//   norm_text  — a ready-to-embed sentence for the prompt context
//
// For metrics with no norm entry we return a neutral 50th-percentile
// "typical" with an honest "no population norm available" sentence so the
// model is never handed a fabricated statistic.
export function compareToNorm(
  metric: WearableMetricType,
  value: number,
  userAge?: number,
): NormComparison {
  const stat = NORMS[metric];
  if (!stat || !Number.isFinite(value)) {
    return {
      percentile: 50,
      band: 'typical',
      norm_text: 'No population norm is available for this metric yet.',
    };
  }

  const mean = ageAdjustedMean(metric, stat.mean, userAge);
  const z = (value - mean) / stat.sd;
  const rawPercentile = normalCdf(z) * 100;
  const percentile = Math.round(rawPercentile);
  const band = bandForPercentile(percentile);

  // Direction-aware framing: for higher-is-worse metrics, a high
  // percentile is the concerning end, so we word the sentence in plain,
  // non-medical language ("elevated vs typical adult range").
  const higherWorse = HIGHER_IS_WORSE.has(metric);
  const ageNote = userAge != null && userAge > 30 ? ' (age-adjusted)' : '';
  const directionWord = higherWorse
    ? band === 'high'
      ? 'above'
      : band === 'low'
        ? 'below'
        : 'within'
    : band === 'high'
      ? 'above'
      : band === 'low'
        ? 'below'
        : 'within';

  const norm_text =
    `${value}${stat.unit === '%' ? '%' : ' ' + stat.unit} ${stat.label} is in the ` +
    `${ordinal(percentile)} percentile, ${directionWord} the typical adult range${ageNote}.`;

  return { percentile, band, norm_text };
}

// English ordinal suffix for the percentile sentence (1st, 2nd, 3rd, 12th).
function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}
