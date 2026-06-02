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
 *  - unknown top-level key    → 400 (strict schema, no passthrough)
 *  - unknown event value      → 400 (event enum, fail-closed on drift)
 *  - PING                    → 200, no fetch, no reservation
 *  - replay (event reserved) → 200 no-op (no fetch, no ingest)
 *  - first delivery          → RESERVE first, then fetch+ingest, THEN complete
 *  - concurrent deliveries   → only ONE reserves+processes; the loser no-ops
 *  - fetch/ingest failure    → reservation released, connection marked error,
 *                              rethrows (no silent swallow, no stuck barrier)
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
  /** When true, the reservation insert is a duplicate (count===0 → replay). */
  alreadyReserved?: boolean;
  connection?: unknown;
}) {
  const verify = opts.verify ?? true;

  const processedEvent = {
    // Reservation-first: createMany returns count===1 when WE win the insert,
    // count===0 when a prior/concurrent delivery already holds the row.
    createMany: jest.fn(async () => ({ count: opts.alreadyReserved ? 0 : 1 })),
    updateMany: jest.fn(async () => ({ count: 1 })),
    deleteMany: jest.fn(async () => ({ count: 1 })),
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
    expect(processedEvent.createMany).not.toHaveBeenCalled();
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

  it('rejects an unknown top-level field with 400 (strict — no passthrough)', async () => {
    const { controller, processedEvent } = setup({});
    await expect(
      controller.handle(
        makeReq({
          ...EVENT,
          // Drifted/extra field that .strict() must reject rather than ignore.
          unexpected_field: 'attacker-controlled',
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(processedEvent.createMany).not.toHaveBeenCalled();
  });

  it('rejects an unknown event type with 400 (event enum, fail-closed on drift)', async () => {
    const { controller, processedEvent } = setup({});
    await expect(
      controller.handle(
        makeReq({
          event: 'CONTINUOUS_HEART_RATE',
          user_id: 475,
          date: '2026-05-31',
          timestamp: '2026-05-31T08:00:00Z',
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(processedEvent.createMany).not.toHaveBeenCalled();
  });

  it('accepts each supported non-PING event type (EXERCISE/SLEEP/NIGHTLY_RECHARGE)', async () => {
    for (const event of ['SLEEP', 'NIGHTLY_RECHARGE'] as const) {
      const { controller } = setup({});
      const res = await controller.handle(
        makeReq({
          event,
          user_id: 475,
          date: '2026-05-31',
          timestamp: '2026-05-31T08:00:00Z',
        }),
      );
      expect(res).toEqual({ ok: true });
    }
  });
});

describe('PolarWebhookController — PING', () => {
  it('acknowledges a PING with 200 and never reserves, fetches, or ingests', async () => {
    const { controller, connector, ingestion, processedEvent } = setup({});
    const res = await controller.handle(
      makeReq({ event: 'PING', timestamp: '2026-05-31T08:00:00Z' }),
    );
    expect(res).toEqual({ ok: true });
    expect(processedEvent.createMany).not.toHaveBeenCalled();
    expect(connector.fetchChangedRecord).not.toHaveBeenCalled();
    expect(ingestion.ingest).not.toHaveBeenCalled();
  });
});

describe('PolarWebhookController — idempotency / replay', () => {
  it('returns 200 no-op when the event is already reserved (no fetch, no ingest)', async () => {
    const { controller, processedEvent, ingestion, connector } = setup({
      alreadyReserved: true,
    });
    const res = await controller.handle(makeReq(EVENT));
    expect(res).toEqual({ ok: true });
    // Reservation attempted, lost the race → NO downstream work at all.
    expect(processedEvent.createMany).toHaveBeenCalledTimes(1);
    expect(processedEvent.updateMany).not.toHaveBeenCalled();
    expect(connector.fetchChangedRecord).not.toHaveBeenCalled();
    expect(ingestion.ingest).not.toHaveBeenCalled();
  });

  it('reserves BEFORE fetch/ingest (reservation-first barrier)', async () => {
    const { controller, processedEvent, connector, ingestion } = setup({});
    await controller.handle(makeReq(EVENT));
    const reserveOrder = (processedEvent.createMany as jest.Mock).mock
      .invocationCallOrder[0];
    const fetchOrder = (connector.fetchChangedRecord as jest.Mock).mock
      .invocationCallOrder[0];
    const ingestOrder = (ingestion.ingest as jest.Mock).mock
      .invocationCallOrder[0];
    // The reservation insert MUST happen before any expensive work.
    expect(reserveOrder).toBeLessThan(fetchOrder);
    expect(reserveOrder).toBeLessThan(ingestOrder);
  });

  it('two concurrent deliveries of the same event: only ONE fetches+ingests', async () => {
    // Shared mock prisma where the FIRST createMany wins (count===1) and the
    // SECOND sees the row already present (count===0) — exactly the
    // INSERT ... ON CONFLICT DO NOTHING semantics of skipDuplicates.
    let inserted = false;
    const processedEvent = {
      createMany: jest.fn(async () => {
        if (inserted) return { count: 0 };
        inserted = true;
        return { count: 1 };
      }),
      updateMany: jest.fn(async () => ({ count: 1 })),
      deleteMany: jest.fn(async () => ({ count: 1 })),
    };
    const wearableConnection = {
      findFirst: jest.fn(async () => ({ id: 'conn-1', user_id: 'u' })),
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
      verifyWebhook: jest.fn(() => true),
      eventId: jest.fn(() => 'EXERCISE:475:aQlC83:2026-05-31T08:00:00Z'),
      fetchChangedRecord: jest.fn(async () => [
        { provider: WearableProvider.POLAR, payload: {} },
      ]),
      normalize: jest.fn(() => []),
    } as unknown as PolarConnector;
    const controller = new PolarWebhookController(prisma, ingestion, connector);

    const [a, b] = await Promise.all([
      controller.handle(makeReq(EVENT)),
      controller.handle(makeReq(EVENT)),
    ]);

    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    // Both attempted to reserve, but only the winner did the expensive work.
    expect(processedEvent.createMany).toHaveBeenCalledTimes(2);
    expect(connector.fetchChangedRecord).toHaveBeenCalledTimes(1);
    expect(processedEvent.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe('PolarWebhookController — first delivery', () => {
  it('reserves, fetches the changed record, ingests, THEN stamps completion', async () => {
    const { controller, processedEvent, connector, ingestion, wearableConnection } =
      setup({});
    const res = await controller.handle(makeReq(EVENT));

    expect(res).toEqual({ ok: true });
    expect(processedEvent.createMany).toHaveBeenCalledWith({
      data: [
        {
          provider: WearableProvider.POLAR,
          provider_event_id: 'EXERCISE:475:aQlC83:2026-05-31T08:00:00Z',
          type: 'EXERCISE',
        },
      ],
      skipDuplicates: true,
    });
    expect(connector.fetchChangedRecord).toHaveBeenCalledTimes(1);
    expect(ingestion.ingest).toHaveBeenCalledTimes(1);
    // Completion is stamped only AFTER a successful ingest.
    expect(processedEvent.updateMany).toHaveBeenCalledWith({
      where: {
        provider: WearableProvider.POLAR,
        provider_event_id: 'EXERCISE:475:aQlC83:2026-05-31T08:00:00Z',
        handler_completed_at: null,
      },
      data: { handler_completed_at: expect.any(Date) },
    });
    const ingestOrder = (ingestion.ingest as jest.Mock).mock
      .invocationCallOrder[0];
    const completeOrder = (processedEvent.updateMany as jest.Mock).mock
      .invocationCallOrder[0];
    expect(ingestOrder).toBeLessThan(completeOrder);
    expect(wearableConnection.findFirst).toHaveBeenCalledWith({
      where: {
        provider: WearableProvider.POLAR,
        external_account_id: '475',
        disconnected_at: null,
      },
    });
  });

  it('RELEASES the reservation when fetch/ingest fails, marks connection error, rethrows', async () => {
    const { controller, connector, wearableConnection, ingestion, processedEvent } =
      setup({});
    (connector.fetchChangedRecord as jest.Mock).mockRejectedValueOnce(
      new Error('transient upstream 503'),
    );
    await expect(controller.handle(makeReq(EVENT))).rejects.toThrow(
      'transient upstream 503',
    );
    expect(ingestion.ingest).not.toHaveBeenCalled();
    // Reservation was released so the redelivery can reprocess (no stuck row).
    expect(processedEvent.deleteMany).toHaveBeenCalledWith({
      where: {
        provider: WearableProvider.POLAR,
        provider_event_id: 'EXERCISE:475:aQlC83:2026-05-31T08:00:00Z',
        handler_completed_at: null,
      },
    });
    // Completion was NEVER stamped.
    expect(processedEvent.updateMany).not.toHaveBeenCalled();
    expect(wearableConnection.update).toHaveBeenCalledTimes(1);
    const arg = (wearableConnection.update as jest.Mock).mock.calls[0][0];
    expect(arg.where).toEqual({ id: 'conn-1' });
    expect(arg.data.status).toBe('error');
    expect(arg.data.last_error).toContain('transient upstream 503');
  });

  it('no-ops gracefully when no matching connection exists but still completes the reservation', async () => {
    const { controller, ingestion, connector, processedEvent } = setup({
      connection: null,
    });
    const res = await controller.handle(makeReq(EVENT));
    expect(res).toEqual({ ok: true });
    expect(connector.fetchChangedRecord).not.toHaveBeenCalled();
    expect(ingestion.ingest).not.toHaveBeenCalled();
    // The event is reserved AND marked complete so a redelivery is a fast no-op.
    expect(processedEvent.createMany).toHaveBeenCalledTimes(1);
    expect(processedEvent.updateMany).toHaveBeenCalledTimes(1);
    expect(processedEvent.deleteMany).not.toHaveBeenCalled();
  });
});
