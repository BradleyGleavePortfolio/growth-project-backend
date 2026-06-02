import {
  BadRequestException,
  HttpStatus,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request, Response } from 'express';
import { WearableProvider } from '@prisma/client';
import { PrismaService } from '../../../prisma.service';
import { IngestionService } from '../../ingestion/ingestion.service';
import { FitbitConnector } from './fitbit.connector';
import { FitbitWebhookController } from './fitbit-webhook.controller';

/**
 * PR-HK-2.e webhook controller tests — real-value behavioural assertions.
 *
 *  - bad signature             → 401 (no handling, no DB writes)
 *  - missing raw body          → 400
 *  - malformed payload         → 400 (Zod)
 *  - replay (event seen)       → no-op (no fetch, no ingest)
 *  - first delivery            → records event, fetches, ingests (ingest BEFORE commit)
 *  - concurrent P2002 commit   → benign no-op
 *  - fetch/ingest failure      → connection marked error, rethrow, NO dedup row
 *  - no matching connection    → no-op (still records)
 *  - userRevokedAccess         → no fetch, still records
 *  - GET verification handshake → 204 on match, 404 otherwise (fail-closed)
 *
 * Collaborators are hand-mocked so no DB / network is touched.
 */

const NOTIF = {
  collectionType: 'sleep',
  date: '2026-05-30',
  ownerId: 'fb-user-1',
  ownerType: 'user',
  subscriptionId: 'sub-1',
};

function makeReq(body: unknown, hasRawBody = true): RawBodyRequest<Request> {
  const raw = Buffer.from(JSON.stringify(body));
  return {
    rawBody: hasRawBody ? raw : undefined,
    headers: { 'x-fitbit-signature': 'SIG' },
  } as unknown as RawBodyRequest<Request>;
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
      (n: typeof NOTIF) =>
        `${n.collectionType}:${n.ownerId}:${n.date ?? 'none'}:${n.subscriptionId}`,
    ),
    fetchNotificationRecords: jest.fn(async () => [
      { provider: WearableProvider.FITBIT, payload: {} },
    ]),
    normalize: jest.fn(() => [
      {
        userId: 'u',
        connectionId: 'conn-1',
        provider: WearableProvider.FITBIT,
        metric: 'STEPS',
        bucket: 'HEALTH_FITNESS',
        value: 100,
        unit: 'steps',
        startAt: new Date(),
        endAt: new Date(),
      },
    ]),
  } as unknown as FitbitConnector;

  const controller = new FitbitWebhookController(prisma, ingestion, connector);
  return { controller, processedEvent, wearableConnection, ingestion, connector };
}

describe('FitbitWebhookController — signature gate', () => {
  it('rejects an invalid signature with 401 and never touches the DB', async () => {
    const { controller, processedEvent, ingestion } = setup({ verify: false });
    await expect(controller.handle(makeReq([NOTIF]))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(processedEvent.findUnique).not.toHaveBeenCalled();
    expect(ingestion.ingest).not.toHaveBeenCalled();
  });

  it('rejects a request without a raw body with 400', async () => {
    const { controller } = setup({});
    await expect(
      controller.handle(makeReq([NOTIF], false)),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('FitbitWebhookController — idempotency / replay', () => {
  it('no-ops for a previously-processed notification (no fetch, no ingest, no commit)', async () => {
    const { controller, processedEvent, ingestion, connector } = setup({
      existingEvent: true,
    });
    await controller.handle(makeReq([NOTIF]));
    expect(processedEvent.create).not.toHaveBeenCalled();
    expect(connector.fetchNotificationRecords).not.toHaveBeenCalled();
    expect(ingestion.ingest).not.toHaveBeenCalled();
  });

  it('treats a concurrent unique-violation (P2002) on the post-ingest commit as a benign no-op', async () => {
    const { controller, processedEvent, ingestion, connector } = setup({});
    processedEvent.create.mockRejectedValueOnce({ code: 'P2002' });
    await expect(controller.handle(makeReq([NOTIF]))).resolves.toBeUndefined();
    expect(connector.fetchNotificationRecords).toHaveBeenCalledTimes(1);
    expect(ingestion.ingest).toHaveBeenCalledTimes(1);
  });
});

describe('FitbitWebhookController — first delivery', () => {
  it('records the event, fetches the changed records, and ingests normalized samples', async () => {
    const { controller, processedEvent, connector, ingestion, wearableConnection } =
      setup({});
    await controller.handle(makeReq([NOTIF]));

    // R2 ordering: dedup row written ONLY AFTER a successful ingest.
    expect(processedEvent.create).toHaveBeenCalledWith({
      data: {
        provider: WearableProvider.FITBIT,
        provider_event_id: 'sleep:fb-user-1:2026-05-30:sub-1',
        type: 'sleep.updated',
        handler_completed_at: expect.any(Date),
      },
    });
    expect(connector.fetchNotificationRecords).toHaveBeenCalledTimes(1);
    expect(ingestion.ingest).toHaveBeenCalledTimes(1);

    const ingestOrder = (ingestion.ingest as jest.Mock).mock.invocationCallOrder[0];
    const createOrder = (processedEvent.create as jest.Mock).mock.invocationCallOrder[0];
    expect(ingestOrder).toBeLessThan(createOrder);

    expect(wearableConnection.findFirst).toHaveBeenCalledWith({
      where: {
        provider: WearableProvider.FITBIT,
        external_account_id: 'fb-user-1',
        disconnected_at: null,
      },
    });
  });

  it('processes every notification in a batch', async () => {
    const { controller, connector, ingestion, processedEvent } = setup({});
    await controller.handle(
      makeReq([
        NOTIF,
        { ...NOTIF, collectionType: 'activities', subscriptionId: 'sub-2' },
      ]),
    );
    expect(connector.fetchNotificationRecords).toHaveBeenCalledTimes(2);
    expect(ingestion.ingest).toHaveBeenCalledTimes(2);
    expect(processedEvent.create).toHaveBeenCalledTimes(2);
  });

  it('does not fetch/ingest for a userRevokedAccess notification but still records it', async () => {
    const { controller, connector, ingestion, processedEvent } = setup({});
    await controller.handle(
      makeReq([{ ...NOTIF, collectionType: 'userRevokedAccess' }]),
    );
    expect(connector.fetchNotificationRecords).not.toHaveBeenCalled();
    expect(ingestion.ingest).not.toHaveBeenCalled();
    expect(processedEvent.create).toHaveBeenCalledWith({
      data: {
        provider: WearableProvider.FITBIT,
        provider_event_id: 'userRevokedAccess:fb-user-1:2026-05-30:sub-1',
        type: 'userRevokedAccess.updated',
        handler_completed_at: expect.any(Date),
      },
    });
  });

  it('does NOT write a processed-event row when fetch/ingest fails, marks connection error, then rethrows', async () => {
    const { controller, connector, wearableConnection, processedEvent, ingestion } =
      setup({});
    (connector.fetchNotificationRecords as jest.Mock).mockRejectedValueOnce(
      new Error('upstream 503'),
    );
    await expect(controller.handle(makeReq([NOTIF]))).rejects.toThrow(
      'upstream 503',
    );
    expect(ingestion.ingest).not.toHaveBeenCalled();
    expect(processedEvent.create).not.toHaveBeenCalled();
    expect(wearableConnection.update).toHaveBeenCalledWith({
      where: { id: 'conn-1' },
      data: { status: 'error', last_error: 'upstream 503' },
    });
  });

  it('logs (never swallows) a failed error-status DB write and still rethrows the original error', async () => {
    const { controller, connector, wearableConnection, processedEvent } =
      setup({});
    (connector.fetchNotificationRecords as jest.Mock).mockRejectedValueOnce(
      new Error('upstream 503'),
    );
    // The best-effort error-status write itself fails (e.g. DB/RLS outage).
    (wearableConnection.update as jest.Mock).mockRejectedValueOnce(
      new Error('db write down'),
    );
    const errSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    // The ORIGINAL provider error must still propagate (not the marking error,
    // and never a silent success) so Fitbit retries the delivery.
    await expect(controller.handle(makeReq([NOTIF]))).rejects.toThrow(
      'upstream 503',
    );
    // No dedup row written — the retry can reprocess.
    expect(processedEvent.create).not.toHaveBeenCalled();

    // The marking failure must be logged with structured context — proving it
    // was NOT swallowed by a `.catch(() => undefined)` (#36 Silent Failures).
    const loggedMarkingFailure = errSpy.mock.calls.some(
      (call) =>
        (call[0] as { msg?: string })?.msg ===
        'wearables.fitbit.webhook.error_marking_failed',
    );
    expect(loggedMarkingFailure).toBe(true);
    errSpy.mockRestore();
  });

  it('no-ops gracefully when no matching connection exists (still records)', async () => {
    const { controller, ingestion, connector, processedEvent } = setup({
      connection: null,
    });
    await controller.handle(makeReq([NOTIF]));
    expect(connector.fetchNotificationRecords).not.toHaveBeenCalled();
    expect(ingestion.ingest).not.toHaveBeenCalled();
    expect(processedEvent.create).toHaveBeenCalledTimes(1);
  });
});

describe('FitbitWebhookController — payload validation', () => {
  it('rejects a notification missing required fields with 400', async () => {
    const { controller } = setup({});
    await expect(
      controller.handle(makeReq([{ collectionType: 'sleep' }])),
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

  it('rejects a payload carrying an unknown extra field (.strict) with 400, before any fetch/ingest', async () => {
    const { controller, processedEvent, connector, ingestion } = setup({});
    await expect(
      controller.handle(makeReq([{ ...NOTIF, injected: 'evil' }])),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(processedEvent.findUnique).not.toHaveBeenCalled();
    expect(connector.fetchNotificationRecords).not.toHaveBeenCalled();
    expect(ingestion.ingest).not.toHaveBeenCalled();
  });

  it('rejects a bare singleton object (Fitbit always sends an array) with 400', async () => {
    const { controller, processedEvent, ingestion } = setup({});
    // A single notification OBJECT (not wrapped in an array) is not a Fitbit
    // subscription delivery and must be rejected.
    await expect(controller.handle(makeReq(NOTIF))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(processedEvent.findUnique).not.toHaveBeenCalled();
    expect(ingestion.ingest).not.toHaveBeenCalled();
  });

  it('rejects an unknown collectionType with 400', async () => {
    const { controller, ingestion } = setup({});
    await expect(
      controller.handle(makeReq([{ ...NOTIF, collectionType: 'bogus' }])),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(ingestion.ingest).not.toHaveBeenCalled();
  });

  it('rejects a non-`user` ownerType with 400', async () => {
    const { controller, ingestion } = setup({});
    await expect(
      controller.handle(makeReq([{ ...NOTIF, ownerType: 'org' }])),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(ingestion.ingest).not.toHaveBeenCalled();
  });

  it('accepts every documented Fitbit collectionType', async () => {
    for (const collectionType of [
      'activities',
      'body',
      'foods',
      'sleep',
      'heart',
      'br',
      'spo2',
      'userRevokedAccess',
    ]) {
      const { controller, processedEvent } = setup({});
      await expect(
        controller.handle(makeReq([{ ...NOTIF, collectionType }])),
      ).resolves.toBeUndefined();
      expect(processedEvent.create).toHaveBeenCalledTimes(1);
    }
  });
});

describe('FitbitWebhookController — ingest-failure error redaction', () => {
  it('redacts token-like secrets from the upstream error before it reaches last_error or logs', async () => {
    const { controller, wearableConnection } = setup({});
    const leaky =
      'Fitbit 500: Authorization: Bearer abc.def.ghi failed; ' +
      'client_secret=supersecret refresh_token=rotate-me-please';
    (connectorFetchMock(controller) as jest.Mock).mockRejectedValueOnce(
      new Error(leaky),
    );
    const errorSpy = jest
      .spyOn(
        (controller as unknown as { logger: { error: (...a: unknown[]) => void } })
          .logger,
        'error',
      )
      .mockImplementation(() => undefined);

    await expect(controller.handle(makeReq([NOTIF]))).rejects.toThrow();

    // 1) DB write must carry a redacted message — no raw secret substrings.
    const updateArg = (wearableConnection.update as jest.Mock).mock.calls[0][0];
    const persisted: string = updateArg.data.last_error;
    expect(persisted).not.toContain('abc.def.ghi');
    expect(persisted).not.toContain('supersecret');
    expect(persisted).not.toContain('rotate-me-please');
    expect(persisted).toContain('[REDACTED]');

    // 2) The structured log must carry the SAME redacted message.
    const logged = errorSpy.mock.calls.find(
      (c) =>
        (c[0] as { msg?: string })?.msg ===
        'wearables.fitbit.webhook.ingest_failure',
    );
    expect(logged).toBeDefined();
    const loggedMessage = (logged?.[0] as { error_message?: string })
      ?.error_message;
    expect(loggedMessage).not.toContain('abc.def.ghi');
    expect(loggedMessage).not.toContain('supersecret');
    expect(loggedMessage).not.toContain('rotate-me-please');
    expect(loggedMessage).toContain('[REDACTED]');

    errorSpy.mockRestore();
  });
});

/** Reach the connector mock's fetchNotificationRecords for failure injection. */
function connectorFetchMock(controller: FitbitWebhookController) {
  return (controller as unknown as { connector: FitbitConnector })
    .connector.fetchNotificationRecords;
}

describe('FitbitWebhookController — verification handshake', () => {
  function makeRes(): { res: Response; status: jest.Mock; send: jest.Mock } {
    const send = jest.fn();
    const status = jest.fn(() => ({ send }));
    const res = { status, send } as unknown as Response;
    return { res, status, send };
  }

  beforeEach(() => {
    process.env.FITBIT_VERIFICATION_CODE = 'verify-code-1';
  });

  it('returns 204 for a matching verify code', () => {
    const { controller } = setup({});
    const { res, status } = makeRes();
    controller.verify('verify-code-1', res);
    expect(status).toHaveBeenCalledWith(HttpStatus.NO_CONTENT);
  });

  it('returns 404 for a wrong verify code', () => {
    const { controller } = setup({});
    const { res, status } = makeRes();
    controller.verify('wrong-code', res);
    expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
  });

  it('fails closed with 404 when the code is unconfigured', () => {
    delete process.env.FITBIT_VERIFICATION_CODE;
    const { controller } = setup({});
    const { res, status } = makeRes();
    controller.verify('anything', res);
    expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
  });
});
