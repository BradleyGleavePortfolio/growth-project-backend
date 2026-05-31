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

interface Mocks {
  prisma: jest.Mocked<
    Pick<
      PrismaService['wearableProcessedEvent'],
      'findUnique' | 'create' | 'update'
    >
  > & { conn: jest.Mock };
}

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

  it('treats a concurrent unique-violation (P2002) on create as a 200 no-op', async () => {
    const { controller, processedEvent, ingestion } = setup({});
    processedEvent.create.mockRejectedValueOnce({ code: 'P2002' });
    const res = await controller.handle(makeReq(EVENT));
    expect(res).toEqual({ ok: true });
    expect(ingestion.ingest).not.toHaveBeenCalled();
  });
});

describe('OuraWebhookController — first delivery', () => {
  it('records the event, fetches the changed record, and ingests normalized samples', async () => {
    const { controller, processedEvent, connector, ingestion, wearableConnection } =
      setup({});
    const res = await controller.handle(makeReq(EVENT));

    expect(res).toEqual({ ok: true });
    expect(processedEvent.create).toHaveBeenCalledWith({
      data: {
        provider: WearableProvider.OURA,
        provider_event_id: 'daily_sleep:sleep-9:update:2026-05-31T08:00:00Z',
        type: 'daily_sleep.update',
      },
    });
    expect(connector.fetchChangedRecord).toHaveBeenCalledTimes(1);
    expect(ingestion.ingest).toHaveBeenCalledTimes(1);
    // Handler completion is marked.
    expect(processedEvent.update).toHaveBeenCalled();
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
    expect(processedEvent.create).toHaveBeenCalled();
  });

  it('marks the connection in error and rethrows when ingest fails', async () => {
    const { controller, connector, wearableConnection } = setup({});
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
