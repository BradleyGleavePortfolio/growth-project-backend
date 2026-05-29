/**
 * PR-12 — CoachMediaMuxWebhookController tests.
 *
 * Covers:
 *   - signature verification rejection
 *   - durable idempotency via MuxProcessedEvent (replay no-op)
 *   - state machine: uploading → processing → ready
 *   - error-after-ready does NOT clobber playback id (monotonic guard)
 *   - unknown event types are 200'd
 *   - upload id that doesn't match a CoachMediaAsset row is a no-op
 *     (workout-demo path handled elsewhere)
 */

import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { CoachMediaMuxWebhookController } from '../src/coach-media/coach-media-mux-webhook.controller';
import { MuxService } from '../src/video/mux.service';
import {
  STATUS_ERRORED,
  STATUS_PROCESSING,
  STATUS_READY,
  STATUS_UPLOADING,
} from '../src/coach-media/coach-media.service';

type Row = {
  id: string;
  provider: string;
  storage_key: string;
  mux_upload_id: string | null;
  mux_playback_id: string | null;
  status: string;
  mux_error_message: string | null;
  duration_sec: number | null;
};

function makeRow(overrides: Partial<Row> = {}): Row {
  return {
    id: 'asset-v1',
    provider: 'mux',
    storage_key: 'upl-1',
    mux_upload_id: 'upl-1',
    mux_playback_id: null,
    status: STATUS_UPLOADING,
    mux_error_message: null,
    duration_sec: null,
    ...overrides,
  };
}

function makePrismaStub(initial: Row[] = []) {
  const rows = [...initial];
  const processed = new Map<string, { type: string; handler_completed_at: Date | null }>();
  return {
    _rows: rows,
    _processed: processed,
    coachMediaAsset: {
      findUnique: jest.fn(async ({ where }: { where: { mux_upload_id?: string } }) => {
        if (where.mux_upload_id !== undefined) {
          return rows.find((r) => r.mux_upload_id === where.mux_upload_id) ?? null;
        }
        return null;
      }),
      findFirst: jest.fn(
        async ({ where }: { where: { provider?: string; storage_key?: string } }) => {
          return (
            rows.find(
              (r) =>
                (where.provider === undefined || r.provider === where.provider) &&
                (where.storage_key === undefined ||
                  r.storage_key === where.storage_key),
            ) ?? null
          );
        },
      ),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const r = rows.find((x) => x.id === where.id);
        if (!r) throw new Error('row not found');
        Object.assign(r, data);
        return r;
      }),
    },
    muxProcessedEvent: {
      create: jest.fn(async ({ data }: { data: { mux_event_id: string; type: string } }) => {
        if (processed.has(data.mux_event_id)) {
          throw new Prisma.PrismaClientKnownRequestError('unique', {
            code: 'P2002',
            clientVersion: 'test',
          });
        }
        processed.set(data.mux_event_id, {
          type: data.type,
          handler_completed_at: null,
        });
        return { mux_event_id: data.mux_event_id };
      }),
      update: jest.fn(
        async ({ where, data }: { where: { mux_event_id: string }; data: { handler_completed_at: Date } }) => {
          const existing = processed.get(where.mux_event_id);
          if (!existing) throw new Error('no event row');
          existing.handler_completed_at = data.handler_completed_at;
          return existing;
        },
      ),
    },
  };
}

function makeMux(opts: { signatureValid?: boolean } = {}) {
  // Use the real MuxService class so we exercise the same code path the
  // controller does — but stub out verifyWebhookSignature so we don't
  // need a live HMAC secret.
  const mux = new MuxService(new ConfigService({}));
  jest
    .spyOn(mux, 'verifyWebhookSignature')
    .mockImplementation(() => opts.signatureValid ?? true);
  return mux;
}

function makeController(opts: {
  rows?: Row[];
  signatureValid?: boolean;
} = {}) {
  const prisma = makePrismaStub(opts.rows ?? []);
  const mux = makeMux({ signatureValid: opts.signatureValid });
  const ctrl = new CoachMediaMuxWebhookController(
    mux,
    prisma as unknown as ConstructorParameters<typeof CoachMediaMuxWebhookController>[1],
  );
  return { ctrl, prisma, mux };
}

describe('CoachMediaMuxWebhookController — signature', () => {
  it('rejects a forged signature with 400', async () => {
    const { ctrl } = makeController({ signatureValid: false });
    await expect(
      ctrl.receive(
        { id: 'evt-1', type: 'video.asset.ready', data: { id: 'asset-1' } },
        'bogus-signature',
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('accepts a valid signature', async () => {
    const { ctrl } = makeController({
      rows: [makeRow({ mux_upload_id: 'upl-1' })],
      signatureValid: true,
    });
    const out = await ctrl.receive(
      {
        id: 'evt-1',
        type: 'video.upload.asset_created',
        data: { id: 'upl-1', asset_id: 'as-1' },
      },
      't=1,v1=ok',
    );
    expect(out).toMatchObject({ received: true });
  });
});

describe('CoachMediaMuxWebhookController — durable idempotency', () => {
  it('deduplicates a replayed event id (P2002) and returns deduped marker', async () => {
    const { ctrl, prisma } = makeController({
      rows: [
        makeRow({
          id: 'a1',
          mux_upload_id: 'upl-1',
          status: STATUS_UPLOADING,
        }),
      ],
    });
    const event = {
      id: 'evt-1',
      type: 'video.upload.asset_created',
      data: { id: 'upl-1', asset_id: 'as-1' },
    };
    const first = await ctrl.receive(event, 't=1,v1=ok');
    expect(first).toMatchObject({ received: true });
    expect(prisma._rows[0].status).toBe(STATUS_PROCESSING);

    // Replay the same event id — must not advance state further and must
    // NOT re-run the handler. Reset the row to confirm.
    prisma._rows[0].status = STATUS_UPLOADING;
    const second = await ctrl.receive(event, 't=1,v1=ok');
    expect(second).toMatchObject({ received: true, deduped: 'evt-1' });
    // The handler did NOT run → state remained at the reset value.
    expect(prisma._rows[0].status).toBe(STATUS_UPLOADING);
  });

  it('stamps handler_completed_at after successful processing', async () => {
    const { ctrl, prisma } = makeController({
      rows: [makeRow({ mux_upload_id: 'upl-1' })],
    });
    await ctrl.receive(
      {
        id: 'evt-1',
        type: 'video.upload.asset_created',
        data: { id: 'upl-1', asset_id: 'as-1' },
      },
      't=1,v1=ok',
    );
    expect(prisma._processed.get('evt-1')?.handler_completed_at).toBeInstanceOf(
      Date,
    );
  });
});

describe('CoachMediaMuxWebhookController — state machine', () => {
  it('video.upload.asset_created flips uploading → processing + stores asset id on storage_key', async () => {
    const { ctrl, prisma } = makeController({
      rows: [
        makeRow({
          id: 'v1',
          mux_upload_id: 'upl-1',
          status: STATUS_UPLOADING,
          storage_key: 'upl-1',
        }),
      ],
    });
    await ctrl.receive(
      {
        id: 'evt-1',
        type: 'video.upload.asset_created',
        data: { id: 'upl-1', asset_id: 'mux-asset-99' },
      },
      't=1,v1=ok',
    );
    expect(prisma._rows[0].status).toBe(STATUS_PROCESSING);
    expect(prisma._rows[0].storage_key).toBe('mux-asset-99');
  });

  it('video.asset.ready flips processing → ready + stores playback id + duration', async () => {
    const { ctrl, prisma } = makeController({
      rows: [
        makeRow({
          id: 'v1',
          mux_upload_id: 'upl-1',
          storage_key: 'mux-asset-99',
          status: STATUS_PROCESSING,
        }),
      ],
    });
    await ctrl.receive(
      {
        id: 'evt-2',
        type: 'video.asset.ready',
        data: {
          id: 'mux-asset-99',
          playback_ids: [{ id: 'pb-abc', policy: 'public' }],
          duration: 42.7,
        },
      },
      't=1,v1=ok',
    );
    expect(prisma._rows[0].status).toBe(STATUS_READY);
    expect(prisma._rows[0].mux_playback_id).toBe('pb-abc');
    expect(prisma._rows[0].duration_sec).toBe(43); // rounded
  });

  it('video.asset.errored from a pre-terminal state sets errored + nulls playback id', async () => {
    const { ctrl, prisma } = makeController({
      rows: [
        makeRow({
          id: 'v1',
          mux_upload_id: 'upl-1',
          storage_key: 'mux-asset-99',
          status: STATUS_PROCESSING,
          mux_playback_id: null,
        }),
      ],
    });
    await ctrl.receive(
      {
        id: 'evt-3',
        type: 'video.asset.errored',
        data: {
          id: 'mux-asset-99',
          errors: { type: 'fatal', messages: ['transcode failed'] },
        },
      },
      't=1,v1=ok',
    );
    expect(prisma._rows[0].status).toBe(STATUS_ERRORED);
    expect(prisma._rows[0].mux_error_message).toContain('transcode failed');
  });

  it('video.asset.errored AFTER video.asset.ready does NOT clobber playback id (monotonic guard)', async () => {
    const { ctrl, prisma } = makeController({
      rows: [
        makeRow({
          id: 'v1',
          mux_upload_id: 'upl-1',
          storage_key: 'mux-asset-99',
          status: STATUS_READY,
          mux_playback_id: 'pb-good',
        }),
      ],
    });
    await ctrl.receive(
      {
        id: 'evt-4',
        type: 'video.asset.errored',
        data: { id: 'mux-asset-99', errors: { type: 'fatal' } },
      },
      't=1,v1=ok',
    );
    // status stays READY; playback id stays intact.
    expect(prisma._rows[0].status).toBe(STATUS_READY);
    expect(prisma._rows[0].mux_playback_id).toBe('pb-good');
  });

  it('unknown event type is 200 with received:true', async () => {
    const { ctrl, prisma } = makeController({
      rows: [makeRow({ mux_upload_id: 'upl-1' })],
    });
    const out = await ctrl.receive(
      { id: 'evt-x', type: 'video.fake.event', data: { id: 'mux-asset-1' } },
      't=1,v1=ok',
    );
    expect(out).toMatchObject({ received: true });
    // No row should have moved status.
    expect(prisma._rows[0].status).toBe(STATUS_UPLOADING);
  });

  it('an event whose upload id does not match any CoachMediaAsset is a no-op', async () => {
    // No rows seeded — webhook still must 200 (this event belongs to the
    // workout-demo path and is handled by src/video/mux-webhook.controller).
    const { ctrl } = makeController({ rows: [] });
    const out = await ctrl.receive(
      {
        id: 'evt-5',
        type: 'video.upload.asset_created',
        data: { id: 'upl-orphan', asset_id: 'orphan-asset' },
      },
      't=1,v1=ok',
    );
    expect(out).toMatchObject({ received: true });
  });

  it('video.asset.ready preserves an existing playback id when re-delivered without playback_ids', async () => {
    const { ctrl, prisma } = makeController({
      rows: [
        makeRow({
          id: 'v1',
          mux_upload_id: 'upl-1',
          storage_key: 'mux-asset-99',
          status: STATUS_READY,
          mux_playback_id: 'pb-existing',
        }),
      ],
    });
    await ctrl.receive(
      {
        id: 'evt-6',
        type: 'video.asset.ready',
        data: { id: 'mux-asset-99', duration: 30 },
      },
      't=1,v1=ok',
    );
    // playback id unchanged (re-delivery without playback_ids must NOT
    // null it out)
    expect(prisma._rows[0].mux_playback_id).toBe('pb-existing');
    expect(prisma._rows[0].status).toBe(STATUS_READY);
  });
});
