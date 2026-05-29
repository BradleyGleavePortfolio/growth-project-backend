/**
 * PR-12 — CoachMediaMuxWebhookController tests.
 *
 * Covers:
 *   - signature verification rejection (real HMAC + rawBody — audit P1-2)
 *   - signature accepted when HMAC matches the rawBody bytes
 *   - signature rejected when payload is tampered after signing
 *   - rawBody missing → 400 (middleware misconfigured)
 *   - durable idempotency via MuxProcessedEvent (replay no-op) — committed case
 *   - audit P1-1: dedup row INSIDE $transaction — handler failure rolls back
 *     the dedup row, the retry succeeds
 *   - state machine: uploading → processing → ready
 *   - error-after-ready does NOT clobber playback id (monotonic guard)
 *   - unknown event types are 200'd
 *   - upload id that doesn't match a CoachMediaAsset row is a no-op
 *     (workout-demo path handled elsewhere)
 */

import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
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

/**
 * Prisma stub. The controller now wraps dedup + dispatch in
 * prisma.$transaction(async (tx) => ...). The stub's `$transaction`
 * passes the same client object as `tx` so the inner code uses the
 * same `rows` / `processed` maps. If `failHandlerUpdate` is true, the
 * `coachMediaAsset.update` throws — and the tx is "rolled back" by
 * removing any muxProcessedEvent row that was created inside.
 */
function makePrismaStub(opts: {
  initial?: Row[];
  failHandlerUpdate?: boolean;
} = {}) {
  const rows = [...(opts.initial ?? [])];
  const processed = new Map<
    string,
    { type: string; handler_completed_at: Date | null }
  >();

  const muxProcessedEvent = {
    create: jest.fn(
      async ({ data }: { data: { mux_event_id: string; type: string } }) => {
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
      },
    ),
    update: jest.fn(
      async ({
        where,
        data,
      }: {
        where: { mux_event_id: string };
        data: { handler_completed_at: Date };
      }) => {
        const existing = processed.get(where.mux_event_id);
        if (!existing) throw new Error('no event row');
        existing.handler_completed_at = data.handler_completed_at;
        return existing;
      },
    ),
  };

  const coachMediaAsset = {
    findUnique: jest.fn(
      async ({ where }: { where: { mux_upload_id?: string } }) => {
        if (where.mux_upload_id !== undefined) {
          return rows.find((r) => r.mux_upload_id === where.mux_upload_id) ?? null;
        }
        return null;
      },
    ),
    findFirst: jest.fn(
      async ({
        where,
      }: {
        where: { provider?: string; storage_key?: string; mux_upload_id?: string };
      }) => {
        return (
          rows.find(
            (r) =>
              (where.provider === undefined || r.provider === where.provider) &&
              (where.storage_key === undefined ||
                r.storage_key === where.storage_key) &&
              (where.mux_upload_id === undefined ||
                r.mux_upload_id === where.mux_upload_id),
          ) ?? null
        );
      },
    ),
    update: jest.fn(
      async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<Row>;
      }) => {
        if (opts.failHandlerUpdate) {
          throw new Error('simulated transient DB failure');
        }
        const r = rows.find((x) => x.id === where.id);
        if (!r) throw new Error('row not found');
        Object.assign(r, data);
        return r;
      },
    ),
  };

  // The tx client we hand to the callback exposes the same model
  // surface; on rollback we undo the muxProcessedEvent.create that ran
  // inside the failed transaction. This is the contract Prisma's real
  // $transaction provides — any throw inside the callback rolls back
  // all writes made through the tx client.
  const stub = {
    _rows: rows,
    _processed: processed,
    coachMediaAsset,
    muxProcessedEvent,
    $transaction: jest.fn(
      async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
        const inserted: string[] = [];
        const txMuxProcessedEvent = {
          create: async ({ data }: { data: { mux_event_id: string; type: string } }) => {
            const out = await muxProcessedEvent.create({ data });
            inserted.push(data.mux_event_id);
            return out;
          },
          update: muxProcessedEvent.update,
        };
        const tx = { coachMediaAsset, muxProcessedEvent: txMuxProcessedEvent };
        try {
          return await fn(tx);
        } catch (err) {
          // Roll back any muxProcessedEvent rows inserted inside the tx.
          for (const id of inserted) {
            processed.delete(id);
          }
          throw err;
        }
      },
    ),
  };
  return stub;
}

const TEST_SECRET = 'whsec_test_mux';

function makeMux(opts: { configSecret?: string } = {}) {
  const secret = opts.configSecret ?? TEST_SECRET;
  // Use the REAL MuxService — exercises the actual HMAC verify code path
  // (audit P1-2: forged-signature test must not mock the verifier).
  return new MuxService(
    new ConfigService({ MUX_WEBHOOK_SECRET: secret }),
  );
}

function signPayload(payload: string, secret: string = TEST_SECRET): {
  header: string;
  timestamp: number;
} {
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', secret)
    .update(`${t}.${payload}`, 'utf8')
    .digest('hex');
  return { header: `t=${t},v1=${sig}`, timestamp: t };
}

function makeReq(body: unknown): {
  rawBody: Buffer;
  parsed: unknown;
} {
  const rawBody = Buffer.from(JSON.stringify(body), 'utf8');
  return { rawBody, parsed: body };
}

function makeController(opts: {
  rows?: Row[];
  failHandlerUpdate?: boolean;
  configSecret?: string;
} = {}) {
  const prisma = makePrismaStub({
    initial: opts.rows,
    failHandlerUpdate: opts.failHandlerUpdate,
  });
  const mux = makeMux({ configSecret: opts.configSecret });
  const ctrl = new CoachMediaMuxWebhookController(
    mux,
    prisma as unknown as ConstructorParameters<typeof CoachMediaMuxWebhookController>[1],
  );
  return { ctrl, prisma, mux };
}

describe('CoachMediaMuxWebhookController — signature (real HMAC, rawBody)', () => {
  it('rejects a forged signature with 400 (real verifyWebhookSignature path)', async () => {
    const { ctrl } = makeController({
      rows: [makeRow({ mux_upload_id: 'upl-1' })],
    });
    const body = { id: 'evt-1', type: 'video.asset.ready', data: { id: 'asset-1' } };
    const req = makeReq(body);
    await expect(
      ctrl.receive(
        { rawBody: req.rawBody } as unknown as Parameters<typeof ctrl.receive>[0],
        body,
        'bogus-signature',
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('accepts a valid signature signed over rawBody (audit P1-2)', async () => {
    const { ctrl, prisma } = makeController({
      rows: [makeRow({ mux_upload_id: 'upl-1' })],
    });
    const body = {
      id: 'evt-ok',
      type: 'video.upload.asset_created',
      data: { id: 'upl-1', asset_id: 'as-1' },
    };
    const req = makeReq(body);
    const { header } = signPayload(req.rawBody.toString('utf8'));
    const out = await ctrl.receive(
      { rawBody: req.rawBody } as unknown as Parameters<typeof ctrl.receive>[0],
      body,
      header,
    );
    expect(out).toMatchObject({ received: true });
    expect(prisma._rows[0].status).toBe(STATUS_PROCESSING);
  });

  it('rejects when the body is tampered after the signature was computed (audit P1-2)', async () => {
    const { ctrl } = makeController({
      rows: [makeRow({ mux_upload_id: 'upl-1' })],
    });
    const originalBody = {
      id: 'evt-1',
      type: 'video.upload.asset_created',
      data: { id: 'upl-1', asset_id: 'as-1' },
    };
    const originalRaw = Buffer.from(JSON.stringify(originalBody), 'utf8');
    const { header } = signPayload(originalRaw.toString('utf8'));
    // Tamper: pass a different rawBody but the signature is for the original.
    const tamperedBody = {
      id: 'evt-1',
      type: 'video.upload.asset_created',
      data: { id: 'upl-1', asset_id: 'EVIL-ASSET' },
    };
    const tamperedRaw = Buffer.from(JSON.stringify(tamperedBody), 'utf8');
    await expect(
      ctrl.receive(
        { rawBody: tamperedRaw } as unknown as Parameters<typeof ctrl.receive>[0],
        tamperedBody,
        header,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('AUDIT P1-2: accepts a signature signed over rawBody when rawBody differs from JSON.stringify(parsed)', async () => {
    // This is the critical differentiator vs the pre-fix code (which
    // computed HMAC over JSON.stringify(body) — a re-serialisation that
    // does NOT byte-match the original transmitted bytes when there is
    // any whitespace/ordering divergence). We construct a rawBody with
    // extra whitespace + a key-order that JSON.stringify would not
    // produce, sign the rawBody, and verify the controller accepts it.
    // Against the old JSON.stringify(parsed) code this would fail
    // because JSON.stringify produces canonical no-space output.
    const { ctrl, prisma } = makeController({
      rows: [makeRow({ mux_upload_id: 'upl-1' })],
    });
    // Note: keys in a different order than the parsed JS object's
    // iteration order + extra whitespace.
    const rawBodyStr =
      '{ "type":  "video.upload.asset_created" ,\n  "id": "evt-raw",\n  "data": { "asset_id": "as-raw", "id": "upl-1" }\n}';
    const rawBody = Buffer.from(rawBodyStr, 'utf8');
    const parsed = JSON.parse(rawBodyStr);
    const { header } = signPayload(rawBodyStr);
    // Sanity: re-serialised form does NOT equal rawBodyStr (different
    // whitespace + key ordering).
    expect(JSON.stringify(parsed)).not.toBe(rawBodyStr);
    const out = await ctrl.receive(
      { rawBody } as unknown as Parameters<typeof ctrl.receive>[0],
      parsed,
      header,
    );
    expect(out).toMatchObject({ received: true });
    expect(prisma._rows[0].status).toBe(STATUS_PROCESSING);
  });

  it('rejects when rawBody is missing (middleware misconfigured)', async () => {
    const { ctrl } = makeController();
    const body = { id: 'x', type: 'video.asset.ready', data: { id: 'a' } };
    await expect(
      ctrl.receive(
        {} as unknown as Parameters<typeof ctrl.receive>[0],
        body,
        'whatever',
      ),
    ).rejects.toThrow(BadRequestException);
  });
});

// Helper for the non-signature tests below: signs the body so we can
// exercise the real signature path end-to-end.
async function callWithValidSig(
  ctrl: CoachMediaMuxWebhookController,
  body: unknown,
) {
  const req = makeReq(body);
  const { header } = signPayload(req.rawBody.toString('utf8'));
  return ctrl.receive(
    { rawBody: req.rawBody } as unknown as Parameters<typeof ctrl.receive>[0],
    body as Parameters<typeof ctrl.receive>[1],
    header,
  );
}

describe('CoachMediaMuxWebhookController — durable idempotency (audit P1-1)', () => {
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
    const first = await callWithValidSig(ctrl, event);
    expect(first).toMatchObject({ received: true });
    expect(prisma._rows[0].status).toBe(STATUS_PROCESSING);

    // Replay the same event id — must not advance state further and must
    // NOT re-run the handler. Reset the row to confirm the handler is
    // truly short-circuited on the second call.
    prisma._rows[0].status = STATUS_UPLOADING;
    const second = await callWithValidSig(ctrl, event);
    expect(second).toMatchObject({ received: true, deduped: 'evt-1' });
    expect(prisma._rows[0].status).toBe(STATUS_UPLOADING);
  });

  it('stamps handler_completed_at after successful processing', async () => {
    const { ctrl, prisma } = makeController({
      rows: [makeRow({ mux_upload_id: 'upl-1' })],
    });
    await callWithValidSig(ctrl, {
      id: 'evt-1',
      type: 'video.upload.asset_created',
      data: { id: 'upl-1', asset_id: 'as-1' },
    });
    expect(prisma._processed.get('evt-1')?.handler_completed_at).toBeInstanceOf(
      Date,
    );
  });

  it('AUDIT P1-1: handler failure rolls back the dedup row so Mux retry RE-runs the handler', async () => {
    // First receipt: the handler.update fails transiently. The dedup row
    // must NOT persist (it was inserted inside the same $transaction).
    const { ctrl, prisma } = makeController({
      rows: [
        makeRow({
          id: 'v1',
          mux_upload_id: 'upl-1',
          status: STATUS_PROCESSING,
          storage_key: 'mux-asset-99',
        }),
      ],
      failHandlerUpdate: true,
    });
    const event = {
      id: 'evt-fail',
      type: 'video.asset.ready',
      data: {
        id: 'mux-asset-99',
        playback_ids: [{ id: 'pb-abc', policy: 'public' as const }],
        duration: 42,
      },
    };
    await expect(callWithValidSig(ctrl, event)).rejects.toThrow();
    // CRITICAL: dedup row must not be persisted — rolled back with the tx.
    expect(prisma._processed.has('evt-fail')).toBe(false);
    // Row state must NOT have transitioned to ready (handler rolled back).
    expect(prisma._rows[0].status).toBe(STATUS_PROCESSING);

    // Now Mux retries the SAME event id. This time the handler.update
    // succeeds (simulate the transient blip clearing). Without the
    // tx-rollback fix, the dedup row from the first attempt would still
    // exist and Mux's retry would return `deduped` without re-running
    // the handler — the video would be stuck in PROCESSING forever.
    const { ctrl: ctrl2, prisma: prisma2 } = makeController({
      rows: [
        makeRow({
          id: 'v1',
          mux_upload_id: 'upl-1',
          status: STATUS_PROCESSING,
          storage_key: 'mux-asset-99',
        }),
      ],
      failHandlerUpdate: false,
    });
    // Seed the processed map AS IF the previous attempt had committed
    // its dedup row (this would be the BUG state). Here we leave it
    // empty to confirm the fix: a rolled-back dedup means the retry
    // sees an empty processed map and re-runs the handler.
    expect(prisma2._processed.size).toBe(0);
    const out = await callWithValidSig(ctrl2, event);
    expect(out).toMatchObject({ received: true });
    expect(prisma2._rows[0].status).toBe(STATUS_READY);
    expect(prisma2._rows[0].mux_playback_id).toBe('pb-abc');
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
    await callWithValidSig(ctrl, {
      id: 'evt-1',
      type: 'video.upload.asset_created',
      data: { id: 'upl-1', asset_id: 'mux-asset-99' },
    });
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
    await callWithValidSig(ctrl, {
      id: 'evt-2',
      type: 'video.asset.ready',
      data: {
        id: 'mux-asset-99',
        playback_ids: [{ id: 'pb-abc', policy: 'public' }],
        duration: 42.7,
      },
    });
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
    await callWithValidSig(ctrl, {
      id: 'evt-3',
      type: 'video.asset.errored',
      data: {
        id: 'mux-asset-99',
        errors: { type: 'fatal', messages: ['transcode failed'] },
      },
    });
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
    await callWithValidSig(ctrl, {
      id: 'evt-4',
      type: 'video.asset.errored',
      data: { id: 'mux-asset-99', errors: { type: 'fatal' } },
    });
    expect(prisma._rows[0].status).toBe(STATUS_READY);
    expect(prisma._rows[0].mux_playback_id).toBe('pb-good');
  });

  it('unknown event type is 200 with received:true', async () => {
    const { ctrl, prisma } = makeController({
      rows: [makeRow({ mux_upload_id: 'upl-1' })],
    });
    const out = await callWithValidSig(ctrl, {
      id: 'evt-x',
      type: 'video.fake.event',
      data: { id: 'mux-asset-1' },
    });
    expect(out).toMatchObject({ received: true });
    expect(prisma._rows[0].status).toBe(STATUS_UPLOADING);
  });

  it('an event whose upload id does not match any CoachMediaAsset is a no-op', async () => {
    const { ctrl } = makeController({ rows: [] });
    const out = await callWithValidSig(ctrl, {
      id: 'evt-5',
      type: 'video.upload.asset_created',
      data: { id: 'upl-orphan', asset_id: 'orphan-asset' },
    });
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
    await callWithValidSig(ctrl, {
      id: 'evt-6',
      type: 'video.asset.ready',
      data: { id: 'mux-asset-99', duration: 30 },
    });
    expect(prisma._rows[0].mux_playback_id).toBe('pb-existing');
    expect(prisma._rows[0].status).toBe(STATUS_READY);
  });
});
