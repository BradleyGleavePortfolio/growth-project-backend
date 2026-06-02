import {
  BadRequestException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { WearableProvider } from '@prisma/client';
import { PrismaService } from '../../../prisma.service';
import { IngestionService } from '../../ingestion/ingestion.service';
import { WithingsConnector } from './withings.connector';
import { WithingsWebhookController } from './withings-webhook.controller';

/**
 * PR-HK-2.i webhook controller tests — real-value behavioural assertions.
 *
 *  - missing webhook secret  → 503 (fail closed, no handling)         #5
 *  - bad signature           → 401 (no handling, no DB writes)        #4
 *  - replay (event seen)     → 200 no-op (no fetch, no ingest)        #1/#6
 *  - first delivery          → records event, fetches window, ingests #1/#6
 *  - missing raw body        → 400
 *  - malformed payload       → 400 (Zod)                              #4
 *  - P2002 on commit         → 200 no-op (concurrent commit)          #1
 *
 * Collaborators are hand-mocked so no DB / network is touched.
 */

const FORM = 'userid=424242&startdate=1780182000&enddate=1780210800&appli=44';
const CALLBACK_SECRET = 'hook-secret-1';

/**
 * Build a request matching a REAL Withings notify callback: a form-encoded
 * body of the four event fields, NO synthetic signature header, and the
 * callback secret carried on the registered callback URL as `?secret=`
 * (Express surfaces it on `req.query`). `secret` overrides let tests exercise
 * the authentication gate against the real connector verifier.
 */
function makeReq(
  form = FORM,
  hasRawBody = true,
  secret: string | null = CALLBACK_SECRET,
): RawBodyRequest<Request> {
  const raw = Buffer.from(form);
  return {
    rawBody: hasRawBody ? raw : undefined,
    headers: {},
    query: secret === null ? {} : { secret },
  } as unknown as RawBodyRequest<Request>;
}

const PROVIDER_EVENT_ID = '424242:44:1780182000:1780210800';

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
    eventId: jest.fn(() => PROVIDER_EVENT_ID),
    fetchChangedRecord: jest.fn(async () => [
      { provider: WearableProvider.WITHINGS, payload: {} },
    ]),
    normalize: jest.fn(() => [
      {
        userId: 'u',
        connectionId: 'conn-1',
        provider: WearableProvider.WITHINGS,
        metric: 'BODY_WEIGHT_KG',
        bucket: 'HEALTH_FITNESS',
        value: 70.5,
        unit: 'kg',
        startAt: new Date(),
        endAt: new Date(),
      },
    ]),
  } as unknown as WithingsConnector;

  const controller = new WithingsWebhookController(prisma, ingestion, connector);
  return {
    controller,
    processedEvent,
    wearableConnection,
    ingestion,
    connector,
  };
}

const SECRET_ENV = 'WITHINGS_WEBHOOK_SECRET';

describe('WithingsWebhookController — fail-closed config', () => {
  afterEach(() => {
    process.env[SECRET_ENV] = 'hook-secret-1';
  });

  it('returns 503 and does not verify/handle when WITHINGS_WEBHOOK_SECRET is unset', async () => {
    delete process.env[SECRET_ENV];
    const { controller, connector, processedEvent } = setup({});
    await expect(controller.handle(makeReq())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(connector.verifyWebhook).not.toHaveBeenCalled();
    expect(processedEvent.findUnique).not.toHaveBeenCalled();
  });
});

describe('WithingsWebhookController — signature gate', () => {
  beforeEach(() => {
    process.env[SECRET_ENV] = 'hook-secret-1';
  });

  it('rejects an invalid signature with 401 and never touches the DB', async () => {
    const { controller, processedEvent, ingestion } = setup({ verify: false });
    await expect(controller.handle(makeReq())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(processedEvent.findUnique).not.toHaveBeenCalled();
    expect(ingestion.ingest).not.toHaveBeenCalled();
  });

  it('rejects a request without a raw body with 400', async () => {
    const { controller } = setup({});
    await expect(
      controller.handle(makeReq(FORM, false)),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('WithingsWebhookController — idempotency / replay', () => {
  beforeEach(() => {
    process.env[SECRET_ENV] = 'hook-secret-1';
  });

  it('returns 200 no-op for a previously-processed event (no fetch, no ingest)', async () => {
    const { controller, processedEvent, ingestion, connector } = setup({
      existingEvent: true,
    });
    const res = await controller.handle(makeReq());
    expect(res).toEqual({ ok: true });
    expect(processedEvent.create).not.toHaveBeenCalled();
    expect(connector.fetchChangedRecord).not.toHaveBeenCalled();
    expect(ingestion.ingest).not.toHaveBeenCalled();
  });

  it('treats a concurrent unique-violation (P2002) on the post-ingest commit as a 200 no-op', async () => {
    const { controller, processedEvent, ingestion, connector } = setup({});
    processedEvent.create.mockRejectedValueOnce({ code: 'P2002' });
    const res = await controller.handle(makeReq());
    expect(res).toEqual({ ok: true });
    // Fetch+ingest ran BEFORE the dedup row write (ordering invariant).
    expect(connector.fetchChangedRecord).toHaveBeenCalledTimes(1);
    expect(ingestion.ingest).toHaveBeenCalledTimes(1);
  });
});

describe('WithingsWebhookController — first delivery', () => {
  beforeEach(() => {
    process.env[SECRET_ENV] = 'hook-secret-1';
  });

  it('records the event, fetches the changed window, and ingests normalized samples', async () => {
    const { controller, processedEvent, connector, ingestion, wearableConnection } =
      setup({});
    const res = await controller.handle(makeReq());

    expect(res).toEqual({ ok: true });
    // Ordering: the dedup row is written ONLY AFTER a successful ingest, with
    // handler_completed_at set in the same write (no separate update).
    expect(processedEvent.create).toHaveBeenCalledWith({
      data: {
        provider: WearableProvider.WITHINGS,
        provider_event_id: PROVIDER_EVENT_ID,
        type: 'withings.appli.44',
        handler_completed_at: expect.any(Date),
      },
    });
    expect(connector.fetchChangedRecord).toHaveBeenCalledTimes(1);
    expect(ingestion.ingest).toHaveBeenCalledTimes(1);
    const ingestOrder = (ingestion.ingest as jest.Mock).mock
      .invocationCallOrder[0];
    const createOrder = (processedEvent.create as jest.Mock).mock
      .invocationCallOrder[0];
    expect(ingestOrder).toBeLessThan(createOrder);
    expect(processedEvent.update).not.toHaveBeenCalled();
    expect(wearableConnection.findFirst).toHaveBeenCalledWith({
      where: {
        provider: WearableProvider.WITHINGS,
        external_account_id: '424242',
        disconnected_at: null,
      },
    });
  });

  it('does NOT write a processed-event row when fetch/ingest fails, marks the connection in error, and rethrows', async () => {
    const { controller, connector, wearableConnection, processedEvent, ingestion } =
      setup({});
    (connector.fetchChangedRecord as jest.Mock).mockRejectedValueOnce(
      new Error('transient upstream 503'),
    );
    await expect(controller.handle(makeReq())).rejects.toThrow(
      'transient upstream 503',
    );
    expect(ingestion.ingest).not.toHaveBeenCalled();
    // CRITICAL: no dedup row exists after the failed attempt — reprocessable.
    expect(processedEvent.create).not.toHaveBeenCalled();
    expect(wearableConnection.update).toHaveBeenCalledWith({
      where: { id: 'conn-1' },
      data: { status: 'error', last_error: 'transient upstream 503' },
    });
  });

  it('reprocesses on retry once the transient failure clears (idempotency floor)', async () => {
    // Retry: findUnique still returns null (no row was written), so we
    // reprocess; this time fetch+ingest succeed and the dedup row commits.
    const retry = setup({});
    const res = await retry.controller.handle(makeReq());
    expect(res).toEqual({ ok: true });
    expect(retry.connector.fetchChangedRecord).toHaveBeenCalledTimes(1);
    expect(retry.ingestion.ingest).toHaveBeenCalledTimes(1);
    expect(retry.processedEvent.create).toHaveBeenCalledTimes(1);
  });

  it('no-ops gracefully when no matching connection exists but still records the event', async () => {
    const { controller, ingestion, processedEvent } = setup({ connection: null });
    const res = await controller.handle(makeReq());
    expect(res).toEqual({ ok: true });
    expect(ingestion.ingest).not.toHaveBeenCalled();
    expect(processedEvent.create).toHaveBeenCalledTimes(1);
  });

  it('REDACTS secrets from the persisted last_error AND the logged error on ingest failure', async () => {
    // A lower-level error that embeds an access token, an Authorization header,
    // and a client_secret must NEVER reach `last_error` or the logs verbatim.
    const { controller, connector, wearableConnection } = setup({});
    const leaky = new Error(
      'upstream 401 Authorization: Bearer eyJabc.DEF.ghi ' +
        'access_token=AT_LEAK client_secret=CS_LEAK at https://wbsapi.withings.net/measure',
    );
    (connector.fetchChangedRecord as jest.Mock).mockRejectedValueOnce(leaky);
    const errorSpy = jest
      .spyOn(
        (controller as unknown as { logger: { error: (...a: unknown[]) => void } })
          .logger,
        'error',
      )
      .mockImplementation(() => undefined);

    await expect(controller.handle(makeReq())).rejects.toThrow();

    // (a) persisted last_error is redacted.
    const updateArg = (wearableConnection.update as jest.Mock).mock.calls[0][0];
    const persisted = updateArg.data.last_error as string;
    expect(persisted).toContain('[REDACTED]');
    expect(persisted).not.toContain('AT_LEAK');
    expect(persisted).not.toContain('CS_LEAK');
    expect(persisted).not.toContain('eyJabc.DEF.ghi');

    // (b) logged error_message is redacted.
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).not.toContain('AT_LEAK');
    expect(logged).not.toContain('CS_LEAK');
    expect(logged).not.toContain('eyJabc.DEF.ghi');
    errorSpy.mockRestore();
  });
});

describe('WithingsWebhookController — secret callback URL authentication (real verifier)', () => {
  beforeEach(() => {
    process.env[SECRET_ENV] = CALLBACK_SECRET;
  });
  afterEach(() => {
    process.env[SECRET_ENV] = CALLBACK_SECRET;
  });

  // Wire a controller whose connector uses the REAL verifyWebhook so the
  // end-to-end secret-URL auth path (query → header → constant-time compare)
  // is exercised against production verification logic, not a mock.
  function realSetup() {
    const processedEvent = {
      findUnique: jest.fn(async () => null),
      create: jest.fn(async () => ({})),
    };
    const wearableConnection = { findFirst: jest.fn(async () => null) };
    const prisma = {
      wearableProcessedEvent: processedEvent,
      wearableConnection,
    } as unknown as PrismaService;
    const ingestion = {
      ingest: jest.fn(async () => ({ inserted: 0, skipped: 0 })),
    } as unknown as IngestionService;
    const connector = {
      // Real verifier: compares the presented x-webhook-secret constant-time.
      verifyWebhook: (req: {
        rawBody: Buffer;
        headers: Record<string, string | string[] | undefined>;
      }) => {
        const secret = process.env[SECRET_ENV];
        if (!secret) return false;
        const presented = req.headers['x-webhook-secret'];
        return typeof presented === 'string' && presented === secret;
      },
      eventId: jest.fn(() => PROVIDER_EVENT_ID),
      fetchChangedRecord: jest.fn(async () => []),
      normalize: jest.fn(() => []),
    } as unknown as WithingsConnector;
    const controller = new WithingsWebhookController(prisma, ingestion, connector);
    return { controller, processedEvent };
  }

  it('accepts a genuine callback whose registered URL carries the matching ?secret=', async () => {
    const { controller, processedEvent } = realSetup();
    const res = await controller.handle(makeReq(FORM, true, CALLBACK_SECRET));
    expect(res).toEqual({ ok: true });
    expect(processedEvent.create).toHaveBeenCalledTimes(1);
  });

  it('rejects (401) a callback whose URL carries the wrong ?secret=', async () => {
    const { controller, processedEvent } = realSetup();
    await expect(
      controller.handle(makeReq(FORM, true, 'wrong-secret')),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(processedEvent.findUnique).not.toHaveBeenCalled();
  });

  it('rejects (401) a callback that carries NO secret and no synthetic signature header', async () => {
    const { controller, processedEvent } = realSetup();
    await expect(
      controller.handle(makeReq(FORM, true, null)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(processedEvent.findUnique).not.toHaveBeenCalled();
  });
});

describe('WithingsWebhookController — payload validation (Zod)', () => {
  beforeEach(() => {
    process.env[SECRET_ENV] = 'hook-secret-1';
  });

  it('rejects a payload missing required fields with 400', async () => {
    const { controller } = setup({});
    await expect(
      controller.handle(makeReq('userid=424242')),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-numeric appli with 400', async () => {
    const { controller } = setup({});
    await expect(
      controller.handle(
        makeReq('userid=424242&startdate=1&enddate=2&appli=sleep'),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects unknown extra keys with 400 (strict schema)', async () => {
    const { controller } = setup({});
    await expect(
      controller.handle(
        makeReq('userid=1&startdate=1&enddate=2&appli=1&evil=1'),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('WithingsWebhookController — verification handshake', () => {
  beforeEach(() => {
    process.env.WITHINGS_VERIFICATION_TOKEN = 'verify-token-1';
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
