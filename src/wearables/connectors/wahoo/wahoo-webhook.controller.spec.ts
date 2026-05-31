import {
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { WearableProvider } from '@prisma/client';
import { PrismaService } from '../../../prisma.service';
import { IngestionService } from '../../ingestion/ingestion.service';
import { WahooConnector } from './wahoo.connector';
import { WahooWebhookController } from './wahoo-webhook.controller';

/**
 * PR-HK-2.h webhook controller tests — real-value behavioural assertions.
 *
 *  - bad signature        → 401 (no handling, no DB writes)
 *  - HMAC valid first      → records event, normalizes, ingests
 *  - replay (event seen)   → 200 no-op (no ingest, no create)
 *  - duplicate / P2002     → 200 no-op (idempotency)
 *  - missing raw body      → 400
 *  - malformed payload     → 400 (Zod strict)
 *
 * Collaborators are hand-mocked so no DB / network is touched.
 */

const VALID_BODY = {
  event_type: 'workout_summary',
  webhook_token: 'wt-abc',
  user: { id: 9988 },
  workout_summary: {
    distance_accum: '5000.0',
    heart_rate_avg: '130.0',
    workout: { id: 555, starts: '2026-05-30T13:00:00.000Z', minutes: 20 },
  },
};

function makeReq(body: unknown, hasRawBody = true): RawBodyRequest<Request> {
  const raw = Buffer.from(JSON.stringify(body));
  return {
    rawBody: hasRawBody ? raw : undefined,
    headers: { 'x-wahoo-signature': 'SIG', 'x-wahoo-timestamp': 'TS' },
  } as unknown as RawBodyRequest<Request>;
}

function setup(opts: {
  verify?: boolean;
  existingEvent?: boolean;
  connection?: unknown;
  createThrows?: { code?: string } | Error;
}) {
  const verify = opts.verify ?? true;

  const processedEvent = {
    findUnique: jest.fn(async () => (opts.existingEvent ? { type: 't' } : null)),
    create: jest.fn(async () => {
      if (opts.createThrows) throw opts.createThrows;
      return {};
    }),
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
    ingest: jest.fn(async () => ({ inserted: 3, skipped: 0 })),
  } as unknown as IngestionService;

  const connector = {
    verifyWebhook: jest.fn(() => verify),
    eventId: jest.fn(() => 'workout_summary:77:555:upd'),
    extractWorkoutRecords: jest.fn(() => [
      { provider: WearableProvider.WAHOO, payload: {} },
    ]),
    normalize: jest.fn(() => [
      {
        userId: 'u',
        connectionId: 'conn-1',
        provider: WearableProvider.WAHOO,
        metric: 'WORKOUT_DURATION_MIN',
        bucket: 'HEALTH_FITNESS',
        value: 20,
        unit: 'min',
        startAt: new Date(),
        endAt: new Date(),
      },
    ]),
  } as unknown as WahooConnector;

  const controller = new WahooWebhookController(prisma, ingestion, connector);
  return { controller, prisma, ingestion, connector, processedEvent };
}

describe('WahooWebhookController.handle', () => {
  it('throws 401 on an invalid signature and does not process', async () => {
    const { controller, ingestion, processedEvent } = setup({ verify: false });
    await expect(controller.handle(makeReq(VALID_BODY))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(ingestion.ingest).not.toHaveBeenCalled();
    expect(processedEvent.create).not.toHaveBeenCalled();
  });

  it('throws 400 when the raw body is missing', async () => {
    const { controller } = setup({});
    await expect(
      controller.handle(makeReq(VALID_BODY, false)),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws 400 on a malformed (strict-Zod-rejected) payload', async () => {
    const { controller, ingestion } = setup({});
    // Unknown top-level key violates .strict(); also event_type missing.
    await expect(
      controller.handle(makeReq({ bogus: true })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(ingestion.ingest).not.toHaveBeenCalled();
  });

  it('processes a valid first delivery: normalize → ingest → commit', async () => {
    const { controller, ingestion, processedEvent, connector } = setup({});
    const res = await controller.handle(makeReq(VALID_BODY));
    expect(res).toEqual({ ok: true });
    expect(connector.extractWorkoutRecords).toHaveBeenCalledTimes(1);
    expect(ingestion.ingest).toHaveBeenCalledTimes(1);
    // Commit AFTER ingest (audit pattern #1).
    expect(processedEvent.create).toHaveBeenCalledTimes(1);
    const createMock = processedEvent.create as jest.Mock;
    const arg = createMock.mock.calls[0][0] as {
      data: { provider: string; provider_event_id: string };
    };
    expect(arg.data.provider).toBe(WearableProvider.WAHOO);
    expect(arg.data.provider_event_id).toBe('workout_summary:77:555:upd');
  });

  it('is a 200 no-op on a duplicate (already-processed) event', async () => {
    const { controller, ingestion, processedEvent } = setup({
      existingEvent: true,
    });
    const res = await controller.handle(makeReq(VALID_BODY));
    expect(res).toEqual({ ok: true });
    expect(ingestion.ingest).not.toHaveBeenCalled();
    expect(processedEvent.create).not.toHaveBeenCalled();
  });

  it('absorbs a concurrent P2002 commit as a benign 200 no-op', async () => {
    const { controller } = setup({ createThrows: { code: 'P2002' } });
    const res = await controller.handle(makeReq(VALID_BODY));
    expect(res).toEqual({ ok: true });
  });

  it('skips ingest gracefully when no connection is found (still commits)', async () => {
    const { controller, ingestion, processedEvent } = setup({
      connection: null,
    });
    const res = await controller.handle(makeReq(VALID_BODY));
    expect(res).toEqual({ ok: true });
    expect(ingestion.ingest).not.toHaveBeenCalled();
    // No connection means nothing to ingest, but the event is still recorded.
    expect(processedEvent.create).toHaveBeenCalledTimes(1);
  });
});
