import { ApiProperty } from '@nestjs/swagger';
import {
  WearableMetricBucket,
  WearableMetricType,
  WearableProvider,
} from '@prisma/client';
import { FRESHNESS_STATUSES } from './sample-response.schema';

/**
 * PR-HK-3a — OpenAPI response DTOs for `GET /v1/wearables/samples` (P2 #1).
 *
 * These classes exist ONLY so `@nestjs/swagger` can emit a typed 200 schema for
 * the locked envelope. The authoritative runtime contract remains the Zod
 * `SamplesResponseSchema` (the controller `.parse()`s every payload through it
 * before it leaves the process). The class shapes mirror that schema EXACTLY;
 * the response schema's own jest contract test keeps the two from drifting.
 * Datetimes are ISO-8601 strings on the wire (the service `.toISOString()`s its
 * `Date`s), so every datetime field is documented as a `string`.
 */

export class SampleDatumDto {
  @ApiProperty({
    format: 'date-time',
    description: 'ISO-8601 sample window start (inclusive).',
    example: '2026-03-07T10:00:00.000Z',
  })
  start_at!: string;

  @ApiProperty({
    format: 'date-time',
    description: 'ISO-8601 sample window end (exclusive).',
    example: '2026-03-07T10:01:00.000Z',
  })
  end_at!: string;

  @ApiProperty({
    description: 'Normalized metric value in the metric def unit.',
    example: 60,
  })
  value!: number;

  @ApiProperty({
    enum: WearableProvider,
    enumName: 'WearableProvider',
    description: 'The source provider that produced this sample.',
  })
  provider!: WearableProvider;
}

export class AggBucketDto {
  @ApiProperty({
    format: 'date-time',
    description: 'ISO-8601 start of the aggregation bucket (UTC date_trunc).',
    example: '2026-03-07T00:00:00.000Z',
  })
  bucket_start!: string;

  @ApiProperty({
    format: 'date-time',
    description:
      'ISO-8601 end of the aggregation bucket (bucket_start + exactly one ' +
      'granularity step; 24h for day, 1h for hour).',
    example: '2026-03-08T00:00:00.000Z',
  })
  bucket_end!: string;

  @ApiProperty({
    description:
      'The aggregated value for the bucket, computed per the metric def ' +
      'aggregation (sum/avg/last/max). Zero when the bucket has no rows.',
    example: 62.5,
  })
  agg!: number;

  @ApiProperty({
    description: 'Number of raw samples that fell in this bucket.',
    minimum: 0,
    example: 2,
  })
  count!: number;
}

export class SampleSeriesDto {
  @ApiProperty({
    enum: WearableMetricType,
    enumName: 'WearableMetricType',
    description: 'The metric this series represents.',
  })
  metric!: WearableMetricType;

  @ApiProperty({
    description: 'Display unit from the seeded WearableMetricDef (e.g. "bpm").',
    example: 'ms',
  })
  unit!: string;

  @ApiProperty({
    enum: WearableProvider,
    enumName: 'WearableProvider',
    nullable: true,
    description:
      'The single resolved provider in preferred mode (or a single-provider ' +
      'compare-all result); null when the series spans multiple providers or ' +
      'has zero samples.',
  })
  provider_used!: WearableProvider | null;

  @ApiProperty({
    description: 'Number of raw samples returned for this series.',
    minimum: 0,
    example: 4,
  })
  sample_count!: number;

  @ApiProperty({
    type: [SampleDatumDto],
    description: 'The raw samples in the window, ascending by start_at.',
  })
  samples!: SampleDatumDto[];

  @ApiProperty({
    type: [AggBucketDto],
    required: false,
    description:
      'Time-bucketed aggregation; present only when granularity != "raw".',
  })
  buckets?: AggBucketDto[];
}

export class FreshnessProviderDto {
  @ApiProperty({
    enum: WearableProvider,
    enumName: 'WearableProvider',
    description: 'The connected provider this freshness entry describes.',
  })
  provider!: WearableProvider;

  @ApiProperty({
    format: 'date-time',
    nullable: true,
    description:
      'ISO-8601 timestamp of the last successful sync, or null if the ' +
      'connection has never synced.',
    example: '2026-03-09T08:00:00.000Z',
  })
  last_synced_at!: string | null;

  @ApiProperty({
    enum: FRESHNESS_STATUSES,
    description:
      'Freshness tier: current | needs_attention | never_synced. A connection ' +
      'in any non-connected lifecycle state is always needs_attention.',
    example: 'current',
  })
  status!: (typeof FRESHNESS_STATUSES)[number];
}

export class SamplesWindowDto {
  @ApiProperty({
    format: 'date-time',
    description: 'Echoed window start (inclusive).',
    example: '2026-03-06T00:00:00.000Z',
  })
  from!: string;

  @ApiProperty({
    format: 'date-time',
    description: 'Echoed window end (exclusive).',
    example: '2026-03-10T00:00:00.000Z',
  })
  to!: string;
}

export class SamplesFreshnessDto {
  @ApiProperty({
    type: [FreshnessProviderDto],
    description:
      'One entry per non-disconnected connection relevant to the bucket.',
  })
  providers!: FreshnessProviderDto[];
}

export class SamplesResponseDto {
  @ApiProperty({
    description: 'Envelope version (locked at 1 for this contract).',
    enum: [1],
    example: 1,
  })
  version!: 1;

  @ApiProperty({
    description: 'The subject user id the series belong to.',
    example: '44444444-4444-4444-4444-444444444444',
  })
  user_id!: string;

  @ApiProperty({
    enum: WearableMetricBucket,
    enumName: 'WearableMetricBucket',
    description: 'The UX bucket that was read.',
  })
  bucket!: WearableMetricBucket;

  @ApiProperty({
    type: SamplesWindowDto,
    description: 'The echoed query window.',
  })
  window!: SamplesWindowDto;

  @ApiProperty({
    type: [SampleSeriesDto],
    description: 'One series per metric resolved for the bucket.',
  })
  series!: SampleSeriesDto[];

  @ApiProperty({
    type: SamplesFreshnessDto,
    description: 'Per-provider freshness for the bucket.',
  })
  freshness!: SamplesFreshnessDto;
}
