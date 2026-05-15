import { NotFoundException } from '@nestjs/common';
import { ExerciseCatalogService } from '../src/exercise-catalog/exercise-catalog.service';
import { MuxDisabledError } from '../src/video/mux.errors';
import { MuxService } from '../src/video/mux.service';
import { PrismaService } from '../src/prisma.service';

function makeRow(over: Partial<any> = {}) {
  return {
    id: 'item_1',
    slug: 'barbell-bench-press',
    name: 'Barbell Bench Press',
    category: 'push',
    primary_muscle: 'pectorals',
    secondary_muscles: ['triceps', 'front delts'],
    equipment: ['barbell'],
    difficulty: 'beginner',
    instructions: ['Lie down', 'Press up'],
    mux_asset_id: null,
    mux_playback_id: null,
    mux_playback_policy: 'public',
    mux_asset_status: 'none',
    mux_duration_seconds: null,
    mux_error_message: null,
    mux_upload_id: null,
    ...over,
  };
}

function mockPrisma(rows: any[]): PrismaService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const findFirst = jest.fn(async ({ where }: any) => {
    const list = Array.isArray(where.OR) ? where.OR : [where];
    for (const cand of list) {
      const found = rows.find(
        (r) => (cand.id && r.id === cand.id) || (cand.slug && r.slug === cand.slug),
      );
      if (found) return found;
    }
    return null;
  });
  const findMany = jest.fn(async () => rows);
  const count = jest.fn(async () => rows.length);
  const update = jest.fn(async ({ where, data }: any) => ({
    ...rows.find((r) => r.id === where.id),
    ...data,
  }));
  return {
    exerciseCatalogItem: { findFirst, findMany, count, update },
    $transaction: async (q: any[]) => Promise.all(q),
  } as unknown as PrismaService;
}

function mockMux(over: Partial<MuxService> = {}): MuxService {
  return {
    isConfigured: () => false,
    mintPlaybackUrl: ({ playbackId }: any) => `https://stream.mux.com/${playbackId}.m3u8`,
    createDirectUpload: async () => ({ uploadId: 'upl_x', url: 'https://upload.example/u' }),
    getAsset: async () => ({
      id: 'asset_x',
      status: 'ready',
      playbackIds: [{ id: 'pb_x', policy: 'public' }],
      duration: 12.5,
    }),
    ...over,
  } as unknown as MuxService;
}

describe('ExerciseCatalogService', () => {
  it('list returns DTO shape with muxPlaybackId on each item', async () => {
    const row = makeRow({ mux_playback_id: 'pb_a', mux_asset_status: 'ready' });
    const svc = new ExerciseCatalogService(mockPrisma([row]), mockMux());
    const out = await svc.list({});
    expect(out.total).toBe(1);
    expect(out.items[0]).toMatchObject({
      id: 'item_1',
      slug: 'barbell-bench-press',
      muxPlaybackId: 'pb_a',
      equipment: ['barbell'],
      secondaryMuscles: ['triceps', 'front delts'],
    });
  });

  it('detail returns playbackUrl=null when no muxPlaybackId is attached', async () => {
    const svc = new ExerciseCatalogService(mockPrisma([makeRow()]), mockMux());
    const detail = await svc.getByIdOrSlug('item_1');
    expect(detail.playbackUrl).toBeNull();
    expect(detail.muxPlaybackId).toBeNull();
  });

  it('detail returns playbackUrl=null when asset is uploading (not yet ready)', async () => {
    const row = makeRow({ mux_playback_id: 'pb_a', mux_asset_status: 'uploading' });
    const svc = new ExerciseCatalogService(mockPrisma([row]), mockMux());
    const detail = await svc.getByIdOrSlug('item_1');
    expect(detail.playbackUrl).toBeNull();
  });

  it('detail mints public HLS URL when ready', async () => {
    const row = makeRow({
      mux_playback_id: 'pb_42',
      mux_asset_status: 'ready',
      mux_playback_policy: 'public',
    });
    const svc = new ExerciseCatalogService(mockPrisma([row]), mockMux());
    const detail = await svc.getByIdOrSlug('barbell-bench-press');
    expect(detail.playbackUrl).toBe('https://stream.mux.com/pb_42.m3u8');
  });

  it('detail returns null playbackUrl when signed policy lacks signing key (no fake URL)', async () => {
    const row = makeRow({
      mux_playback_id: 'pb_signed',
      mux_asset_status: 'ready',
      mux_playback_policy: 'signed',
    });
    const mux = mockMux({
      mintPlaybackUrl: () => {
        throw new MuxDisabledError('signing key missing');
      },
    });
    const svc = new ExerciseCatalogService(mockPrisma([row]), mux);
    const detail = await svc.getByIdOrSlug('item_1');
    expect(detail.playbackUrl).toBeNull();
  });

  it('getByIdOrSlug throws 404 for unknown slug', async () => {
    const svc = new ExerciseCatalogService(mockPrisma([]), mockMux());
    await expect(svc.getByIdOrSlug('does-not-exist')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('createUpload bubbles MuxDisabledError when Mux is unconfigured', async () => {
    const mux = mockMux({
      createDirectUpload: async () => {
        throw new MuxDisabledError('Set MUX_TOKEN_ID and MUX_TOKEN_SECRET');
      },
    });
    const svc = new ExerciseCatalogService(mockPrisma([makeRow()]), mux);
    await expect(svc.createUpload('item_1')).rejects.toBeInstanceOf(MuxDisabledError);
  });

  it('attachAsset persists Mux state and reports ready', async () => {
    const mux = mockMux({
      getAsset: async () => ({
        id: 'asset_99',
        status: 'ready',
        playbackIds: [{ id: 'pb_99', policy: 'public' }],
        duration: 8.2,
      }),
    });
    const svc = new ExerciseCatalogService(mockPrisma([makeRow()]), mux);
    const out = await svc.attachAsset('item_1', 'asset_99');
    expect(out.playbackUrl).toBe('https://stream.mux.com/pb_99.m3u8');
    expect(out.muxPlaybackId).toBe('pb_99');
  });

  it('getPlaybackInfo returns null for unknown id (caller decides UI fallback)', async () => {
    const svc = new ExerciseCatalogService(mockPrisma([]), mockMux());
    const out = await svc.getPlaybackInfo('seed:push-001');
    expect(out).toBeNull();
  });
});
