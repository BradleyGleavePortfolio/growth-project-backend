import { BadRequestException, INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { createHmac } from 'crypto';
import { MuxService } from '../src/video/mux.service';
import { MuxWebhookController } from '../src/video/mux-webhook.controller';
import { PrismaService } from '../src/prisma.service';

function makeConfig(values: Record<string, string | undefined>): ConfigService {
  return {
    get<T = string>(key: string): T | undefined {
      return values[key] as T | undefined;
    },
  } as ConfigService;
}

function sign(payload: string, secret: string, t = Math.floor(Date.now() / 1000)): string {
  const sig = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  return `t=${t},v1=${sig}`;
}

function mockPrisma() {
  const update = jest.fn(async () => undefined);
  const updateMany = jest.fn(async () => ({ count: 1 }));
  const findUnique = jest.fn(async ({ where }: any) => {
    if (where.mux_upload_id === 'upl_pending') {
      return { id: 'item_42', mux_upload_id: 'upl_pending' };
    }
    return null;
  });
  return {
    prisma: {
      exerciseCatalogItem: { update, updateMany, findUnique },
    } as unknown as PrismaService,
    update,
    updateMany,
    findUnique,
  };
}

describe('MuxWebhookController', () => {
  const SECRET = 'whsec_mux_test_42';

  function build() {
    const mux = new MuxService(makeConfig({ MUX_WEBHOOK_SECRET: SECRET }));
    const { prisma, update, updateMany, findUnique } = mockPrisma();
    const controller = new MuxWebhookController(mux, prisma);
    return { controller, update, updateMany, findUnique };
  }

  // Mux signs the exact bytes it sends; here those bytes are JSON.stringify(body).
  function deliver(
    controller: MuxWebhookController,
    body: Parameters<MuxWebhookController['receive']>[1],
    secret = SECRET,
  ) {
    const raw = JSON.stringify(body);
    return controller.receive({ rawBody: Buffer.from(raw) }, body, sign(raw, secret));
  }

  it('rejects invalid signatures with 400', async () => {
    const { controller } = build();
    const body = { type: 'video.asset.ready' };
    await expect(
      controller.receive({ rawBody: Buffer.from(JSON.stringify(body)) }, body, 'bogus-signature'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects when MUX_WEBHOOK_SECRET is unset', async () => {
    const mux = new MuxService(makeConfig({}));
    const { prisma } = mockPrisma();
    const controller = new MuxWebhookController(mux, prisma);
    const body = { type: 'video.asset.ready' };
    // Even a signature that "looks valid" against some secret fails because
    // the service-side secret is unset.
    await expect(deliver(controller, body, 'random')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('handles video.asset.ready by flipping status to ready', async () => {
    const { controller, updateMany } = build();
    const body = {
      type: 'video.asset.ready',
      data: {
        id: 'asset_xyz',
        playback_ids: [{ id: 'pb_xyz', policy: 'public' as const }],
        duration: 12.5,
      },
    };
    const res = await deliver(controller, body);
    expect(res).toEqual({ received: true });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { mux_asset_id: 'asset_xyz' },
        data: expect.objectContaining({
          mux_asset_status: 'ready',
          mux_playback_id: 'pb_xyz',
          mux_duration_seconds: 12.5,
        }),
      }),
    );
  });

  it('handles video.asset.errored by storing error message (only from pre-terminal states)', async () => {
    const { controller, updateMany } = build();
    const body = {
      type: 'video.asset.errored',
      data: {
        id: 'asset_bad',
        errors: { type: 'invalid_input', messages: ['source video is corrupt'] },
      },
    };
    await deliver(controller, body);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          mux_asset_id: 'asset_bad',
          // P0 fix — only transition errored from pre-terminal states so
          // a stale errored arriving after ready does not erase playback.
          mux_asset_status: { in: ['uploading', 'processing', 'none'] },
        }),
        data: expect.objectContaining({
          mux_asset_status: 'errored',
          mux_error_message: 'source video is corrupt',
          mux_playback_id: null,
        }),
      }),
    );
  });

  it('resolves video.upload.asset_created via mux_upload_id', async () => {
    const { controller, update } = build();
    const body = {
      type: 'video.upload.asset_created',
      data: { id: 'upl_pending', asset_id: 'asset_new' },
    };
    await deliver(controller, body);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'item_42' },
      data: expect.objectContaining({
        mux_asset_id: 'asset_new',
        mux_asset_status: 'processing',
      }),
    });
  });

  it('acknowledges unknown event types without touching the DB', async () => {
    const { controller, update, updateMany } = build();
    const body = { type: 'video.live.connected' };
    const res = await deliver(controller, body);
    expect(res).toEqual({ received: true, ignored: 'video.live.connected' });
    expect(update).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe('POST /v1/webhooks/mux verifies the exact bytes Mux sent (rawBody: true)', () => {
  const SECRET = 'mux-raw-body-test-secret';
  const event = { type: 'video.asset.ready', data: { id: 'asset_raw', duration: 12.5 } };
  // The same event in Mux's own spacing and key order, not JSON.stringify's.
  const raw =
    '{\n  "data": { "duration": 12.5, "id": "asset_raw" },\n  "type": "video.asset.ready"\n}';
  const { prisma, updateMany } = mockPrisma();
  const mux = new MuxService(makeConfig({ MUX_WEBHOOK_SECRET: SECRET }));
  let app: INestApplication;
  let url: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [MuxWebhookController],
      providers: [
        { provide: MuxService, useValue: mux },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    await app.listen(0, '127.0.0.1');
    url = `${await app.getUrl()}/v1/webhooks/mux`;
  });
  afterAll(() => app.close());
  beforeEach(() => updateMany.mockClear());

  const post = (body: string, signature?: string) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (signature) headers['mux-signature'] = signature;
    return fetch(url, { method: 'POST', headers, body });
  };
  const tooOld = () => Math.floor(Date.now() / 1000) - 301;

  it('accepts a signed event whose spacing and key order differ from JSON.stringify', async () => {
    expect(JSON.parse(raw)).toEqual(event);
    expect(JSON.stringify(JSON.parse(raw))).not.toBe(raw);
    expect(JSON.stringify(event)).not.toBe(raw);
    expect((await post(raw, sign(raw, SECRET))).status).toBe(200);
    expect(updateMany).toHaveBeenCalledWith({
      where: { mux_asset_id: 'asset_raw' },
      data: {
        mux_asset_status: 'ready',
        mux_error_message: null,
        mux_duration_seconds: 12.5,
      },
    });
  });

  it.each<[string, () => Promise<{ status: number }>]>([
    ['a tampered body', () => post(raw.replace('asset_raw', 'asset_evil'), sign(raw, SECRET))],
    ["a timestamp past Mux's 5-minute tolerance", () => post(raw, sign(raw, SECRET, tooOld()))],
    ['a missing Mux-Signature header', () => post(raw)],
  ])('refuses %s with 400 and writes nothing', async (_name, send) => {
    expect((await send()).status).toBe(400);
    expect(updateMany).not.toHaveBeenCalled();
  });
});
