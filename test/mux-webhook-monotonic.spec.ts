// P0 audit fix — Mux webhook state machine must be monotonic.
//
// Before: an `errored` event arriving AFTER `ready` (Mux retries can
// deliver events out of order) cleared mux_playback_id and reverted
// status to `errored`, breaking playback for assets that were in fact
// fine. We now refuse to transition out of a terminal state on stale
// `errored` events, and dedupe on top-level event id.

import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { MuxService } from '../src/video/mux.service';
import { MuxWebhookController } from '../src/video/mux-webhook.controller';
import { PrismaService } from '../src/prisma.service';

const SECRET = 'whsec_mux_monotonic_test';

function makeConfig(): ConfigService {
  return {
    get<T = string>(key: string): T | undefined {
      if (key === 'MUX_WEBHOOK_SECRET') return SECRET as unknown as T;
      return undefined;
    },
  } as ConfigService;
}

function sign(payload: string): string {
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', SECRET).update(`${t}.${payload}`).digest('hex');
  return `t=${t},v1=${sig}`;
}

function build() {
  const updateMany = jest.fn(async () => ({ count: 1 }));
  const update = jest.fn(async () => undefined);
  const findUnique = jest.fn(async () => null);
  const prisma = {
    exerciseCatalogItem: { update, updateMany, findUnique },
  } as unknown as PrismaService;
  const controller = new MuxWebhookController(new MuxService(makeConfig()), prisma);
  return { controller, updateMany, update };
}

describe('Mux webhook monotonic state machine (P0)', () => {
  it('asset.errored only transitions from pre-terminal states — guard predicate', async () => {
    const { controller, updateMany } = build();
    const body = {
      id: 'evt_mono_1',
      type: 'video.asset.errored',
      data: { id: 'asset_x', errors: { type: 'invalid_input' } },
    };
    await controller.receive(body, sign(JSON.stringify(body)));
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          mux_asset_id: 'asset_x',
          // The crucial monotonic guard: status must be in a pre-terminal set.
          mux_asset_status: { in: ['uploading', 'processing', 'none'] },
        }),
      }),
    );
  });

  it('asset.errored that arrives after ready does NOT clear playback id', async () => {
    const { controller, updateMany } = build();
    // Simulate: row was updated to ready first, so updateMany matches 0
    // when we try to errored-transition from a pre-terminal status.
    (updateMany as jest.Mock).mockResolvedValueOnce({ count: 0 });
    const body = {
      id: 'evt_mono_2',
      type: 'video.asset.errored',
      data: { id: 'asset_ready', errors: { messages: ['stale'] } },
    };
    const res = await controller.receive(body, sign(JSON.stringify(body)));
    expect(res).toEqual({ received: true });
    // No second update call should clear the playback id.
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it('asset.ready re-delivery without playback_ids does NOT erase existing id', async () => {
    const { controller, updateMany } = build();
    const body = {
      id: 'evt_mono_3',
      type: 'video.asset.ready',
      // Second-push shape: no playback_ids.
      data: { id: 'asset_y' },
    };
    await controller.receive(body, sign(JSON.stringify(body)));
    expect(updateMany).toHaveBeenCalledTimes(1);
    const call = (updateMany as jest.Mock).mock.calls[0][0];
    expect(call.data).toEqual(
      expect.objectContaining({
        mux_asset_status: 'ready',
        mux_error_message: null,
      }),
    );
    // The patch object must not contain a mux_playback_id key at all
    // (so we don't write null over a previously-stored id).
    expect(call.data.mux_playback_id).toBeUndefined();
  });

  it('asset.created only advances pre-terminal states', async () => {
    const { controller, updateMany } = build();
    const body = {
      id: 'evt_mono_4',
      type: 'video.asset.created',
      data: { id: 'asset_z' },
    };
    await controller.receive(body, sign(JSON.stringify(body)));
    const call = (updateMany as jest.Mock).mock.calls[0][0];
    expect(call.where.mux_asset_status).toEqual({ in: ['uploading', 'none'] });
  });

  it('duplicate event ids are deduped (idempotency)', async () => {
    const { controller, updateMany } = build();
    const body = {
      id: 'evt_mono_dup_1',
      type: 'video.asset.ready',
      data: { id: 'asset_d', playback_ids: [{ id: 'pb_d', policy: 'public' as const }] },
    };
    await controller.receive(body, sign(JSON.stringify(body)));
    expect(updateMany).toHaveBeenCalledTimes(1);
    // Second delivery — same id, same signature shape, fresh timestamp.
    const res2 = await controller.receive(body, sign(JSON.stringify(body)));
    expect(res2).toEqual({ received: true, deduped: 'evt_mono_dup_1' });
    expect(updateMany).toHaveBeenCalledTimes(1);
  });
});
