/**
 * Output envelope returned to the mobile client. The shape is
 * intentionally explicit so a future schema migration is detectable
 * by version number rather than by guessing field presence.
 */

export type InsightStatus = 'ok' | 'insufficient_data' | 'finance_unavailable';

export interface HolisticInsight {
  /** Stable id for client-side keys (sha256 of label + correlation pair). */
  id: string;
  /** Short human-readable summary. */
  text: string;
  /** Pearson r in [-1, 1]. */
  correlation: number;
  /** Number of weeks contributing to r. */
  weeks: number;
  /** ISO week range, inclusive. */
  weekKeyRange: { from: string; to: string };
  /** Pillar pair, e.g. ["fitness:cardio_minutes", "finance:savings_rate_pct"]. */
  series: [string, string];
}

export interface HolisticInsightsEnvelope {
  version: 1;
  status: InsightStatus;
  generated_at: string;
  data_window: { window_days: number; weeks_observed: number };
  insights: HolisticInsight[];
  // Honest empty-state copy. Populated even when status === 'ok'.
  notes: string[];
}
