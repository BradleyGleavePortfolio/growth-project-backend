import {
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { WearableProvider } from '@prisma/client';
import { PrismaService } from '../../../prisma.service';
import { IngestionService } from '../../ingestion/ingestion.service';
import { PolarConnector } from './polar.connector';
import { PolarWebhookController } from './polar-webhook.controller';

/**
 * PR-HK-2.g webhook controller tests — real-value behavioural assertions.
 *
 *  - bad signature           → 401 (no handling, no DB writes)
 *  - missing raw body        → 400
 *  - malformed payload       → 400 (Zod)
 *  - PING                    → 200, no fetch, no dedup row
 *  - replay (event seen)     → 200 no-op (no fetch, no ingest)
 *  - first delivery          → fetches changed record, ingests, THEN records
 *  - concurrent P2002 commit → 200 no-op (fetch+ingest already ran)
 *  - fetch/ingest failure    → no dedup row, connection marked error, rethrows
 *
 * Collaborators are hand-mocked so no DB / network is touched.
 */

function makeReq(body: unknown, hasRawBody = true): RawBodyRequest<Request> {
  const raw = Buffer.from(JSON.stringify(body));
  return {
    rawBody: hasRawBody ? raw : undefined,
    headers: { 'polar-webhook-signature': 'SIG' },
  } as unknown as RawBodyRequest<Request>;
}

const EVENT = {
  event: 'EXERCISE',
  user_id: 475,
  entity_id: 'aQlC83',
  timestamp: '2026-05-31T08:00:00Z',
  url: 'https://www.polaraccesslink.com/v3/exercises/aQlC83',
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
        `${e.event}:${e.user_id}:${e.entity_id ?? ''}:${e.timestamp}`,
    ),
    fetchChangedRecord: jest.fn(async () => [
      { provider: WearableProvider.POLAR, payload: {} },
    ]),
    normalize: jest.fn(() => [
      {
        userId: 'u',
        connectionId: 'conn-1',
        provider: WearableProvider.POLAR,
        metric: 'WORKOUT_DURATION_MIN',
        bucket: 'HEALTH_FITNESS',
        value: 90,
        unit: 'min',
        startAt: new Date(),
        endAt: new Date(),
      },
    ]),
  } as unknown as PolarConnector;

  const controller = new PolarWebhookController(prisma, ingestion, connector);
  return { controller, processedEvent, wearableConnection, ingestion, connector };
}

describe('PolarWebhookController — signature gate', () => {
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

describe('PolarWebhookController — payload validation', () => {
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

  it('rejects a non-PING event missing user_id with 400 (Zod superRefine)', async () => {
    const { controller } = setup({});
    await expect(
      controller.handle(
        makeReq({
          event: 'EXERCISE',
          entity_id: 'x',
          timestamp: '2026-05-31T08:00:00Z',
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-PING event missing entity_id AND date with 400', async () => {
    const { controller } = setup({});
    await expect(
      controller.handle(
        makeReq({
          event: 'SLEEP',
          user_id: 475,
          timestamp: '2026-05-31T08:00:00Z',
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('PolarWebhookController — PING', () => {
  it('acknowledges a PING with 200 and never fetches or records', async () => {
    const { controller, connector, ingestion, processedEvent } = setup({});
    const res = await controller.handle(
      makeReq({ event: 'PING', timestamp: '2026-05-31T08:00:00Z' }),
    );
    expect(res).toEqual({ ok: true });
    expect(processedEvent.findUnique).not.toHaveBeenCalled();
    expect(connector.fetchChangedRecord).not.toHaveBeenCalled();
    expect(ingestion.ingest).not.toHaveBeenCalled();
  });
});

describe('PolarWebhookController — idempotency / replay', () => {
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
    const { controller, processedEvent, ingestion, connector } = setup({});
    processedEvent.create.mockRejectedValueOnce({ code: 'P2002' });
    const res = await controller.handle(makeReq(EVENT));
    expect(res).toEqual({ ok: true });
    // Fetch+ingest ran BEFORE the dedup row write (ordering invariant).
    expect(connector.fetchChangedRecord).toHaveBeenCalledTimes(1);
    expect(ingestion.ingest).toHaveBeenCalledTimes(1);
  });
});

describe('PolarWebhookController — first delivery', () => {
  it('fetches the changed record, ingests, THEN records the dedup row (ordering)', async () => {
    const { controller, processedEvent, connector, ingestion, wearableConnection } =
      setup({});
    const res = await controller.handle(makeReq(EVENT));

    expect(res).toEqual({ ok: true });
    expect(processedEvent.create).toHaveBeenCalledWith({
      data: {
        provider: WearableProvider.POLAR,
        provider_event_id: 'EXERCISE:475:aQlC83:2026-05-31T08:00:00Z',
        type: 'EXERCISE',
        handler_completed_at: expect.any(Date),
      },
    });
    expect(connector.fetchChangedRecord).toHaveBeenCalledTimes(1);
    expect(ingestion.ingest).toHaveBeenCalledTimes(1);
    // Ordering invariant: ingest happened BEFORE the dedup row was committed.
    const ingestOrder = (ingestion.ingest as jest.Mock).mock
      .invocationCallOrder[0];
    const createOrder = (processedEvent.create as jest.Mock).mock
      .invocationCallOrder[0];
    expect(ingestOrder).toBeLessThan(createOrder);
    expect(wearableConnection.findFirst).toHaveBeenCalledWith({
      where: {
        provider: WearableProvider.POLAR,
        external_account_id: '475',
        disconnected_at: null,
      },
    });
  });

  it('does NOT write a dedup row when fetch/ingest fails, marks connection error, rethrows', async () => {
    const { controller, connector, wearableConnection, ingestion, processedEvent } =
      setup({});
    (connector.fetchChangedRecord as jest.Mock).mockRejectedValueOnce(
      new Error('transient upstream 503'),
    );
    await expect(controller.handle(makeReq(EVENT))).rejects.toThrow(
      'transient upstream 503',
    );
    expect(ingestion.ingest).not.toHaveBeenCalled();
    expect(processedEvent.create).not.toHaveBeenCalled();
    expect(wearableConnection.update).toHaveBeenCalledTimes(1);
    const arg = (wearableConnection.update as jest.Mock).mock.calls[0][0];
    expect(arg.where).toEqual({ id: 'conn-1' });
    expect(arg.data.status).toBe('error');
    expect(arg.data.last_error).toContain('transient upstream 503');
  });

  it('no-ops gracefully when no matching connection exists but still records the event', async () => {
    const { controller, ingestion, connector, processedEvent } = setup({
      connection: null,
    });
    const res = await controller.handle(makeReq(EVENT));
    expect(res).toEqual({ ok: true });
    expect(connector.fetchChangedRecord).not.toHaveBeenCalled();
    expect(ingestion.ingest).not.toHaveBeenCalled();
    // The event is still recorded so a redelivery is a fast no-op.
    expect(processedEvent.create).toHaveBeenCalledTimes(1);
  });
});
