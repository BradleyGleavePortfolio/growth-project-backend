import { BadRequestException } from '@nestjs/common';
import { AnalyticsService } from '../../src/analytics/analytics.service';
import { PrismaService } from '../../src/prisma.service';
import { ScoutIngestService } from '../../src/scout/scout-ingest.service';
import { SCOUT_INGEST_EVENT, type ScoutIngestDto } from '../../src/scout/scout-ingest.dto';

/**
 * ScoutIngestService unit tests — idempotent persistence + provenance signal.
 *
 * Covers the happy path (all rows new), full replay (all deduped), partial
 * replay, provenance validation (missing sourcePlatform / capturedAt),
 * captured_at parsing (valid + malformed), the row-mapping contract fed to
 * Prisma, verbatim payload persistence, and the PostHog batch event.
 */

type CreateManyArgs = {
  data: Array<Record<string, unknown>>;
  skipDuplicates?: boolean;
};

type EntityPayload = ScoutIngestDto['entities'][number]['payload'];

function entity(
  source_id: string,
  payload: EntityPayload = {
    sourcePlatform: 'auto:coachrx.example.com',
    capturedAt: '2026-07-07T00:00:00.000Z',
  },
): ScoutIngestDto['entities'][number] {
  return { source_id, payload };
}

function makeDto(overrides: Partial<ScoutIngestDto> = {}): ScoutIngestDto {
  return {
    intent_id: 'intent-1',
    entity_type: 'lead',
    entities: [entity('s1')],
    ...overrides,
  };
}

function makePrisma(createMany: jest.Mock): PrismaService {
  const prisma = Object.create(PrismaService.prototype) as PrismaService;
  return Object.assign(prisma, { scoutIngestEntity: { createMany } });
}

function makeAnalytics(capture: jest.Mock): AnalyticsService {
  const analytics = Object.create(AnalyticsService.prototype) as AnalyticsService;
  return Object.assign(analytics, { capture });
}

function build(insertedCount: number) {
  const createMany = jest.fn(async (_args: CreateManyArgs) => ({ count: insertedCount }));
  const capture = jest.fn();
  const service = new ScoutIngestService(makePrisma(createMany), makeAnalytics(capture));
  return { service, createMany, capture };
}

function dataOf(createMany: jest.Mock): CreateManyArgs['data'] {
  return (createMany.mock.calls[0][0] as CreateManyArgs).data;
}

describe('ScoutIngestService', () => {
  it('persists every entity and reports zero deduped when all rows are new', async () => {
    const { service, createMany } = build(2);
    const dto = makeDto({ entities: [entity('s1'), entity('s2')] });

    const result = await service.ingest('coach-1', dto);

    expect(result).toEqual({ received: 2, deduped: 0 });
    expect(createMany).toHaveBeenCalledTimes(1);
    const args = createMany.mock.calls[0][0] as CreateManyArgs;
    expect(args.skipDuplicates).toBe(true);
    expect(args.data).toHaveLength(2);
  });

  it('reports all entities as deduped on a full replay (zero inserts)', async () => {
    const { service } = build(0);
    const result = await service.ingest('coach-1', makeDto());
    expect(result).toEqual({ received: 1, deduped: 1 });
  });

  it('reports partial dedup when only some rows are new', async () => {
    const { service } = build(1);
    const dto = makeDto({ entities: [entity('s1'), entity('s2'), entity('s3')] });
    const result = await service.ingest('coach-1', dto);
    expect(result).toEqual({ received: 3, deduped: 2 });
  });

  it('derives coach_id from the argument, never from the body', async () => {
    const { service, createMany } = build(1);
    await service.ingest('coach-from-token', makeDto());
    const row = dataOf(createMany)[0];
    expect(row.coach_id).toBe('coach-from-token');
    expect(row.intent_id).toBe('intent-1');
    expect(row.entity_type).toBe('lead');
    expect(row.source_id).toBe('s1');
    expect(row.source_platform).toBe('auto:coachrx.example.com');
  });

  it('rejects an entity whose payload is missing sourcePlatform', async () => {
    const { service, createMany } = build(1);
    const dto = makeDto({ entities: [entity('s1', { capturedAt: '2026-07-07T00:00:00.000Z' })] });
    await expect(service.ingest('coach-1', dto)).rejects.toBeInstanceOf(BadRequestException);
    expect(createMany).not.toHaveBeenCalled();
  });

  it('rejects an entity whose payload is missing capturedAt', async () => {
    const { service, createMany } = build(1);
    const dto = makeDto({ entities: [entity('s1', { sourcePlatform: 'auto:a.com' })] });
    await expect(service.ingest('coach-1', dto)).rejects.toBeInstanceOf(BadRequestException);
    expect(createMany).not.toHaveBeenCalled();
  });

  it('parses a valid capturedAt into a Date', async () => {
    const { service, createMany } = build(1);
    await service.ingest('coach-1', makeDto());
    const row = dataOf(createMany)[0];
    expect(row.captured_at).toBeInstanceOf(Date);
    expect((row.captured_at as Date).toISOString()).toBe('2026-07-07T00:00:00.000Z');
  });

  it('degrades a malformed capturedAt to null rather than failing the batch', async () => {
    const { service, createMany } = build(1);
    const dto = makeDto({
      entities: [entity('s1', { sourcePlatform: 'auto:a.com', capturedAt: 'not-a-date' })],
    });
    await service.ingest('coach-1', dto);
    expect(dataOf(createMany)[0].captured_at).toBeNull();
  });

  it('persists the full payload verbatim, including extractor-specific fields', async () => {
    const { service, createMany } = build(1);
    const dto = makeDto({
      entities: [
        entity('s1', {
          sourcePlatform: 'auto:a.com',
          capturedAt: '2026-07-07T00:00:00.000Z',
          extra: 'kept',
        }),
      ],
    });
    await service.ingest('coach-1', dto);
    expect(dataOf(createMany)[0].payload).toMatchObject({
      extra: 'kept',
      sourcePlatform: 'auto:a.com',
    });
  });

  it('emits one scout.ingest.received event per batch with the counts', async () => {
    const { service, capture } = build(1);
    await service.ingest('coach-1', makeDto());
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith('coach-1', SCOUT_INGEST_EVENT, {
      intent_id: 'intent-1',
      entity_type: 'lead',
      received: 1,
      deduped: 0,
    });
  });

  it('uses the stable event constant name', () => {
    expect(SCOUT_INGEST_EVENT).toBe('scout.ingest.received');
  });

  it('always requests ON CONFLICT DO NOTHING semantics via skipDuplicates', async () => {
    const { service, createMany } = build(1);
    await service.ingest('coach-1', makeDto());
    expect((createMany.mock.calls[0][0] as CreateManyArgs).skipDuplicates).toBe(true);
  });

  it('stamps intent_id and entity_type onto every row in a multi-entity batch', async () => {
    const { service, createMany } = build(2);
    const dto = makeDto({
      intent_id: 'crawl-42',
      entity_type: 'contact',
      entities: [
        entity('a', { sourcePlatform: 'auto:x.com', capturedAt: '2026-07-07T00:00:00.000Z' }),
        entity('b', { sourcePlatform: 'auto:y.com', capturedAt: '2026-07-07T00:00:00.000Z' }),
      ],
    });
    await service.ingest('coach-7', dto);
    const rows = dataOf(createMany);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.coach_id).toBe('coach-7');
      expect(row.intent_id).toBe('crawl-42');
      expect(row.entity_type).toBe('contact');
    }
    expect(rows.map((r) => r.source_id)).toEqual(['a', 'b']);
    expect(rows.map((r) => r.source_platform)).toEqual(['auto:x.com', 'auto:y.com']);
  });

  it('preserves the per-entity source_platform rather than collapsing to one', async () => {
    const { service, createMany } = build(2);
    const dto = makeDto({
      entities: [
        entity('a', {
          sourcePlatform: 'auto:mypthub.example',
          capturedAt: '2026-07-07T00:00:00.000Z',
        }),
        entity('b', {
          sourcePlatform: 'auto:trainerize.example',
          capturedAt: '2026-07-07T00:00:00.000Z',
        }),
      ],
    });
    await service.ingest('coach-1', dto);
    const rows = dataOf(createMany);
    expect(rows[0].source_platform).toBe('auto:mypthub.example');
    expect(rows[1].source_platform).toBe('auto:trainerize.example');
  });

  it('parses a capturedAt carrying a timezone offset to the correct instant', async () => {
    const { service, createMany } = build(1);
    const dto = makeDto({
      entities: [
        entity('s1', { sourcePlatform: 'auto:a.com', capturedAt: '2026-07-07T05:00:00.000+05:00' }),
      ],
    });
    await service.ingest('coach-1', dto);
    expect((dataOf(createMany)[0].captured_at as Date).toISOString()).toBe(
      '2026-07-07T00:00:00.000Z',
    );
  });

  it('reflects the deduped count in the emitted event on a full replay', async () => {
    const { service, capture } = build(0);
    await service.ingest('coach-1', makeDto());
    expect(capture).toHaveBeenCalledWith('coach-1', SCOUT_INGEST_EVENT, {
      intent_id: 'intent-1',
      entity_type: 'lead',
      received: 1,
      deduped: 1,
    });
  });

  it('does not throw when the batch has a large fan-out', async () => {
    const entities = Array.from({ length: 250 }, (_, i) => entity(`s${i}`));
    const { service, createMany } = build(250);
    const result = await service.ingest('coach-1', makeDto({ entities }));
    expect(result).toEqual({ received: 250, deduped: 0 });
    expect(dataOf(createMany)).toHaveLength(250);
  });
});
