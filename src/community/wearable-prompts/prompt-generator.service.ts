import { Injectable, Logger } from '@nestjs/common';
import { WearableMetricType } from '@prisma/client';
import { WearableSamplesService } from '../../wearables/samples/wearable-samples.service';
import { METRIC_BUCKET } from '../../wearables/samples/metric-bucket.map';
import { WearablePromptsRepository } from './wearable-prompts.repository';
import {
  WEARABLE_LOOKBACK_DAYS,
  type PromptMetricKey,
} from './wearable-prompts.dto';

/** A computed metric trend over the lookback window. */
export interface MetricTrend {
  metric: PromptMetricKey;
  /** Mean of the older half of the window. */
  baseline: number;
  /** Mean of the most-recent half of the window. */
  recent: number;
  /** Signed percent change recent-vs-baseline (e.g. -12 for a 12% drop). */
  changePct: number;
  unit: string;
  /** Real WearableSample.ids (+ values) backing the trend (audit trail). */
  samples: Array<{ id: string; value: number }>;
}

/** A fully-built prompt ready to persist. */
export interface BuiltPrompt {
  metricKey: PromptMetricKey;
  promptText: string;
  sources: Array<{ sampleId: string; metricKey: string; observedValue: number }>;
}

/**
 * Human-readable, NON-MEDICALIZED metric labels for prompt copy. Mirrors the
 * "plain-language display_name" doctrine of WearableMetricDef (#40). Copy is
 * observational ("dropped 12%") and suggests a check-in — never a diagnosis.
 */
const METRIC_LABEL: Record<PromptMetricKey, string> = {
  [WearableMetricType.HRV_MS]: 'HRV',
  [WearableMetricType.RECOVERY_SCORE]: 'recovery score',
  [WearableMetricType.READINESS_SCORE]: 'readiness',
  [WearableMetricType.SLEEP_EFFICIENCY_PCT]: 'sleep efficiency',
  [WearableMetricType.SLEEP_TOTAL_MIN]: 'total sleep',
  [WearableMetricType.RESTING_HEART_RATE_BPM]: 'resting heart rate',
};

/** Minimum absolute percent change to consider a trend worth a prompt. */
const SIGNAL_THRESHOLD_PCT = 8;

/**
 * v3-4 prompt generator — turns a client's already-opted-in wearable trend
 * into a single coach-facing coaching prompt, recording the REAL WearableSample
 * ids that drove it.
 *
 * IMPORTANT: the generator NEVER decides consent or connector health — its
 * callers (WearablePromptsService) run the consent re-check and the
 * degraded-connector gate FIRST. The generator only computes the trend +
 * crafts copy. It reads samples through the existing WearableSamplesService
 * (read-precedence policy reused) and the repository's id lookup (audit trail);
 * it does not touch the wearables subsystem's write paths.
 */
@Injectable()
export class PromptGeneratorService {
  private readonly logger = new Logger(PromptGeneratorService.name);

  constructor(
    private readonly samples: WearableSamplesService,
    private readonly repo: WearablePromptsRepository,
  ) {}

  /**
   * Compute the trend for one metric over the lookback window. Returns null
   * when there is not enough data in BOTH halves to compute a change (no_data),
   * or when the change is below the signal threshold (no_signal) — the caller
   * maps null onto the right bounded skip reason.
   */
  async computeTrend(
    clientId: string,
    coachRequesterId: string,
    metric: PromptMetricKey,
    now: Date = new Date(),
  ): Promise<MetricTrend | null> {
    const from = new Date(now.getTime() - WEARABLE_LOOKBACK_DAYS * 86_400_000);
    const bucket = METRIC_BUCKET[metric];

    // Reuse the samples read API (read-precedence policy, IDOR check). The
    // coach is authorized for the client via the service's own gate already.
    const response = await this.samples.getSeries(coachRequesterId, 'coach', {
      bucket,
      metric,
      from,
      to: now,
      clientId,
      granularity: 'raw',
      preferredOnly: true,
    });

    const series = response.series.find((s) => s.metric === metric);
    if (!series || series.samples.length < 4) return null;

    // Split the window at the midpoint; compare recent half to older half.
    const mid = from.getTime() + (now.getTime() - from.getTime()) / 2;
    const older: number[] = [];
    const recent: number[] = [];
    for (const s of series.samples) {
      const t = new Date(s.start_at).getTime();
      (t < mid ? older : recent).push(s.value);
    }
    if (older.length === 0 || recent.length === 0) return null;

    const baseline = mean(older);
    const recentMean = mean(recent);
    if (baseline === 0) return null;
    const changePct = ((recentMean - baseline) / Math.abs(baseline)) * 100;

    if (Math.abs(changePct) < SIGNAL_THRESHOLD_PCT) return null;

    // Pull REAL sample ids for the audit trail (brief test 4).
    const sampleIds = await this.repo.findRecentSampleIds(clientId, metric, from);
    if (sampleIds.length === 0) return null;

    return {
      metric,
      baseline,
      recent: recentMean,
      changePct,
      unit: series.unit,
      samples: sampleIds,
    };
  }

  /**
   * Build the coach-facing prompt copy + source rows from a trend. Copy is
   * deterministic and observational. `clientFirstName` is the coach's own view
   * of their client's name (already authorized) — used only in the prompt text
   * the coach reads, never persisted in telemetry.
   */
  build(trend: MetricTrend, clientFirstName: string): BuiltPrompt {
    const label = METRIC_LABEL[trend.metric];
    const dir = trend.changePct < 0 ? 'dropped' : 'risen';
    const pct = Math.round(Math.abs(trend.changePct));
    const name = clientFirstName.trim() || 'Your client';

    const promptText = `${name}'s ${label} has ${dir} ${pct}% over the last ${WEARABLE_LOOKBACK_DAYS} days — consider checking in.`;

    return {
      metricKey: trend.metric,
      promptText,
      sources: trend.samples.map((s) => ({
        sampleId: s.id,
        metricKey: trend.metric,
        observedValue: s.value,
      })),
    };
  }
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
