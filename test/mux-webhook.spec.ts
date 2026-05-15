import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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

function sign(payload: string, secret: string): string {
  const t = Math.floor(Date.now() / 1000);
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

  it('rejects invalid signatures with 400', async () => {
    const { controller } = build();
    const body = { type: 'video.asset.ready' };
    await expect(
      controller.receive(body, 'bogus-signature'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects when MUX_WEBHOOK_SECRET is unset', async () => {
    const mux = new MuxService(makeConfig({}));
    const { prisma } = mockPrisma();
    const controller = new MuxWebhookController(mux, prisma);
    const body = { type: 'video.asset.ready' };
    // Even a signature that "looks valid" against some secret fails because
    // the service-side secret is unset.
    const header = sign(JSON.stringify(body), 'random');
    await expect(controller.receive(body, header)).rejects.toBeInstanceOf(
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
    const header = sign(JSON.stringify(body), SECRET);
    const res = await controller.receive(body, header);
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
    const header = sign(JSON.stringify(body), SECRET);
    await controller.receive(body, header);
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
    const header = sign(JSON.stringify(body), SECRET);
    await controller.receive(body, header);
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
    const header = sign(JSON.stringify(body), SECRET);
    const res = await controller.receive(body, header);
    expect(res).toEqual({ received: true, ignored: 'video.live.connected' });
    expect(update).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });
});
