import {
  ForbiddenException,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { WearableProvider } from '@prisma/client';
import type { Request } from 'express';
import {
  StravaActivityFetchQueue,
  StravaWebhookController,
} from './strava-webhook.controller';
import { StravaWebhookEvent } from './strava.types';

/**
 * PR-HK-2.f — Strava webhook controller tests.
 *
 *  - GET subscription challenge: echoes when verify_token matches; 403 else.
 *  - POST events: IP allow-list (mockable), Zod payload validation (400),
 *    fail-closed subscription_id (503 unset / 403 mismatch), dedup via
 *    WearableProcessedEvent, durable enqueue on first-time activity event.
 */

const ENV: Record<string, string> = {
  STRAVA_WEBHOOK_VERIFY_TOKEN: 'verify-secret',
  STRAVA_WEBHOOK_SUBSCRIPTION_ID: '12345',
  STRAVA_WEBHOOK_ALLOWED_IPS: '54.173.232.159',
};

function makeController(opts?: {
  createManyCount?: number;
  env?: Record<string, string>;
}) {
  const createMany = jest
    .fn()
    .mockResolvedValue({ count: opts?.createManyCount ?? 1 });
  const prisma = {
    wearableProcessedEvent: { createMany },
  } as unknown as import('../../../prisma.service').PrismaService;

  const enqueueActivityFetch = jest.fn().mockResolvedValue(undefined);
  const queue = { enqueueActivityFetch } as unknown as StravaActivityFetchQueue;

  const env = opts?.env ?? ENV;
  const controller = new StravaWebhookController(prisma, queue, {
    getEnv: (k) => env[k],
  });
  return { controller, createMany, enqueueActivityFetch };
}

function reqFromIp(ip: string): Request {
  return {
    headers: { 'x-forwarded-for': ip },
    socket: { remoteAddress: ip },
  } as unknown as Request;
}

const baseEvent: StravaWebhookEvent = {
  aspect_type: 'create',
  event_time: 1_700_000_000,
  object_id: 999,
  object_type: 'activity',
  owner_id: 42,
  subscription_id: 12345,
  updates: {},
};

describe('StravaWebhookController GET subscription verification', () => {
  it('echoes the challenge when verify_token matches', () => {
    const { controller } = makeController();
    const out = controller.verifySubscription(
      'subscribe',
      'challenge-nonce',
      'verify-secret',
    );
    expect(out).toEqual({ 'hub.challenge': 'challenge-nonce' });
  });

  it('403s when the verify_token does not match', () => {
    const { controller } = makeController();
    expect(() =>
      controller.verifySubscription('subscribe', 'nonce', 'WRONG'),
    ).toThrow(ForbiddenException);
  });

  it('403s when mode is not subscribe', () => {
    const { controller } = makeController();
    expect(() =>
      controller.verifySubscription('unsubscribe', 'nonce', 'verify-secret'),
    ).toThrow(ForbiddenException);
  });

  it('403s when the verify token is not configured', () => {
    const { controller } = makeController({ env: {} });
    expect(() =>
      controller.verifySubscription('subscribe', 'nonce', 'anything'),
    ).toThrow(/not configured/);
  });
});

describe('StravaWebhookController POST events', () => {
  const goodReq = () => reqFromIp('54.173.232.159');

  it('enqueues a fetch on a first-time activity create event', async () => {
    const { controller, createMany, enqueueActivityFetch } = makeController({
      createManyCount: 1,
    });
    const out = await controller.handleEvent(goodReq(), baseEvent);

    expect(out).toEqual({ received: true, deduped: false });
    expect(createMany).toHaveBeenCalledTimes(1);
    const arg = createMany.mock.calls[0][0];
    expect(arg.skipDuplicates).toBe(true);
    expect(arg.data[0].provider).toBe(WearableProvider.STRAVA);
    expect(arg.data[0].provider_event_id).toBe('activity:999:1700000000');
    expect(arg.data[0].type).toBe('activity.create');
    expect(enqueueActivityFetch).toHaveBeenCalledWith(42, 999);
  });

  it('is a no-op (deduped) on redelivery (createMany inserts 0)', async () => {
    const { controller, enqueueActivityFetch } = makeController({
      createManyCount: 0,
    });
    const out = await controller.handleEvent(goodReq(), baseEvent);
    expect(out).toEqual({ received: true, deduped: true });
    expect(enqueueActivityFetch).not.toHaveBeenCalled();
  });

  it('blocks a request from a non-allowed source IP', async () => {
    const { controller, createMany } = makeController();
    await expect(
      controller.handleEvent(reqFromIp('1.2.3.4'), baseEvent),
    ).rejects.toThrow(ForbiddenException);
    expect(createMany).not.toHaveBeenCalled();
  });

  it('allows any IP when allow-list is "*" (trusted proxy)', async () => {
    const { controller } = makeController({
      env: { ...ENV, STRAVA_WEBHOOK_ALLOWED_IPS: '*' },
    });
    const out = await controller.handleEvent(reqFromIp('8.8.8.8'), baseEvent);
    expect(out.received).toBe(true);
  });

  it('uses default IP list when env var is unset', async () => {
    const env = { ...ENV };
    delete env.STRAVA_WEBHOOK_ALLOWED_IPS;
    const { controller } = makeController({ env });
    // 54.173.232.159 is a documented default → allowed.
    const out = await controller.handleEvent(
      reqFromIp('54.173.232.159'),
      baseEvent,
    );
    expect(out.received).toBe(true);
  });

  it('403s on a foreign subscription_id (configured but mismatched)', async () => {
    const { controller, createMany } = makeController();
    await expect(
      controller.handleEvent(goodReq(), {
        ...baseEvent,
        subscription_id: 99999,
      }),
    ).rejects.toThrow(ForbiddenException);
    expect(createMany).not.toHaveBeenCalled();
  });

  // Finding 1 (fail-closed): subscription id env var UNSET → 503, no DB touch.
  it('503s and does NOT process when STRAVA_WEBHOOK_SUBSCRIPTION_ID is unset', async () => {
    const env = { ...ENV };
    delete env.STRAVA_WEBHOOK_SUBSCRIPTION_ID;
    const { controller, createMany, enqueueActivityFetch } = makeController({
      env,
    });
    await expect(controller.handleEvent(goodReq(), baseEvent)).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(createMany).not.toHaveBeenCalled();
    expect(enqueueActivityFetch).not.toHaveBeenCalled();
  });

  // Finding 1: a startup warning is logged when the subscription id is unset.
  it('logs a startup warning (onModuleInit) when subscription id is unset', () => {
    const env = { ...ENV };
    delete env.STRAVA_WEBHOOK_SUBSCRIPTION_ID;
    const { controller } = makeController({ env });
    const warn = jest
      .spyOn(
        (controller as unknown as { logger: { warn: (m: string) => void } })
          .logger,
        'warn',
      )
      .mockImplementation(() => undefined);
    controller.onModuleInit();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('STRAVA_WEBHOOK_SUBSCRIPTION_ID is unset'),
    );
    warn.mockRestore();
  });

  // Finding 2 (Zod): malformed payloads → 400 BEFORE any DB write.
  it('400s on a non-numeric object_id', async () => {
    const { controller, createMany } = makeController();
    await expect(
      controller.handleEvent(goodReq(), {
        ...baseEvent,
        object_id: 'nope',
      } as unknown as StravaWebhookEvent),
    ).rejects.toThrow(BadRequestException);
    expect(createMany).not.toHaveBeenCalled();
  });

  it('400s on a non-numeric owner_id (R1 §2 — owner_id must be numeric)', async () => {
    const { controller, createMany, enqueueActivityFetch } = makeController();
    await expect(
      controller.handleEvent(goodReq(), {
        ...baseEvent,
        owner_id: 'attacker',
      } as unknown as StravaWebhookEvent),
    ).rejects.toThrow(BadRequestException);
    expect(createMany).not.toHaveBeenCalled();
    expect(enqueueActivityFetch).not.toHaveBeenCalled();
  });

  it('400s on an invalid aspect_type enum value', async () => {
    const { controller, createMany } = makeController();
    await expect(
      controller.handleEvent(goodReq(), {
        ...baseEvent,
        aspect_type: 'archive',
      } as unknown as StravaWebhookEvent),
    ).rejects.toThrow(BadRequestException);
    expect(createMany).not.toHaveBeenCalled();
  });

  it('400s on an invalid object_type enum value', async () => {
    const { controller } = makeController();
    await expect(
      controller.handleEvent(goodReq(), {
        ...baseEvent,
        object_type: 'segment',
      } as unknown as StravaWebhookEvent),
    ).rejects.toThrow(BadRequestException);
  });

  it('400s on a missing required field (subscription_id absent)', async () => {
    const { controller } = makeController();
    const { subscription_id: _omit, ...partial } = baseEvent;
    void _omit;
    await expect(
      controller.handleEvent(
        goodReq(),
        partial as unknown as StravaWebhookEvent,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('400s on a negative object_id (must be positive)', async () => {
    const { controller } = makeController();
    await expect(
      controller.handleEvent(goodReq(), { ...baseEvent, object_id: -5 }),
    ).rejects.toThrow(BadRequestException);
  });

  it('400s on unknown extra top-level keys (.strict)', async () => {
    const { controller } = makeController();
    await expect(
      controller.handleEvent(goodReq(), {
        ...baseEvent,
        injected: 'x',
      } as unknown as StravaWebhookEvent),
    ).rejects.toThrow(BadRequestException);
  });

  it('does NOT enqueue a fetch for a delete event but still records it', async () => {
    const { controller, enqueueActivityFetch, createMany } = makeController({
      createManyCount: 1,
    });
    const out = await controller.handleEvent(goodReq(), {
      ...baseEvent,
      aspect_type: 'delete',
    });
    expect(out.deduped).toBe(false);
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(enqueueActivityFetch).not.toHaveBeenCalled();
  });

  it('does NOT enqueue an activity fetch for an athlete event', async () => {
    const { controller, enqueueActivityFetch } = makeController();
    await controller.handleEvent(goodReq(), {
      ...baseEvent,
      object_type: 'athlete',
      aspect_type: 'update',
      updates: { authorized: 'false' },
    });
    expect(enqueueActivityFetch).not.toHaveBeenCalled();
  });
});

describe('StravaActivityFetchQueue (durable enqueue — Finding 3)', () => {
  function makeQueue(createManyCount = 1) {
    const createMany = jest
      .fn()
      .mockResolvedValue({ count: createManyCount });
    const prisma = {
      wearableProcessedEvent: { createMany },
    } as unknown as import('../../../prisma.service').PrismaService;
    return { queue: new StravaActivityFetchQueue(prisma), createMany };
  }

  it('persists a durable, claimable PENDING work row (owner+activity)', async () => {
    const { queue, createMany } = makeQueue(1);
    await queue.enqueueActivityFetch(42, 999);

    expect(createMany).toHaveBeenCalledTimes(1);
    const arg = createMany.mock.calls[0][0];
    expect(arg.skipDuplicates).toBe(true);
    const row = arg.data[0];
    expect(row.provider).toBe(WearableProvider.STRAVA);
    // Namespaced so it never collides with a dedup row.
    expect(row.provider_event_id).toBe('strava:fetch:activity:999:42');
    expect(row.type).toBe(StravaActivityFetchQueue.FETCH_WORK_TYPE);
    expect(row.type).toBe('strava.activity.fetch');
    // PENDING: handler_completed_at NOT set → a worker claims it.
    expect(row.handler_completed_at).toBeUndefined();
  });

  it('is idempotent on a duplicate enqueue (skipDuplicates no-op)', async () => {
    const { queue, createMany } = makeQueue(0);
    await expect(queue.enqueueActivityFetch(42, 999)).resolves.toBeUndefined();
    expect(createMany).toHaveBeenCalledTimes(1);
  });
});
