import { AnalyticsService } from '../../src/analytics/analytics.service';
import { PrismaService } from '../../src/prisma.service';
import { ScoutIngestService } from '../../src/scout/scout-ingest.service';
import { SCOUT_INGEST_EVENT, type ScoutIngestDto } from '../../src/scout/scout-ingest.dto';

/**
 * ScoutIngestService unit tests — idempotent persistence + provenance signal.
 *
 * Covers the happy path (all rows new), captured_at parsing of a validated
 * strict-ISO8601 value, the row-mapping contract fed to Prisma, verbatim
 * (non-sensitive) payload persistence, server-side denylist redaction, and the
 * PostHog batch event. Provenance (sourceId / sourcePlatform / capturedAt) is a
 * top-level makeEntity field validated by the DTO, so its presence is exercised
 * in the controller/DTO spec. Real idempotency-key semantics (R-IDEMP-1) are
 * asserted structurally in scout-ingest.idempotency.spec.ts.
 */

type CreateManyArgs = {
  data: Array<Record<string, unknown>>;
  skipDuplicates?: boolean;
};

type EntityPayload = ScoutIngestDto['entities'][number]['payload'];

function entity(
  sourceId: string,
  payload: EntityPayload = { plan: 'gold' },
  provenance: { sourcePlatform?: string; capturedAt?: string } = {},
): ScoutIngestDto['entities'][number] {
  return {
    sourceId,
    sourcePlatform: provenance.sourcePlatform ?? 'auto:coachrx.example.com',
    capturedAt: provenance.capturedAt ?? '2026-07-07T00:00:00.000Z',
    payload,
  };
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

  // NOTE: replay/dedup counting was previously asserted here against a mocked
  // createMany count — a tautology (the mock decided the count, so the test
  // only proved received - count arithmetic, not that the unique index dedups).
  // The real idempotency semantics of the (coach_id, intent_id, source_id) key
  // — including that a re-observation with a fresh capturedAt is a no-op replay
  // and a new intent_id inserts a fresh series (R-IDEMP-1) — are now enforced
  // structurally and asserted in scout-ingest.idempotency.spec.ts. The
  // received - count → deduped arithmetic is still covered by the happy-path
  // and PostHog-event cases in this file.

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

  it('parses a valid capturedAt into a Date', async () => {
    const { service, createMany } = build(1);
    await service.ingest('coach-1', makeDto());
    const row = dataOf(createMany)[0];
    expect(row.captured_at).toBeInstanceOf(Date);
    expect((row.captured_at as Date).toISOString()).toBe('2026-07-07T00:00:00.000Z');
  });

  it('persists the full payload verbatim, including extractor-specific fields', async () => {
    const { service, createMany } = build(1);
    const dto = makeDto({
      entities: [entity('s1', { extra: 'kept', plan: 'gold' })],
    });
    await service.ingest('coach-1', dto);
    expect(dataOf(createMany)[0].payload).toEqual({ extra: 'kept', plan: 'gold' });
  });

  it('strips denylisted secret keys from the payload before persistence', async () => {
    const { service, createMany } = build(1);
    const dto = makeDto({
      entities: [
        entity('s1', {
          name: 'Jane',
          password: 'hunter2',
          API_KEY: 'sk-live-123',
          nested: { authorization: 'Bearer x', keep: 'yes' },
          list: [{ token: 'abc', label: 'ok' }],
        }),
      ],
    });
    await service.ingest('coach-1', dto);
    expect(dataOf(createMany)[0].payload).toEqual({
      name: 'Jane',
      nested: { keep: 'yes' },
      list: [{ label: 'ok' }],
    });
  });

  it('does not derive provenance from payload keys (top-level makeEntity fields win)', async () => {
    const { service, createMany } = build(1);
    const dto = makeDto({
      entities: [
        entity('s1', { sourcePlatform: 'payload-decoy' }, { sourcePlatform: 'auto:real.com' }),
      ],
    });
    await service.ingest('coach-1', dto);
    const row = dataOf(createMany)[0];
    expect(row.source_platform).toBe('auto:real.com');
    expect(row.payload).toEqual({ sourcePlatform: 'payload-decoy' });
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
        entity('a', { plan: 'gold' }, { sourcePlatform: 'auto:x.com' }),
        entity('b', { plan: 'gold' }, { sourcePlatform: 'auto:y.com' }),
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
        entity('a', { plan: 'gold' }, { sourcePlatform: 'auto:mypthub.example' }),
        entity('b', { plan: 'gold' }, { sourcePlatform: 'auto:trainerize.example' }),
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
      entities: [entity('s1', { plan: 'gold' }, { capturedAt: '2026-07-07T05:00:00.000+05:00' })],
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

describe('ScoutIngestService payload redaction', () => {
  // Persist one entity and hand back the payload as it was written to the DB,
  // so each case can assert exactly which keys survived the denylist strip.
  async function persistedPayload(payload: EntityPayload): Promise<unknown> {
    const { service, createMany } = build(1);
    await service.ingest('coach-1', makeDto({ entities: [entity('s1', payload)] }));
    return dataOf(createMany)[0].payload;
  }

  it('strips every top-level denylisted key regardless of surrounding data', async () => {
    const stored = await persistedPayload({
      password: 'p',
      passwd: 'p',
      pwd: 'p',
      secret: 's',
      token: 't',
      authorization: 'a',
      auth: 'a',
      cookie: 'c',
      session: 's',
      api_key: 'k',
      apikey: 'k',
      access_token: 'a',
      refresh_token: 'r',
      bearer: 'b',
      ssn: '1',
      credit_card: '1',
      cardnumber: '1',
      cvv: '1',
      private_key: 'k',
      keep_me: 'yes',
    });
    expect(stored).toEqual({ keep_me: 'yes' });
  });

  it('matches denylisted keys case-insensitively', async () => {
    const stored = await persistedPayload({
      PassWord: 'x',
      API_KEY: 'x',
      Authorization: 'x',
      Name: 'kept',
    });
    expect(stored).toEqual({ Name: 'kept' });
  });

  it('strips denylisted keys nested inside objects', async () => {
    const stored = await persistedPayload({
      profile: { name: 'Jane', password: 'x', contact: { email: 'j@x.io', token: 'y' } },
    });
    expect(stored).toEqual({ profile: { name: 'Jane', contact: { email: 'j@x.io' } } });
  });

  it('strips denylisted keys inside objects nested in arrays', async () => {
    const stored = await persistedPayload({
      sessions: [
        { id: 1, token: 'a', note: 'ok' },
        { id: 2, secret: 'b', note: 'fine' },
      ],
    });
    expect(stored).toEqual({
      sessions: [
        { id: 1, note: 'ok' },
        { id: 2, note: 'fine' },
      ],
    });
  });

  it('preserves scalar array elements verbatim', async () => {
    const stored = await persistedPayload({ tags: ['a', 'b', 'c'], count: 3, active: true });
    expect(stored).toEqual({ tags: ['a', 'b', 'c'], count: 3, active: true });
  });

  it('preserves null and falsy non-sensitive values', async () => {
    const stored = await persistedPayload({ note: null, zero: 0, flag: false, empty: '' });
    expect(stored).toEqual({ note: null, zero: 0, flag: false, empty: '' });
  });

  it('leaves a payload with no sensitive keys byte-for-byte intact', async () => {
    const clean = { name: 'Jane', plan: 'gold', meta: { tier: 2, tags: ['vip'] } };
    expect(await persistedPayload(clean)).toEqual(clean);
  });

  it('does not treat a denylisted substring inside a longer key as sensitive', async () => {
    const stored = await persistedPayload({ token_count: 5, password_reset_at: '2026-07-07' });
    expect(stored).toEqual({ token_count: 5, password_reset_at: '2026-07-07' });
  });

  it('returns an empty object for an empty payload', async () => {
    expect(await persistedPayload({})).toEqual({});
  });

  it('strips denylisted keys at deep nesting levels', async () => {
    const stored = await persistedPayload({
      a: { b: { c: { keep: 'yes', secret: 'x', d: [{ token: 't', ok: 1 }] } } },
    });
    expect(stored).toEqual({ a: { b: { c: { keep: 'yes', d: [{ ok: 1 }] } } } });
  });
});

describe('ScoutIngestService prototype pollution defenses', () => {
  // Persist one entity and hand back the payload as it was written to the DB.
  async function persistedPayload(payload: EntityPayload): Promise<Record<string, unknown>> {
    const { service, createMany } = build(1);
    await service.ingest('coach-1', makeDto({ entities: [entity('s1', payload)] }));
    return dataOf(createMany)[0].payload as Record<string, unknown>;
  }

  afterEach(() => {
    // Belt-and-suspenders — if we somehow polluted Object.prototype, fail loudly.
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('drops __proto__ keys and does not pollute Object.prototype', async () => {
    // JSON.parse gives __proto__ an OWN enumerable property (unlike an object
    // literal, where __proto__ is the prototype setter), so it reaches redact.
    const payload = JSON.parse('{"__proto__": {"polluted": true}, "safe": 1}') as EntityPayload;
    const stored = await persistedPayload(payload);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(stored, '__proto__')).toBe(false);
    expect(stored.safe).toBe(1);
  });

  it('drops constructor and prototype keys', async () => {
    const stored = await persistedPayload({
      constructor: { evil: true },
      prototype: { evil: true },
      kept: 'ok',
    });
    expect(Object.prototype.hasOwnProperty.call(stored, 'constructor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(stored, 'prototype')).toBe(false);
    expect(stored.kept).toBe('ok');
  });

  it('drops __proto__ recursively inside nested payload', async () => {
    const payload = JSON.parse(
      '{"nested": {"__proto__": {"polluted": true}, "value": 42}}',
    ) as EntityPayload;
    const stored = await persistedPayload(payload);
    const nested = stored.nested as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(nested, '__proto__')).toBe(false);
    expect(nested.value).toBe(42);
  });
});
