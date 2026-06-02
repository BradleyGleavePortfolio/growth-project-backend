import { readFileSync } from 'fs';
import { join } from 'path';
import { WearableMetricBucket, WearableMetricType } from '@prisma/client';
import {
  METRIC_BUCKET,
  METRIC_AGGREGATION,
  metricsInBucket,
  type MetricAggregation,
} from '../../src/wearables/samples/metric-bucket.map';

// HK-3a supplemental — verifies the three sleep-consistency keys added for
// HK-3b recovery-bucket wire parity (SLEEP_DURATION_MIN / SLEEP_ONSET_ISO /
// SLEEP_WAKE_ISO) are classified consistently across the compile-time mirrors
// AND the seed migration, so the onModuleInit drift check stays green.

const NEW_SLEEP_KEYS = [
  WearableMetricType.SLEEP_DURATION_MIN,
  WearableMetricType.SLEEP_ONSET_ISO,
  WearableMetricType.SLEEP_WAKE_ISO,
] as const;

describe('metric-bucket map — sleep-consistency keys (HK-3b parity)', () => {
  it('maps all three new keys to the SLEEP_RECOVERY bucket', () => {
    for (const key of NEW_SLEEP_KEYS) {
      expect(METRIC_BUCKET[key]).toBe(WearableMetricBucket.SLEEP_RECOVERY);
    }
  });

  it('includes all three new keys when enumerating the sleep bucket', () => {
    const sleepMetrics = metricsInBucket(WearableMetricBucket.SLEEP_RECOVERY);
    for (const key of NEW_SLEEP_KEYS) {
      expect(sleepMetrics).toContain(key);
    }
  });

  it('assigns the expected aggregation strategy to each new key', () => {
    const expected: Record<(typeof NEW_SLEEP_KEYS)[number], MetricAggregation> =
      {
        // Total time asleep is additive over the night (mirrors SLEEP_TOTAL_MIN).
        SLEEP_DURATION_MIN: 'sum',
        // Bedtime / wake-time are point-in-time minute-of-day readings.
        SLEEP_ONSET_ISO: 'last',
        SLEEP_WAKE_ISO: 'last',
      };
    for (const key of NEW_SLEEP_KEYS) {
      expect(METRIC_AGGREGATION[key]).toBe(expected[key]);
    }
  });
});

describe('WearableMetricDef seed — sleep-consistency defs (HK-3b parity)', () => {
  const seedSql = readFileSync(
    join(
      __dirname,
      '../../prisma/migrations/20261211000001_seed_sleep_consistency_metric_defs/migration.sql',
    ),
    'utf8',
  );

  it('seeds a WearableMetricDef row for each new key in the sleep bucket', () => {
    for (const key of NEW_SLEEP_KEYS) {
      // Each row is a single VALUES tuple beginning with the metric literal
      // and carrying the SLEEP_RECOVERY bucket — assert both on the same line.
      const rowPattern = new RegExp(
        `\\('${key}',\\s*'SLEEP_RECOVERY',`,
      );
      expect(seedSql).toMatch(rowPattern);
    }
  });

  it('seeds aggregations that agree with the compile-time mirror', () => {
    // SLEEP_DURATION_MIN -> 'sum'; SLEEP_ONSET_ISO / SLEEP_WAKE_ISO -> 'last'.
    expect(seedSql).toMatch(/\('SLEEP_DURATION_MIN',[^\n]*'sum',/);
    expect(seedSql).toMatch(/\('SLEEP_ONSET_ISO',[^\n]*'last',/);
    expect(seedSql).toMatch(/\('SLEEP_WAKE_ISO',[^\n]*'last',/);
  });

  it('adds each new enum value in the companion ALTER TYPE migration', () => {
    const alterSql = readFileSync(
      join(
        __dirname,
        '../../prisma/migrations/20261211000000_add_sleep_consistency_metrics/migration.sql',
      ),
      'utf8',
    );
    for (const key of NEW_SLEEP_KEYS) {
      expect(alterSql).toMatch(
        new RegExp(
          `ALTER TYPE "WearableMetricType" ADD VALUE IF NOT EXISTS '${key}'`,
        ),
      );
    }
  });
});
