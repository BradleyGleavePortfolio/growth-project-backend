// P0 audit fix — exercise catalog playback URL authorization.
//
// Before: any authenticated JWT could mint a signed HLS URL for any
// exercise, transferable for ~1h. The detail endpoint now gates
// signed-policy URLs to coach/owner OR a student with an assignment
// referencing the catalog row. Public-policy items still return the URL
// unconditionally — Mux serves them without a token.

import { ExerciseCatalogService } from '../src/exercise-catalog/exercise-catalog.service';
import { MuxService } from '../src/video/mux.service';
import { PrismaService } from '../src/prisma.service';

function makeRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'item_signed',
    slug: 'pushup-signed',
    name: 'Pushup',
    category: 'push',
    primary_muscle: 'chest',
    secondary_muscles: [],
    equipment: [],
    difficulty: 'beginner',
    instructions: [],
    mux_asset_id: 'a_1',
    mux_playback_id: 'pb_signed_1',
    mux_playback_policy: 'signed',
    mux_asset_status: 'ready',
    mux_duration_seconds: 10,
    mux_error_message: null,
    mux_upload_id: null,
    ...over,
  };
}

function mockPrisma(opts: {
  row: ReturnType<typeof makeRow>;
  hasAssignment?: boolean;
}): PrismaService {
  return {
    exerciseCatalogItem: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findFirst: jest.fn(async ({ where }: any) => {
        const list = Array.isArray(where.OR) ? where.OR : [where];
        for (const cand of list) {
          if (
            (cand.id && cand.id === opts.row.id) ||
            (cand.slug && cand.slug === opts.row.slug)
          )
            return opts.row;
        }
        return null;
      }),
    },
    clientWorkoutAssignment: {
      findFirst: jest.fn(async () => (opts.hasAssignment ? { id: 'asn_1' } : null)),
    },
  } as unknown as PrismaService;
}

function mockMux(): MuxService {
  return {
    mintPlaybackUrl: ({ playbackId, policy }: { playbackId: string; policy: string }) =>
      `https://stream.mux.com/${playbackId}.m3u8?policy=${policy}`,
  } as unknown as MuxService;
}

describe('ExerciseCatalogService playback URL authz (P0)', () => {
  it('public-policy item: any authed caller (incl. student w/o assignment) gets the URL', async () => {
    const row = makeRow({ mux_playback_policy: 'public', mux_playback_id: 'pb_public' });
    const svc = new ExerciseCatalogService(
      mockPrisma({ row, hasAssignment: false }),
      mockMux(),
    );
    const detail = await svc.getByIdOrSlug('item_signed', {
      userId: 'u_student',
      role: 'student',
    });
    expect(detail.playbackUrl).toBe('https://stream.mux.com/pb_public.m3u8?policy=public');
  });

  it('signed-policy item: coach gets the URL', async () => {
    const row = makeRow();
    const svc = new ExerciseCatalogService(
      mockPrisma({ row, hasAssignment: false }),
      mockMux(),
    );
    const detail = await svc.getByIdOrSlug('item_signed', {
      userId: 'u_coach',
      role: 'coach',
    });
    expect(detail.playbackUrl).toBe('https://stream.mux.com/pb_signed_1.m3u8?policy=signed');
  });

  it('signed-policy item: owner gets the URL', async () => {
    const row = makeRow();
    const svc = new ExerciseCatalogService(
      mockPrisma({ row, hasAssignment: false }),
      mockMux(),
    );
    const detail = await svc.getByIdOrSlug('item_signed', {
      userId: 'u_owner',
      role: 'owner',
    });
    expect(detail.playbackUrl).toContain('pb_signed_1');
  });

  it('signed-policy item: student WITH an active assignment gets the URL', async () => {
    const row = makeRow();
    const svc = new ExerciseCatalogService(
      mockPrisma({ row, hasAssignment: true }),
      mockMux(),
    );
    const detail = await svc.getByIdOrSlug('item_signed', {
      userId: 'u_student',
      role: 'student',
    });
    expect(detail.playbackUrl).toContain('pb_signed_1');
  });

  it('signed-policy item: student WITHOUT an assignment gets null (P0 fix)', async () => {
    const row = makeRow();
    const svc = new ExerciseCatalogService(
      mockPrisma({ row, hasAssignment: false }),
      mockMux(),
    );
    const detail = await svc.getByIdOrSlug('item_signed', {
      userId: 'u_student',
      role: 'student',
    });
    expect(detail.playbackUrl).toBeNull();
    // But the catalog metadata still renders so the browse experience
    // is not broken.
    expect(detail.muxPlaybackId).toBe('pb_signed_1');
  });

  it('omitting the caller (admin/test backdoor) still mints — backwards-compat', async () => {
    const row = makeRow();
    const svc = new ExerciseCatalogService(
      mockPrisma({ row, hasAssignment: false }),
      mockMux(),
    );
    const detail = await svc.getByIdOrSlug('item_signed');
    expect(detail.playbackUrl).toContain('pb_signed_1');
  });
});
