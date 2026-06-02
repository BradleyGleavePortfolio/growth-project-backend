import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { KmsService } from '../../../common/kms/kms.service';
import { ProviderHttpClient } from '../../http/provider-http-client';
import { GarminConnector, hashGarminUserId } from './garmin.connector';
import { GarminWebhookController } from './garmin-webhook.controller';
import { GARMIN_PUSH_TOKEN_HEADER } from './garmin.types';

const PUSH_TOKEN = 'garmin-push-token-abc';
const GARMIN_USER = 'garmin-user-7';

/** 2026-05-20T00:00:00Z epoch seconds — a parseable window for the normalizer. */
const DAY_START_SEC = Math.floor(Date.parse('2026-05-20T00:00:00.000Z') / 1000);

interface PrismaMock {
  wearableProcessedEvent: {
    findUnique: jest.Mock;
    createMany: jest.Mock;
  };
  wearableConnection: {
    findFirst: jest.Mock;
    updateMany: jest.Mock;
    update: jest.Mock;
  };
}

function makePrisma(): PrismaMock {
  return {
    wearableProcessedEvent: {
      findUnique: jest.fn().mockResolvedValue(null),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    wearableConnection: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'conn-uuid-1',
        user_id: 'user-uuid-1',
        provider: 'GARMIN',
        external_account_id: GARMIN_USER,
        disconnected_at: null,
        status: 'connected',
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
    },
  };
}

interface IngestionMock {
  ingest: jest.Mock;
}

function makeIngestion(): IngestionMock {
  return { ingest: jest.fn().mockResolvedValue(undefined) };
}

/** Build a RawBodyRequest with rawBody Buffer + lower-cased header map. */
function makeReq(
  rawBody: Buffer,
  headers: Record<string, string>,
): RawBodyRequest<Request> {
  return { rawBody, headers } as unknown as RawBodyRequest<Request>;
}

function pushHeaders(token = PUSH_TOKEN): Record<string, string> {
  return { [GARMIN_PUSH_TOKEN_HEADER]: token };
}

/** A valid single-collection daily push envelope. */
function dailyEnvelope(summaryId = 'daily-1'): Buffer {
  return Buffer.from(
    JSON.stringify({
      dailies: [
        {
          summaryId,
          userId: GARMIN_USER,
          startTimeInSeconds: DAY_START_SEC,
          startTimeOffsetInSeconds: 0,
          durationInSeconds: 86_400,
          steps: 8421,
          activeKilocalories: 612,
        },
      ],
    }),
  );
}

describe('GarminWebhookController', () => {
  let connector: GarminConnector;
  let prisma: PrismaMock;
  let ingestion: IngestionMock;
  let controller: GarminWebhookController;

  beforeEach(() => {
    process.env.GARMIN_PUSH_TOKEN = PUSH_TOKEN;
    process.env.GARMIN_WEBHOOK_SALT = 'salt-xyz';
    connector = new GarminConnector(
      new ProviderHttpClient({
        fetchFn: jest.fn() as unknown as typeof fetch,
        sleep: () => Promise.resolve(),
        random: () => 1,
      }),
      // The webhook path never touches tokens; a no-op KMS double suffices.
      {
        decrypt: jest.fn((s: string) => s),
        encrypt: jest.fn((s: string) => s),
      } as unknown as KmsService,
    );
    prisma = makePrisma();
    ingestion = makeIngestion();
    controller = new GarminWebhookController(
      connector,
      prisma as unknown as import('../../../prisma.service').PrismaService,
      ingestion as unknown as import('../../ingestion/ingestion.service').IngestionService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.GARMIN_PUSH_TOKEN;
    delete process.env.GARMIN_WEBHOOK_SALT;
  });

  // ── (1) Valid push: verify → normalize → ingest → commit dedup row ──────

  it('accepts a valid, token-verified daily push: ingests samples and commits the dedup row', async () => {
    const rawBody = dailyEnvelope('daily-1');

    const res = await controller.handle(makeReq(rawBody, pushHeaders()));

    expect(res).toEqual({ ok: true, processed: 1, duplicate: 0 });
    // Subject connection resolved by Garmin user id.
    expect(prisma.wearableConnection.findFirst).toHaveBeenCalledTimes(1);
    const findArg = prisma.wearableConnection.findFirst.mock.calls[0][0];
    expect(findArg.where).toMatchObject({
      provider: 'GARMIN',
      external_account_id: GARMIN_USER,
      disconnected_at: null,
    });
    // Samples were ingested (daily → STEPS + ACTIVE_ENERGY_KCAL = 2 samples).
    expect(ingestion.ingest).toHaveBeenCalledTimes(1);
    const samples = ingestion.ingest.mock.calls[0][0] as Array<{
      userId: string;
      connectionId: string;
      metric: string;
    }>;
    expect(samples).toHaveLength(2);
    // ctx threaded onto the samples from the resolved connection.
    expect(samples.every((s) => s.userId === 'user-uuid-1')).toBe(true);
    expect(samples.every((s) => s.connectionId === 'conn-uuid-1')).toBe(true);
    // Dedup row committed AFTER ingest, with handler_completed_at + namespaced id.
    expect(prisma.wearableProcessedEvent.createMany).toHaveBeenCalledTimes(1);
    const createArg = prisma.wearableProcessedEvent.createMany.mock.calls[0][0];
    expect(createArg.skipDuplicates).toBe(true);
    expect(createArg.data[0]).toMatchObject({
      provider: 'GARMIN',
      provider_event_id: 'garmin:dailies:daily-1',
      type: 'dailies',
    });
    expect(createArg.data[0].handler_completed_at).toBeInstanceOf(Date);
    // ingest happened before the dedup-row commit (check → process → commit).
    const ingestOrder = ingestion.ingest.mock.invocationCallOrder[0];
    const commitOrder =
      prisma.wearableProcessedEvent.createMany.mock.invocationCallOrder[0];
    expect(ingestOrder).toBeLessThan(commitOrder);
  });

  // ── (2) Invalid push token → 401, body never interpreted ────────────────

  it('rejects an invalid push token with 401 and never parses or ingests', async () => {
    const rawBody = dailyEnvelope('daily-1');

    await expect(
      controller.handle(makeReq(rawBody, pushHeaders('wrong-token'))),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(prisma.wearableConnection.findFirst).not.toHaveBeenCalled();
    expect(ingestion.ingest).not.toHaveBeenCalled();
    expect(prisma.wearableProcessedEvent.createMany).not.toHaveBeenCalled();
  });

  it('fails closed (401) when GARMIN_PUSH_TOKEN is unset', async () => {
    delete process.env.GARMIN_PUSH_TOKEN;
    const rawBody = dailyEnvelope('daily-1');

    await expect(
      controller.handle(makeReq(rawBody, pushHeaders('anything'))),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(ingestion.ingest).not.toHaveBeenCalled();
  });

  it('rejects with 401 when the raw body is unavailable', async () => {
    const req = { headers: pushHeaders() } as unknown as RawBodyRequest<Request>;
    await expect(controller.handle(req)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(ingestion.ingest).not.toHaveBeenCalled();
  });

  // ── (3) Duplicate event id → idempotency no-op ──────────────────────────

  it('treats an already-processed record as a replay no-op (idempotency, no re-ingest)', async () => {
    prisma.wearableProcessedEvent.findUnique.mockResolvedValueOnce({
      provider: 'GARMIN',
      provider_event_id: 'garmin:dailies:daily-1',
      handler_completed_at: new Date(),
    });
    const rawBody = dailyEnvelope('daily-1');

    const res = await controller.handle(makeReq(rawBody, pushHeaders()));

    expect(res).toEqual({ ok: true, processed: 0, duplicate: 1 });
    // The existing row short-circuits BEFORE connection resolve / ingest / commit.
    expect(prisma.wearableConnection.findFirst).not.toHaveBeenCalled();
    expect(ingestion.ingest).not.toHaveBeenCalled();
    expect(prisma.wearableProcessedEvent.createMany).not.toHaveBeenCalled();
  });

  it('treats a lost commit race (createMany count 0) as a duplicate', async () => {
    prisma.wearableProcessedEvent.createMany.mockResolvedValueOnce({ count: 0 });
    const rawBody = dailyEnvelope('daily-1');

    const res = await controller.handle(makeReq(rawBody, pushHeaders()));

    expect(res).toEqual({ ok: true, processed: 0, duplicate: 1 });
    // Ingest still ran (it precedes the commit), but the row was already there.
    expect(ingestion.ingest).toHaveBeenCalledTimes(1);
  });

  // ── (4) Malformed payload → Zod reject → 400 ────────────────────────────

  it('rejects a verified but non-JSON body with 400 and never ingests', async () => {
    const rawBody = Buffer.from('not-json-at-all');

    await expect(
      controller.handle(makeReq(rawBody, pushHeaders())),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(ingestion.ingest).not.toHaveBeenCalled();
    expect(prisma.wearableProcessedEvent.createMany).not.toHaveBeenCalled();
  });

  it('rejects a verified envelope with an unknown top-level collection (Zod .strict) with 400', async () => {
    const rawBody = Buffer.from(
      JSON.stringify({
        // `forged` is not one of the five known summary kinds → .strict() rejects.
        forged: [{ summaryId: 'x', userId: GARMIN_USER }],
      }),
    );

    await expect(
      controller.handle(makeReq(rawBody, pushHeaders())),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(ingestion.ingest).not.toHaveBeenCalled();
  });

  it('rejects a verified envelope whose record is missing summaryId with 400', async () => {
    const rawBody = Buffer.from(
      JSON.stringify({ dailies: [{ userId: GARMIN_USER, steps: 10 }] }),
    );

    await expect(
      controller.handle(makeReq(rawBody, pushHeaders())),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(ingestion.ingest).not.toHaveBeenCalled();
  });

  // ── No-connection miss: no ingest, no dedup row (allows later re-link) ───

  it('skips a record with no live connection: no ingest, no dedup row', async () => {
    prisma.wearableConnection.findFirst.mockResolvedValueOnce(null);
    const rawBody = dailyEnvelope('daily-1');

    const res = await controller.handle(makeReq(rawBody, pushHeaders()));

    expect(res).toEqual({ ok: true, processed: 0, duplicate: 0 });
    expect(ingestion.ingest).not.toHaveBeenCalled();
    expect(prisma.wearableProcessedEvent.createMany).not.toHaveBeenCalled();
  });

  // ── Ingest failure: mark connection error + rethrow, NO dedup row ───────

  it('on ingest failure marks the connection error, rethrows, and writes NO dedup row', async () => {
    ingestion.ingest.mockRejectedValueOnce(new Error('ingest exploded'));
    const rawBody = dailyEnvelope('daily-1');

    await expect(
      controller.handle(makeReq(rawBody, pushHeaders())),
    ).rejects.toThrow('ingest exploded');

    expect(prisma.wearableConnection.update).toHaveBeenCalledTimes(1);
    const updArg = prisma.wearableConnection.update.mock.calls[0][0];
    expect(updArg.where).toEqual({ id: 'conn-uuid-1' });
    expect(updArg.data.status).toBe('error');
    expect(typeof updArg.data.last_error).toBe('string');
    // No dedup row committed → Garmin redelivery reprocesses.
    expect(prisma.wearableProcessedEvent.createMany).not.toHaveBeenCalled();
  });

  // ── Ingest-failure redaction: raw PII / tokens never reach logs or DB ────

  it('redacts the Garmin userId and token-like fragments from the ingest-failure last_error and log', async () => {
    // A realistic upstream error whose message embeds provider PII + secrets:
    // the raw Garmin userId, a Bearer fragment, a labelled userAccessToken,
    // and a long opaque secret — exactly the values that must never leak.
    const BEARER = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcDEF';
    const USER_ACCESS_TOKEN = 'a1b2c3d4e5f6g7h8i9j0klmnopqrstuv';
    const LEAKY_MESSAGE =
      `ingest failed for user ${GARMIN_USER}: ${BEARER} ` +
      `userAccessToken=${USER_ACCESS_TOKEN} payload secret=${USER_ACCESS_TOKEN}`;
    ingestion.ingest.mockRejectedValueOnce(new Error(LEAKY_MESSAGE));

    const controllerLogger = (
      controller as unknown as {
        logger: { error: (...a: unknown[]) => void };
      }
    ).logger;
    const errorSpy = jest
      .spyOn(controllerLogger, 'error')
      .mockImplementation(() => undefined);

    const rawBody = dailyEnvelope('daily-1');
    await expect(
      controller.handle(makeReq(rawBody, pushHeaders())),
    ).rejects.toThrow();

    // 1) The persisted last_error must NOT contain any raw secret/PII value.
    const updArg = prisma.wearableConnection.update.mock.calls[0][0];
    const persisted: string = updArg.data.last_error;
    expect(persisted).not.toContain(GARMIN_USER);
    expect(persisted).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(persisted).not.toContain(USER_ACCESS_TOKEN);
    expect(persisted).toContain('[redacted');
    expect(persisted.length).toBeLessThanOrEqual(500);

    // 2) The emitted log object must be structured and equally scrubbed.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logArg = errorSpy.mock.calls[0][0] as {
      msg: string;
      user_hash: string;
      error_code: string;
      error_class: string;
      error_message: string;
    };
    expect(logArg.msg).toBe('wearables.garmin.webhook.ingest_failure');
    expect(logArg.error_code).toBe('GARMIN_INGEST_FAILED');
    expect(logArg.error_class).toBe('Error');
    expect(logArg.user_hash).toBe(hashGarminUserId(GARMIN_USER));
    // The hashed user id is present; the raw id and tokens are not.
    expect(logArg.user_hash).not.toContain(GARMIN_USER);
    const serializedLog = JSON.stringify(logArg);
    expect(serializedLog).not.toContain(GARMIN_USER);
    expect(serializedLog).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(serializedLog).not.toContain(USER_ACCESS_TOKEN);
  });

  // ── Ingest-failure recovery: a FAILED status write is never swallowed ───

  it('on a failed status-mark write, logs a redacted secondary failure (no silent swallow) and still rethrows the original error', async () => {
    // Primary ingest fails, AND the best-effort status='error' write also
    // throws — its message embeds the raw Garmin userId so we can prove the
    // secondary log is redacted, not raw. Against the old `.catch(() =>
    // undefined)` this branch logged nothing → this test would fail.
    ingestion.ingest.mockRejectedValueOnce(new Error('ingest exploded'));
    const markFailure = new Error(
      `db write failed for user ${GARMIN_USER}: connection pool exhausted`,
    );
    prisma.wearableConnection.update.mockRejectedValueOnce(markFailure);

    const controllerLogger = (
      controller as unknown as {
        logger: { error: (...a: unknown[]) => void };
      }
    ).logger;
    const errorSpy = jest
      .spyOn(controllerLogger, 'error')
      .mockImplementation(() => undefined);

    const rawBody = dailyEnvelope('daily-1');

    // The ORIGINAL ingest error must still propagate (not the mark error).
    await expect(
      controller.handle(makeReq(rawBody, pushHeaders())),
    ).rejects.toThrow('ingest exploded');

    // The failed mark write is observable: a structured secondary error log.
    const markLog = errorSpy.mock.calls
      .map((c) => c[0] as { msg?: string })
      .find((a) => a?.msg === 'wearables.garmin.webhook.error_marking_failed');
    expect(markLog).toBeDefined();
    const typedMarkLog = markLog as unknown as {
      msg: string;
      conn_id: string;
      user_hash: string;
      error_code: string;
      error_class: string;
      error_message: string;
    };
    expect(typedMarkLog.error_code).toBe('GARMIN_ERROR_MARKING_FAILED');
    expect(typedMarkLog.error_class).toBe('Error');
    expect(typedMarkLog.conn_id).toBe('conn-uuid-1');
    expect(typedMarkLog.user_hash).toBe(hashGarminUserId(GARMIN_USER));
    // The raw Garmin userId from the mark-failure message must be redacted.
    const serialized = JSON.stringify(typedMarkLog);
    expect(serialized).not.toContain(GARMIN_USER);
    expect(typedMarkLog.error_message).toContain('[redacted');
    // No dedup row was committed → Garmin redelivery reprocesses.
    expect(prisma.wearableProcessedEvent.createMany).not.toHaveBeenCalled();
  });

  // ── (5) Deregistration → flips connection status to 'disconnected' ──────

  it('on deregistration push soft-disconnects matching connection(s)', async () => {
    const rawBody = Buffer.from(
      JSON.stringify({
        deregistrations: [{ userId: GARMIN_USER, userAccessToken: 'tok' }],
      }),
    );

    const res = await controller.deregister(makeReq(rawBody, pushHeaders()));

    expect(res).toEqual({ ok: true, disconnected: 1 });
    expect(prisma.wearableConnection.updateMany).toHaveBeenCalledTimes(1);
    const arg = prisma.wearableConnection.updateMany.mock.calls[0][0];
    expect(arg.where).toMatchObject({
      provider: 'GARMIN',
      external_account_id: GARMIN_USER,
    });
    expect(arg.data.status).toBe('disconnected');
    expect(arg.data.disconnected_at).toBeInstanceOf(Date);
  });

  it('rejects a deregistration push with an invalid token (401)', async () => {
    const rawBody = Buffer.from(
      JSON.stringify({ deregistrations: [{ userId: GARMIN_USER }] }),
    );

    await expect(
      controller.deregister(makeReq(rawBody, pushHeaders('wrong'))),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.wearableConnection.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a verified but malformed deregistration payload with 400', async () => {
    // Empty deregistrations array fails the schema (.min(1)).
    const rawBody = Buffer.from(JSON.stringify({ deregistrations: [] }));

    await expect(
      controller.deregister(makeReq(rawBody, pushHeaders())),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.wearableConnection.updateMany).not.toHaveBeenCalled();
  });

  // ── No PII in logs (audit pattern #3) ───────────────────────────────────

  it('NEVER logs the raw Garmin user id on an accepted push (logs a salted user_hash)', async () => {
    const logged: unknown[] = [];
    jest
      .spyOn(
        (controller as unknown as { logger: { log: jest.Mock } }).logger,
        'log',
      )
      .mockImplementation((arg: unknown) => {
        logged.push(arg);
      });

    const rawBody = dailyEnvelope('daily-1');
    await controller.handle(makeReq(rawBody, pushHeaders()));

    expect(logged.length).toBeGreaterThan(0);
    const dump = JSON.stringify(logged);
    expect(dump).not.toContain(GARMIN_USER);
    expect(dump).not.toContain('garmin-user');
  });

  it('NEVER logs the raw Garmin user id on a no-connection miss (logs user_hash)', async () => {
    prisma.wearableConnection.findFirst.mockResolvedValueOnce(null);
    const logged: unknown[] = [];
    jest
      .spyOn(
        (controller as unknown as { logger: { warn: jest.Mock } }).logger,
        'warn',
      )
      .mockImplementation((arg: unknown) => {
        logged.push(arg);
      });

    const rawBody = dailyEnvelope('daily-1');
    await controller.handle(makeReq(rawBody, pushHeaders()));

    const dump = JSON.stringify(logged);
    expect(dump).not.toContain(GARMIN_USER);
    expect(dump).toContain(hashGarminUserId(GARMIN_USER));
  });

  // ── assertPushConfigured fail-closed guard (503) ────────────────────────

  it('assertPushConfigured throws 503 when the push token is unset', () => {
    delete process.env.GARMIN_PUSH_TOKEN;
    expect(() => controller.assertPushConfigured()).toThrow(
      /not configured/i,
    );
  });

  it('assertPushConfigured passes when the push token is set', () => {
    expect(() => controller.assertPushConfigured()).not.toThrow();
  });
});
