import {
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { WearableProvider } from '@prisma/client';
import { PrismaService } from '../../../prisma.service';
import { IngestionService } from '../../ingestion/ingestion.service';
import { OuraConnector } from './oura.connector';
import { OuraWebhookController } from './oura-webhook.controller';

/**
 * PR-HK-2.k webhook controller tests — real-value behavioural assertions.
 *
 *  - bad signature           → 401 (no handling, no DB writes)
 *  - replay (event seen)     → 200 no-op (no fetch, no ingest)
 *  - first delivery          → records event, fetches changed record, ingests
 *  - missing raw body        → 400
 *  - malformed payload       → 400 (Zod)
 *
 * Collaborators are hand-mocked so no DB / network is touched.
 */

function makeReq(body: unknown, hasRawBody = true): RawBodyRequest<Request> {
  const raw = Buffer.from(JSON.stringify(body));
  return {
    rawBody: hasRawBody ? raw : undefined,
    headers: { 'x-oura-signature': 'SIG', 'x-oura-timestamp': 'TS' },
  } as unknown as RawBodyRequest<Request>;
}

const EVENT = {
  event_type: 'update',
  data_type: 'daily_sleep',
  object_id: 'sleep-9',
  event_time: '2026-05-31T08:00:00Z',
  user_id: 'oura-user-1',
};

function setup(opts: {
  verify?: boolean;
  existingEvent?: boolean;
  connection?: unknown;
}) {
  const verify = opts.verify ?? true;

  const processedEvent = {
    findUnique: jest.fn(async () => (opts.existingEvent ? { type: 't' } : null)),
    create: jest.fn(async () => ({})),
    update: jest.fn(async () => ({})),
  };
  const wearableConnection = {
    findFirst: jest.fn(async () =>
      'connection' in opts ? opts.connection : { id: 'conn-1', user_id: 'u' },
    ),
    update: jest.fn(async () => ({})),
  };
  const prisma = {
    wearableProcessedEvent: processedEvent,
    wearableConnection,
  } as unknown as PrismaService;

  const ingestion = {
    ingest: jest.fn(async () => ({ inserted: 1, skipped: 0 })),
  } as unknown as IngestionService;

  const connector = {
    verifyWebhook: jest.fn(() => verify),
    eventId: jest.fn(
      (e: typeof EVENT) =>
        `${e.data_type}:${e.object_id}:${e.event_type}:${e.event_time}`,
    ),
    fetchChangedRecord: jest.fn(async () => [
      { provider: WearableProvider.OURA, payload: {} },
    ]),
    normalize: jest.fn(() => [
      {
        userId: 'u',
        connectionId: 'conn-1',
        provider: WearableProvider.OURA,
        metric: 'STEPS',
        bucket: 'HEALTH_FITNESS',
        value: 100,
        unit: 'steps',
        startAt: new Date(),
        endAt: new Date(),
      },
    ]),
  } as unknown as OuraConnector;

  const controller = new OuraWebhookController(prisma, ingestion, connector);
  return { controller, processedEvent, wearableConnection, ingestion, connector };
}

describe('OuraWebhookController — signature gate', () => {
  it('rejects an invalid signature with 401 and never touches the DB', async () => {
    const { controller, processedEvent, ingestion } = setup({ verify: false });
    await expect(controller.handle(makeReq(EVENT))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(processedEvent.findUnique).not.toHaveBeenCalled();
    expect(ingestion.ingest).not.toHaveBeenCalled();
  });

  it('rejects a request without a raw body with 400', async () => {
    const { controller } = setup({});
    await expect(
      controller.handle(makeReq(EVENT, false)),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('OuraWebhookController — idempotency / replay', () => {
  it('returns 200 no-op for a previously-processed event (no fetch, no ingest)', async () => {
    const { controller, processedEvent, ingestion, connector } = setup({
      existingEvent: true,
    });
    const res = await controller.handle(makeReq(EVENT));
    expect(res).toEqual({ ok: true });
    expect(processedEvent.create).not.toHaveBeenCalled();
    expect(connector.fetchChangedRecord).not.toHaveBeenCalled();
    expect(ingestion.ingest).not.toHaveBeenCalled();
  });

  it('treats a concurrent unique-violation (P2002) on the post-ingest commit as a 200 no-op', async () => {
    // Two concurrent deliveries of the same event both fetch+ingest; the
    // loser's processed-event create hits the composite-PK unique violation.
    // The sample dedup_key UNIQUE constraint already prevented double-counting,
    // so we absorb P2002 as a benign no-op rather than a 500.
    const { controller, processedEvent, ingestion, connector } = setup({});
    processedEvent.create.mockRejectedValueOnce({ code: 'P2002' });
    const res = await controller.handle(makeReq(EVENT));
    expect(res).toEqual({ ok: true });
    // Fetch+ingest ran BEFORE the dedup row write (ordering invariant).
    expect(connector.fetchChangedRecord).toHaveBeenCalledTimes(1);
    expect(ingestion.ingest).toHaveBeenCalledTimes(1);
  });
});

describe('OuraWebhookController — first delivery', () => {
  it('records the event, fetches the changed record, and ingests normalized samples', async () => {
    const { controller, processedEvent, connector, ingestion, wearableConnection } =
      setup({});
    const res = await controller.handle(makeReq(EVENT));

    expect(res).toEqual({ ok: true });
    // R2 ordering: the dedup row is written ONLY AFTER a successful ingest,
    // with handler_completed_at set in the same write (no separate update).
    expect(processedEvent.create).toHaveBeenCalledWith({
      data: {
        provider: WearableProvider.OURA,
        provider_event_id: 'daily_sleep:sleep-9:update:2026-05-31T08:00:00Z',
        type: 'daily_sleep.update',
        handler_completed_at: expect.any(Date),
      },
    });
    expect(connector.fetchChangedRecord).toHaveBeenCalledTimes(1);
    expect(ingestion.ingest).toHaveBeenCalledTimes(1);
    // Ordering invariant: ingest happened BEFORE the dedup row was committed.
    const ingestOrder = (ingestion.ingest as jest.Mock).mock.invocationCallOrder[0];
    const createOrder = (processedEvent.create as jest.Mock).mock.invocationCallOrder[0];
    expect(ingestOrder).toBeLessThan(createOrder);
    // No separate completion update is used any more.
    expect(processedEvent.update).not.toHaveBeenCalled();
    expect(wearableConnection.findFirst).toHaveBeenCalledWith({
      where: {
        provider: WearableProvider.OURA,
        external_account_id: 'oura-user-1',
        disconnected_at: null,
      },
    });
  });

  it('does not fetch/ingest for a delete event but still records it', async () => {
    const { controller, connector, ingestion, processedEvent } = setup({});
    await controller.handle(makeReq({ ...EVENT, event_type: 'delete' }));
    expect(connector.fetchChangedRecord).not.toHaveBeenCalled();
    expect(ingestion.ingest).not.toHaveBeenCalled();
    expect(processedEvent.create).toHaveBeenCalledWith({
      data: {
        provider: WearableProvider.OURA,
        provider_event_id: 'daily_sleep:sleep-9:delete:2026-05-31T08:00:00Z',
        type: 'daily_sleep.delete',
        handler_completed_at: expect.any(Date),
      },
    });
  });

  it('does NOT write a processed-event row when fetch/ingest fails, then ingests + records on retry (Finding 1)', async () => {
    // First delivery: transient fetch failure. Assert NO processed-event row
    // is written (so the event is NOT marked handled) and the failure rethrows.
    const first = setup({});
    (first.connector.fetchChangedRecord as jest.Mock).mockRejectedValueOnce(
      new Error('transient upstream 503'),
    );
    await expect(first.controller.handle(makeReq(EVENT))).rejects.toThrow(
      'transient upstream 503',
    );
    expect(first.ingestion.ingest).not.toHaveBeenCalled();
    // CRITICAL: no dedup row exists after the failed attempt — data was NOT
    // silently dropped, and a retry will reprocess.
    expect(first.processedEvent.create).not.toHaveBeenCalled();

    // Retry (Oura redelivers the SAME event): findUnique still returns null
    // because no row was written, so we reprocess. This time fetch+ingest
    // succeed and the dedup row is finally committed.
    const retry = setup({});
    const res = await retry.controller.handle(makeReq(EVENT));
    expect(res).toEqual({ ok: true });
    expect(retry.connector.fetchChangedRecord).toHaveBeenCalledTimes(1);
    expect(retry.ingestion.ingest).toHaveBeenCalledTimes(1);
    expect(retry.processedEvent.create).toHaveBeenCalledTimes(1);
  });

  it('marks the connection in error and rethrows when ingest fails', async () => {
    const { controller, connector, wearableConnection, processedEvent } = setup({});
    (connector.fetchChangedRecord as jest.Mock).mockRejectedValueOnce(
      new Error('upstream 500'),
    );
    await expect(controller.handle(makeReq(EVENT))).rejects.toThrow(
      'upstream 500',
    );
    expect(wearableConnection.update).toHaveBeenCalledWith({
      where: { id: 'conn-1' },
      data: { status: 'error', last_error: 'upstream 500' },
    });
    // And the dedup row is NOT written on failure (event remains reprocessable).
    expect(processedEvent.create).not.toHaveBeenCalled();
  });

  it('no-ops gracefully when no matching connection exists', async () => {
    const { controller, ingestion } = setup({ connection: null });
    const res = await controller.handle(makeReq(EVENT));
    expect(res).toEqual({ ok: true });
    expect(ingestion.ingest).not.toHaveBeenCalled();
  });
});

describe('OuraWebhookController — payload validation', () => {
  it('rejects a payload missing required fields with 400', async () => {
    const { controller } = setup({});
    await expect(
      controller.handle(makeReq({ event_type: 'update' })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-JSON body with 400', async () => {
    const { controller } = setup({});
    const req = {
      rawBody: Buffer.from('not json'),
      headers: {},
    } as unknown as RawBodyRequest<Request>;
    await expect(controller.handle(req)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects an invalid event_type enum value with 400', async () => {
    const { controller } = setup({});
    await expect(
      controller.handle(makeReq({ ...EVENT, event_type: 'frobnicate' })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('OuraWebhookController — verification handshake', () => {
  beforeEach(() => {
    process.env.OURA_VERIFICATION_TOKEN = 'verify-token-1';
  });

  it('echoes the challenge for a valid verification token', () => {
    const { controller } = setup({});
    expect(controller.verify('verify-token-1', 'rand-123')).toEqual({
      challenge: 'rand-123',
    });
  });

  it('rejects a verification with a wrong token', () => {
    const { controller } = setup({});
    expect(() => controller.verify('wrong', 'rand')).toThrow(
      UnauthorizedException,
    );
  });
});
