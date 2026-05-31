import { UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { KmsService } from '../../../common/kms/kms.service';
import { ProviderHttpClient } from '../../http/provider-http-client';
import { WhoopConnector, signWhoopWebhook } from './whoop.connector';
import { WhoopWebhookController } from './whoop-webhook.controller';
import {
  WHOOP_SIGNATURE_HEADER,
  WHOOP_SIGNATURE_TIMESTAMP_HEADER,
} from './whoop.types';

const SECRET = 'whoop-test-secret';

interface PrismaMock {
  wearableProcessedEvent: {
    createMany: jest.Mock;
    updateMany: jest.Mock;
  };
  wearableConnection: { updateMany: jest.Mock };
}

function makePrisma(): PrismaMock {
  return {
    wearableProcessedEvent: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    wearableConnection: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

function makeReq(rawBody: Buffer, headers: Record<string, string>): Request {
  return {
    rawBody,
    headers,
  } as unknown as Request;
}

function signedHeaders(rawBody: Buffer, secret = SECRET): Record<string, string> {
  const ts = String(Date.now());
  return {
    [WHOOP_SIGNATURE_HEADER]: signWhoopWebhook({ rawBody, timestamp: ts, secret }),
    [WHOOP_SIGNATURE_TIMESTAMP_HEADER]: ts,
  };
}

describe('WhoopWebhookController', () => {
  let connector: WhoopConnector;
  let prisma: PrismaMock;
  let controller: WhoopWebhookController;

  beforeEach(() => {
    process.env.WHOOP_CLIENT_ID = 'client-123';
    process.env.WHOOP_CLIENT_SECRET = SECRET;
    delete process.env.WHOOP_WEBHOOK_SECRET;
    connector = new WhoopConnector(
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
    controller = new WhoopWebhookController(
      connector,
      prisma as unknown as import('../../../prisma.service').PrismaService,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('accepts a valid, signed data event and records it for dedup', async () => {
    const body = { id: 'evt-1', type: 'recovery.updated', user_id: 7 };
    const rawBody = Buffer.from(JSON.stringify(body));
    const headers = signedHeaders(rawBody);

    const res = await controller.handle(
      makeReq(rawBody, headers),
      headers[WHOOP_SIGNATURE_HEADER],
      headers[WHOOP_SIGNATURE_TIMESTAMP_HEADER],
    );

    expect(res).toEqual({ ok: true, duplicate: false });
    expect(prisma.wearableProcessedEvent.createMany).toHaveBeenCalledTimes(1);
    const arg = prisma.wearableProcessedEvent.createMany.mock.calls[0][0];
    expect(arg.skipDuplicates).toBe(true);
    expect(arg.data[0]).toMatchObject({
      provider: 'WHOOP',
      provider_event_id: 'evt-1',
      type: 'recovery.updated',
    });
    // handler_completed_at stamped.
    expect(prisma.wearableProcessedEvent.updateMany).toHaveBeenCalledTimes(1);
  });

  it('rejects a bad signature with 401 and never records the event', async () => {
    const rawBody = Buffer.from(JSON.stringify({ id: 'evt-1', type: 'sleep.updated' }));
    const headers = signedHeaders(rawBody);
    headers[WHOOP_SIGNATURE_HEADER] = 'tampered';

    await expect(
      controller.handle(
        makeReq(rawBody, headers),
        headers[WHOOP_SIGNATURE_HEADER],
        headers[WHOOP_SIGNATURE_TIMESTAMP_HEADER],
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.wearableProcessedEvent.createMany).not.toHaveBeenCalled();
  });

  it('rejects with 401 when raw body is unavailable', async () => {
    const req = { headers: {} } as unknown as Request;
    await expect(controller.handle(req, '', '')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('treats a redelivered event as a replay no-op (duplicate:true)', async () => {
    prisma.wearableProcessedEvent.createMany.mockResolvedValueOnce({ count: 0 });
    const body = { id: 'evt-dup', type: 'workout.updated', user_id: 7 };
    const rawBody = Buffer.from(JSON.stringify(body));
    const headers = signedHeaders(rawBody);

    const res = await controller.handle(
      makeReq(rawBody, headers),
      headers[WHOOP_SIGNATURE_HEADER],
      headers[WHOOP_SIGNATURE_TIMESTAMP_HEADER],
    );

    expect(res).toEqual({ ok: true, duplicate: true });
    // No revocation / no handled-stamp side effects on a duplicate.
    expect(prisma.wearableConnection.updateMany).not.toHaveBeenCalled();
    expect(prisma.wearableProcessedEvent.updateMany).not.toHaveBeenCalled();
  });

  it('on user.deauthorized, soft-disconnects the matching connection(s)', async () => {
    const body = { id: 'evt-revoke', type: 'user.deauthorized', user_id: 7 };
    const rawBody = Buffer.from(JSON.stringify(body));
    const headers = signedHeaders(rawBody);

    const res = await controller.handle(
      makeReq(rawBody, headers),
      headers[WHOOP_SIGNATURE_HEADER],
      headers[WHOOP_SIGNATURE_TIMESTAMP_HEADER],
    );

    expect(res).toEqual({ ok: true, duplicate: false, revoked: true });
    expect(prisma.wearableConnection.updateMany).toHaveBeenCalledTimes(1);
    const arg = prisma.wearableConnection.updateMany.mock.calls[0][0];
    expect(arg.where).toMatchObject({
      provider: 'WHOOP',
      external_account_id: '7',
    });
    expect(arg.data.status).toBe('disconnected');
    expect(arg.data.disconnected_at).toBeInstanceOf(Date);
  });

  it('returns 200 (no retry) for a verified but non-JSON body', async () => {
    const rawBody = Buffer.from('not-json');
    const headers = signedHeaders(rawBody);
    const res = await controller.handle(
      makeReq(rawBody, headers),
      headers[WHOOP_SIGNATURE_HEADER],
      headers[WHOOP_SIGNATURE_TIMESTAMP_HEADER],
    );
    expect(res).toEqual({ ok: true, duplicate: false });
    expect(prisma.wearableProcessedEvent.createMany).not.toHaveBeenCalled();
  });
});
