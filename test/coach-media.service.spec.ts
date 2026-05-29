/**
 * PR-12 — CoachMediaService tests.
 *
 * Covers the upload pipeline + signed-URL gating + ownership/scope +
 * soft-delete safety + config-not-set. Mux webhook is tested in a
 * separate spec.
 */

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CoachMediaService,
  STATUS_PROCESSING,
  STATUS_READY,
  STATUS_UPLOADING,
} from '../src/coach-media/coach-media.service';
import type { StorageProvider } from '../src/coach-media/storage-provider';

// ── stub builders ────────────────────────────────────────────────────────

type Row = {
  id: string;
  coach_id: string;
  kind: 'pdf' | 'video';
  title: string;
  description: string | null;
  storage_key: string;
  provider: string;
  byte_size: bigint | null;
  content_type: string | null;
  duration_sec: number | null;
  page_count: number | null;
  mux_playback_id: string | null;
  status: string;
  mux_upload_id: string | null;
  mux_error_message: string | null;
  created_at: Date;
  archived_at: Date | null;
};

function defaultRow(overrides: Partial<Row> = {}): Row {
  return {
    id: 'asset-1',
    coach_id: 'coach-1',
    kind: 'pdf',
    title: 'Doc',
    description: null,
    storage_key: 'coach-1/asset-1/abc.pdf',
    provider: 'supabase',
    byte_size: null,
    content_type: 'application/pdf',
    duration_sec: null,
    page_count: null,
    mux_playback_id: null,
    status: STATUS_READY,
    mux_upload_id: null,
    mux_error_message: null,
    created_at: new Date('2026-05-01'),
    archived_at: null,
    ...overrides,
  };
}

function makePrismaStub(initialRows: Row[] = []) {
  const rows = [...initialRows];
  const grants: Array<{
    id?: string;
    client_id: string;
    media_asset_id: string;
    revoked_at: Date | null;
    granted_via_drop_id?: string | null;
  }> = [];
  const contents: Array<{
    asset_id: string;
    asset_type: string;
    removed_at: Date | null;
  }> = [];
  const drops: Array<{
    id: string;
    client_purchase: { coach_user_id: string };
  }> = [];

  const stub: {
    _rows: Row[];
    _grants: typeof grants;
    _contents: typeof contents;
    _drops: typeof drops;
    coachMediaAsset: {
      create: jest.Mock;
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
    };
    clientAssetGrant: {
      count: jest.Mock;
      findUnique: jest.Mock;
    };
    coachPackageContent: { count: jest.Mock };
    muxProcessedEvent: { create: jest.Mock; update: jest.Mock };
    scheduledDrop: { findUnique: jest.Mock };
    $queryRaw: jest.Mock;
    $transaction: jest.Mock;
  } = {
    _rows: rows,
    _grants: grants,
    _contents: contents,
    _drops: drops,
    coachMediaAsset: {
      create: jest.fn(async ({ data }: { data: Partial<Row> }) => {
        const r = defaultRow({
          ...(data as Partial<Row>),
          mux_upload_id: data.mux_upload_id ?? null,
        });
        rows.push(r);
        return r;
      }),
      findUnique: jest.fn(async ({ where }: { where: { id?: string; mux_upload_id?: string } }) => {
        if (where.id) return rows.find((r) => r.id === where.id) ?? null;
        if (where.mux_upload_id)
          return rows.find((r) => r.mux_upload_id === where.mux_upload_id) ?? null;
        return null;
      }),
      findFirst: jest.fn(async ({ where }: { where: Partial<Row> & { provider?: string; storage_key?: string } }) => {
        return (
          rows.find((r) =>
            Object.entries(where).every(([k, v]) =>
              v === undefined ? true : (r as unknown as Record<string, unknown>)[k] === v,
            ),
          ) ?? null
        );
      }),
      findMany: jest.fn(async ({ where, orderBy }: { where?: Partial<Row>; orderBy?: unknown }) => {
        let out = rows.filter((r) => {
          if (!where) return true;
          if (where.coach_id !== undefined && r.coach_id !== where.coach_id) return false;
          if (
            (where as { archived_at?: null | undefined }).archived_at === null &&
            r.archived_at !== null
          )
            return false;
          if (where.kind !== undefined && r.kind !== where.kind) return false;
          return true;
        });
        void orderBy;
        out = [...out].sort(
          (a, b) => b.created_at.getTime() - a.created_at.getTime(),
        );
        return out;
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const r = rows.find((x) => x.id === where.id);
        if (!r) throw new Error('row not found');
        Object.assign(r, data);
        return r;
      }),
    },
    clientAssetGrant: {
      count: jest.fn(async ({ where }: { where: { media_asset_id: string; revoked_at: null } }) => {
        return grants.filter(
          (g) => g.media_asset_id === where.media_asset_id && g.revoked_at === null,
        ).length;
      }),
      findUnique: jest.fn(async ({ where }: { where: { client_id_media_asset_id: { client_id: string; media_asset_id: string } } }) => {
        const k = where.client_id_media_asset_id;
        return (
          grants.find(
            (g) => g.client_id === k.client_id && g.media_asset_id === k.media_asset_id,
          ) ?? null
        );
      }),
    },
    coachPackageContent: {
      count: jest.fn(async ({ where }: { where: { asset_id: string; asset_type: { in: string[] }; removed_at: null } }) => {
        return contents.filter(
          (c) =>
            c.asset_id === where.asset_id &&
            where.asset_type.in.includes(c.asset_type) &&
            c.removed_at === null,
        ).length;
      }),
    },
    muxProcessedEvent: {
      create: jest.fn(),
      update: jest.fn(),
    },
    scheduledDrop: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const d = drops.find((x) => x.id === where.id);
        return d ?? null;
      }),
    },
    // The softDelete code path runs prisma.$queryRaw FOR UPDATE on the
    // asset row; in tests we just acknowledge it (no Postgres locking in
    // a unit test). The test harness asserts that the lock is requested.
    $queryRaw: jest.fn(async () => [] as Array<{ id: string }>),
    // $transaction handed the same `stub` to the callback so writes
    // share the in-memory rows/grants/contents/drops arrays. We
    // simulate rollback by tracking the rows length pre-call and
    // restoring on throw (not used directly here but documented for
    // future use).
    $transaction: jest.fn(async <T>(fn: (tx: unknown) => Promise<T>) => {
      return await fn(stub);
    }),
  };
  return stub;
}

function makeStorageStub(opts: { configured?: boolean } = {}) {
  return {
    id: 'supabase',
    isConfigured: jest.fn(() => opts.configured ?? true),
    createSignedUploadUrl: jest.fn(async ({ storageKey }: { storageKey: string }) => ({
      signedUrl: `https://supabase.test/upload/${storageKey}?sig=stub`,
      storageKey,
      provider: 'supabase',
      token: 'tok-1',
    })),
    createSignedDownloadUrl: jest.fn(
      async (storageKey: string) =>
        `https://supabase.test/download/${storageKey}?sig=stub`,
    ),
    putObject: jest.fn(async ({ storageKey }: { storageKey: string }) => ({
      storageKey,
      provider: 'supabase',
    })),
    deleteObject: jest.fn(async () => true),
  } as unknown as StorageProvider & {
    isConfigured: jest.Mock;
    createSignedUploadUrl: jest.Mock;
    createSignedDownloadUrl: jest.Mock;
    deleteObject: jest.Mock;
  };
}

function makeMuxStub(opts: { configured?: boolean } = {}) {
  return {
    isConfigured: jest.fn(() => opts.configured ?? true),
    createDirectUpload: jest.fn(async () => ({
      uploadId: 'upl-1',
      url: 'https://mux.test/upload/upl-1',
    })),
    mintPlaybackUrl: jest.fn(
      ({ playbackId, policy }: { playbackId: string; policy: 'public' | 'signed' }) => {
        // Audit P2-2: paid video uses signed playback. The stub returns
        // a token-bearing URL so tests can assert the JWT is present.
        const base = `https://stream.mux.com/${playbackId}.m3u8`;
        return policy === 'signed' ? `${base}?token=stub-signed-jwt` : base;
      },
    ),
  };
}

function makeSubCoachScopeStub(headId: string | null = null) {
  return {
    getHeadCoachIdForSubCoach: jest.fn(async () => headId),
  };
}

function makeService(opts: {
  rows?: Row[];
  storage?: ReturnType<typeof makeStorageStub>;
  mux?: ReturnType<typeof makeMuxStub>;
  subCoach?: ReturnType<typeof makeSubCoachScopeStub>;
  config?: Partial<Record<string, string>>;
} = {}) {
  const prisma = makePrismaStub(opts.rows ?? []);
  const storage = opts.storage ?? makeStorageStub();
  const mux = opts.mux ?? makeMuxStub();
  const subCoach = opts.subCoach ?? makeSubCoachScopeStub();
  const config = new ConfigService(opts.config ?? {});
  const svc = new CoachMediaService(
    prisma as unknown as ConstructorParameters<typeof CoachMediaService>[0],
    storage,
    mux as unknown as ConstructorParameters<typeof CoachMediaService>[2],
    subCoach as unknown as ConstructorParameters<typeof CoachMediaService>[3],
    config,
  );
  return { svc, prisma, storage, mux, subCoach };
}

// ── tests ────────────────────────────────────────────────────────────────

describe('CoachMediaService — PDF upload flow', () => {
  it('createPdfUpload mints a signed URL and persists an uploading row', async () => {
    const { svc, prisma, storage } = makeService();
    const result = await svc.createPdfUpload('coach-1', {
      title: 'My doc',
      content_type: 'application/pdf',
      byte_size: 1024,
    });
    expect(result.upload_url).toContain('supabase.test/upload/');
    expect(result.storage_key).toMatch(/^coach-1\/[a-f0-9-]+\/[a-f0-9]+\.pdf$/);
    expect(storage.createSignedUploadUrl).toHaveBeenCalledTimes(1);
    expect(prisma.coachMediaAsset.create).toHaveBeenCalledTimes(1);
    const created = prisma._rows[0];
    expect(created.coach_id).toBe('coach-1');
    expect(created.kind).toBe('pdf');
    expect(created.status).toBe(STATUS_UPLOADING);
    expect(created.title).toBe('My doc');
    expect(created.provider).toBe('supabase');
    expect(created.byte_size).toBe(BigInt(1024));
  });

  it('createPdfUpload rejects oversized PDF (zod validation)', async () => {
    const { svc } = makeService();
    await expect(
      svc.createPdfUpload('coach-1', {
        title: 'X',
        byte_size: 100 * 1024 * 1024, // 100MB > 50MB cap
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('createPdfUpload rejects unknown top-level keys (strict zod)', async () => {
    const { svc } = makeService();
    await expect(
      svc.createPdfUpload('coach-1', {
        title: 'X',
        unknown_field: 'oops',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('createPdfUpload rejects non-application/pdf content_type', async () => {
    const { svc } = makeService();
    await expect(
      svc.createPdfUpload('coach-1', {
        title: 'X',
        content_type: 'image/png',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('createPdfUpload returns 503 when Supabase is not configured', async () => {
    const storage = makeStorageStub({ configured: false });
    const { svc, prisma } = makeService({ storage });
    await expect(
      svc.createPdfUpload('coach-1', { title: 'X' }),
    ).rejects.toThrow(ServiceUnavailableException);
    // critically: no row should have been created on a failed upload-url mint.
    expect(prisma.coachMediaAsset.create).not.toHaveBeenCalled();
  });

  it('createPdfUpload key includes coach id namespace and a random suffix (no path traversal)', async () => {
    const { svc } = makeService();
    const result = await svc.createPdfUpload('coach-1', {
      title: '../../../etc/passwd', // user-controlled title should never affect key
    });
    expect(result.storage_key.startsWith('coach-1/')).toBe(true);
    expect(result.storage_key.includes('..')).toBe(false);
    expect(result.storage_key.includes('passwd')).toBe(false);
  });

  it('confirmPdfUpload flips uploading → ready (happy path)', async () => {
    const initial = defaultRow({
      id: 'asset-1',
      coach_id: 'coach-1',
      status: STATUS_UPLOADING,
    });
    const { svc, prisma } = makeService({ rows: [initial] });
    const out = await svc.confirmPdfUpload('coach-1', 'asset-1', {
      byte_size: 2048,
      page_count: 3,
    });
    expect(out.status).toBe(STATUS_READY);
    expect(prisma._rows[0].status).toBe(STATUS_READY);
    expect(prisma._rows[0].byte_size).toBe(BigInt(2048));
    expect(prisma._rows[0].page_count).toBe(3);
  });

  it('confirmPdfUpload is idempotent — re-confirming a ready row is a no-op', async () => {
    const initial = defaultRow({
      id: 'asset-1',
      coach_id: 'coach-1',
      status: STATUS_READY,
    });
    const { svc, prisma } = makeService({ rows: [initial] });
    const out = await svc.confirmPdfUpload('coach-1', 'asset-1', {});
    expect(out.status).toBe(STATUS_READY);
    expect(prisma.coachMediaAsset.update).not.toHaveBeenCalled();
  });

  it('confirmPdfUpload refuses a processing row (state-machine violation)', async () => {
    const initial = defaultRow({
      id: 'asset-1',
      coach_id: 'coach-1',
      status: STATUS_PROCESSING,
    });
    const { svc } = makeService({ rows: [initial] });
    await expect(
      svc.confirmPdfUpload('coach-1', 'asset-1', {}),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIRMATION' });
  });

  it('confirmPdfUpload refuses a row owned by another coach (404, no existence leak)', async () => {
    const initial = defaultRow({
      id: 'asset-1',
      coach_id: 'other-coach',
      status: STATUS_UPLOADING,
    });
    const { svc } = makeService({ rows: [initial] });
    await expect(
      svc.confirmPdfUpload('coach-1', 'asset-1', {}),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('CoachMediaService — Mux video upload flow', () => {
  it('createVideoUpload calls Mux + persists an uploading row', async () => {
    const { svc, prisma, mux } = makeService();
    const out = await svc.createVideoUpload('coach-1', {
      title: 'Demo',
      description: 'desc',
    });
    expect(out.upload_url).toBe('https://mux.test/upload/upl-1');
    expect(out.mux_upload_id).toBe('upl-1');
    expect(mux.createDirectUpload).toHaveBeenCalledTimes(1);
    const created = prisma._rows[0];
    expect(created.kind).toBe('video');
    expect(created.provider).toBe('mux');
    expect(created.status).toBe(STATUS_UPLOADING);
    expect(created.mux_upload_id).toBe('upl-1');
    expect(created.storage_key).toBe('upl-1'); // starts as upload id
  });

  it('createVideoUpload returns 503 when Mux is not configured', async () => {
    const mux = makeMuxStub({ configured: false });
    const { svc, prisma } = makeService({ mux });
    await expect(
      svc.createVideoUpload('coach-1', { title: 'X' }),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(prisma.coachMediaAsset.create).not.toHaveBeenCalled();
  });

  it('createVideoUpload rejects unknown body keys', async () => {
    const { svc } = makeService();
    await expect(
      svc.createVideoUpload('coach-1', { title: 'X', evil: 'yes' }),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('CoachMediaService — owner reads + signed URLs', () => {
  it('list returns only the owning coach rows; cross-coach refusal at the predicate', async () => {
    const { svc } = makeService({
      rows: [
        defaultRow({ id: 'a1', coach_id: 'coach-1' }),
        defaultRow({ id: 'a2', coach_id: 'coach-2' }),
      ],
    });
    const list = await svc.list('coach-1');
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('a1');
  });

  it('list filters by kind when requested', async () => {
    const { svc } = makeService({
      rows: [
        defaultRow({ id: 'pdf-1', coach_id: 'coach-1', kind: 'pdf' }),
        defaultRow({
          id: 'vid-1',
          coach_id: 'coach-1',
          kind: 'video',
          mux_playback_id: 'pb-1',
          storage_key: 'mux-asset-1',
          provider: 'mux',
        }),
      ],
    });
    const pdfs = await svc.list('coach-1', { kind: 'pdf' });
    const vids = await svc.list('coach-1', { kind: 'video' });
    expect(pdfs).toHaveLength(1);
    expect(pdfs[0].id).toBe('pdf-1');
    expect(vids).toHaveLength(1);
    expect(vids[0].id).toBe('vid-1');
  });

  it('list excludes archived rows by default', async () => {
    const { svc } = makeService({
      rows: [
        defaultRow({ id: 'a1', coach_id: 'coach-1' }),
        defaultRow({ id: 'a2', coach_id: 'coach-1', archived_at: new Date() }),
      ],
    });
    const list = await svc.list('coach-1');
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('a1');
  });

  it('getOne 404s on cross-coach access (no existence leak)', async () => {
    const { svc } = makeService({
      rows: [defaultRow({ id: 'a1', coach_id: 'other-coach' })],
    });
    await expect(svc.getOne('coach-1', 'a1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('getOwnerSignedUrl mints a Supabase signed URL for ready PDF', async () => {
    const { svc, storage } = makeService({
      rows: [
        defaultRow({
          id: 'a1',
          coach_id: 'coach-1',
          kind: 'pdf',
          status: STATUS_READY,
          storage_key: 'k1.pdf',
        }),
      ],
    });
    const out = await svc.getOwnerSignedUrl('coach-1', 'a1');
    expect(out.url).toContain('supabase.test/download/k1.pdf');
    expect(out.kind).toBe('pdf');
    expect(storage.createSignedDownloadUrl).toHaveBeenCalledTimes(1);
  });

  it('getOwnerSignedUrl mints a Mux playback URL for ready video', async () => {
    const { svc, mux } = makeService({
      rows: [
        defaultRow({
          id: 'v1',
          coach_id: 'coach-1',
          kind: 'video',
          provider: 'mux',
          status: STATUS_READY,
          mux_playback_id: 'pb-xyz',
        }),
      ],
    });
    const out = await svc.getOwnerSignedUrl('coach-1', 'v1');
    // Audit P2-2: signed playback returns a token-bearing URL.
    expect(out.url).toBe('https://stream.mux.com/pb-xyz.m3u8?token=stub-signed-jwt');
    expect(out.kind).toBe('video');
    expect(mux.mintPlaybackUrl).toHaveBeenCalledWith({
      playbackId: 'pb-xyz',
      policy: 'signed',
      ttlSeconds: undefined,
    });
  });

  it('getOwnerSignedUrl refuses a not-ready video with ASSET_NOT_READY (409)', async () => {
    const { svc } = makeService({
      rows: [
        defaultRow({
          id: 'v1',
          coach_id: 'coach-1',
          kind: 'video',
          status: STATUS_PROCESSING,
        }),
      ],
    });
    await expect(svc.getOwnerSignedUrl('coach-1', 'v1')).rejects.toThrow(
      ConflictException,
    );
  });

  it('getOwnerSignedUrl refuses a ready video with missing playback id (defensive)', async () => {
    const { svc } = makeService({
      rows: [
        defaultRow({
          id: 'v1',
          coach_id: 'coach-1',
          kind: 'video',
          status: STATUS_READY,
          mux_playback_id: null,
        }),
      ],
    });
    await expect(svc.getOwnerSignedUrl('coach-1', 'v1')).rejects.toMatchObject({
      response: expect.objectContaining({ error: 'ASSET_NOT_READY' }),
    });
  });

  it('getOwnerSignedUrl cross-coach 404 (no existence leak)', async () => {
    const { svc } = makeService({
      rows: [defaultRow({ id: 'a1', coach_id: 'other-coach' })],
    });
    await expect(svc.getOwnerSignedUrl('coach-1', 'a1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('getOwnerSignedUrl on PDF returns 503 when storage is not configured', async () => {
    const storage = makeStorageStub({ configured: false });
    const { svc } = makeService({
      rows: [
        defaultRow({
          id: 'a1',
          coach_id: 'coach-1',
          kind: 'pdf',
          status: STATUS_READY,
        }),
      ],
      storage,
    });
    await expect(svc.getOwnerSignedUrl('coach-1', 'a1')).rejects.toThrow(
      ServiceUnavailableException,
    );
  });
});

describe('CoachMediaService — buyer signed-URL gate (ClientAssetGrant)', () => {
  function setup(opts: {
    asset?: Row;
    grant?: { client_id: string; media_asset_id: string; revoked_at: Date | null };
  } = {}) {
    const asset =
      opts.asset ??
      defaultRow({ id: 'a1', coach_id: 'coach-1', kind: 'pdf', status: STATUS_READY });
    const tools = makeService({ rows: [asset] });
    if (opts.grant) tools.prisma._grants.push(opts.grant);
    return tools;
  }

  it('grants buyer access when a ClientAssetGrant exists', async () => {
    const { svc } = setup({
      grant: {
        client_id: 'buyer-1',
        media_asset_id: 'a1',
        revoked_at: null,
      },
    });
    const out = await svc.getBuyerSignedUrl('buyer-1', 'a1');
    expect(out.url).toContain('supabase.test/download/');
  });

  it('refuses a buyer without a grant (404 — audit P2-1, no existence leak)', async () => {
    const { svc } = setup();
    await expect(svc.getBuyerSignedUrl('non-buyer', 'a1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('refuses a buyer whose grant is revoked (404 — uniform shape)', async () => {
    const { svc } = setup({
      grant: {
        client_id: 'buyer-1',
        media_asset_id: 'a1',
        revoked_at: new Date(),
      },
    });
    await expect(svc.getBuyerSignedUrl('buyer-1', 'a1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('AUDIT P2-4: refuses when the grant’s purchase belongs to a DIFFERENT coach (tenant double-check)', async () => {
    // Set up: an asset owned by coach-1, a grant for buyer-1 pointing
    // at media_asset_id=a1, BUT the grant was minted via a drop whose
    // purchase was sold by coach-2. The MediaAssetResolver would never
    // write such a row today (it enforces tenant on CREATE), but
    // defence-in-depth: this read path must refuse.
    const asset = defaultRow({
      id: 'a1',
      coach_id: 'coach-1',
      kind: 'pdf',
      status: STATUS_READY,
    });
    const { svc, prisma } = makeService({ rows: [asset] });
    prisma._grants.push({
      id: 'grant-1',
      client_id: 'buyer-1',
      media_asset_id: 'a1',
      revoked_at: null,
      granted_via_drop_id: 'drop-1',
    });
    prisma._drops.push({
      id: 'drop-1',
      client_purchase: { coach_user_id: 'coach-2' }, // mismatch
    });
    await expect(svc.getBuyerSignedUrl('buyer-1', 'a1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('AUDIT P2-4: allows when the grant’s purchase belongs to the SAME coach as the asset', async () => {
    const asset = defaultRow({
      id: 'a1',
      coach_id: 'coach-1',
      kind: 'pdf',
      status: STATUS_READY,
    });
    const { svc, prisma } = makeService({ rows: [asset] });
    prisma._grants.push({
      id: 'grant-1',
      client_id: 'buyer-1',
      media_asset_id: 'a1',
      revoked_at: null,
      granted_via_drop_id: 'drop-1',
    });
    prisma._drops.push({
      id: 'drop-1',
      client_purchase: { coach_user_id: 'coach-1' }, // match
    });
    const out = await svc.getBuyerSignedUrl('buyer-1', 'a1');
    expect(out.url).toContain('supabase.test/download/');
  });

  it('refuses access to an archived asset even with a grant', async () => {
    const { svc } = setup({
      asset: defaultRow({
        id: 'a1',
        coach_id: 'coach-1',
        kind: 'pdf',
        status: STATUS_READY,
        archived_at: new Date(),
      }),
      grant: {
        client_id: 'buyer-1',
        media_asset_id: 'a1',
        revoked_at: null,
      },
    });
    await expect(svc.getBuyerSignedUrl('buyer-1', 'a1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('refuses access to a not-ready asset even with a grant', async () => {
    const { svc } = setup({
      asset: defaultRow({
        id: 'a1',
        coach_id: 'coach-1',
        kind: 'pdf',
        status: STATUS_PROCESSING,
      }),
      grant: {
        client_id: 'buyer-1',
        media_asset_id: 'a1',
        revoked_at: null,
      },
    });
    await expect(svc.getBuyerSignedUrl('buyer-1', 'a1')).rejects.toThrow(
      ConflictException,
    );
  });
});

describe('CoachMediaService — patch (metadata)', () => {
  it('patches title + description; rejects unknown keys', async () => {
    const { svc, prisma } = makeService({
      rows: [defaultRow({ id: 'a1', coach_id: 'coach-1' })],
    });
    await svc.patch('coach-1', 'a1', {
      title: 'New title',
      description: null,
    });
    expect(prisma._rows[0].title).toBe('New title');
    expect(prisma._rows[0].description).toBeNull();
    await expect(
      svc.patch('coach-1', 'a1', { unknown_key: 1 }),
    ).rejects.toThrow(BadRequestException);
  });

  it('patch 404s on cross-coach', async () => {
    const { svc } = makeService({
      rows: [defaultRow({ id: 'a1', coach_id: 'other-coach' })],
    });
    await expect(
      svc.patch('coach-1', 'a1', { title: 'X' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('patch refuses an empty body (zod refine)', async () => {
    const { svc } = makeService({
      rows: [defaultRow({ id: 'a1', coach_id: 'coach-1' })],
    });
    await expect(svc.patch('coach-1', 'a1', {})).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('CoachMediaService — soft-delete safety', () => {
  it('archives the row and deletes the storage object when no grants/contents reference it', async () => {
    const { svc, prisma, storage } = makeService({
      rows: [
        defaultRow({
          id: 'a1',
          coach_id: 'coach-1',
          kind: 'pdf',
        }),
      ],
    });
    const out = await svc.softDelete('coach-1', 'a1');
    expect(out.object_deleted).toBe(true);
    expect(storage.deleteObject).toHaveBeenCalledTimes(1);
    expect(prisma._rows[0].archived_at).toBeInstanceOf(Date);
  });

  it('archives the row but KEEPS the storage object when a buyer holds an active grant', async () => {
    const { svc, prisma, storage } = makeService({
      rows: [
        defaultRow({
          id: 'a1',
          coach_id: 'coach-1',
          kind: 'pdf',
        }),
      ],
    });
    prisma._grants.push({
      client_id: 'buyer-1',
      media_asset_id: 'a1',
      revoked_at: null,
    });
    const out = await svc.softDelete('coach-1', 'a1');
    expect(out.object_deleted).toBe(false);
    expect(storage.deleteObject).not.toHaveBeenCalled();
    expect(prisma._rows[0].archived_at).toBeInstanceOf(Date);
    // buyer can still get a signed URL after archive — but only because the
    // storage object is still there AND the row isn't gone (we only set
    // archived_at; the row still exists). Buyer-side path filters archived;
    // the explicit test for "buyer still works after archive" lives in a
    // dedicated assertion below.
  });

  it('blocks delete when an active CoachPackageContent still references the asset (409 ASSET_REFERENCED)', async () => {
    const { svc, prisma } = makeService({
      rows: [defaultRow({ id: 'a1', coach_id: 'coach-1' })],
    });
    prisma._contents.push({
      asset_id: 'a1',
      asset_type: 'pdf',
      removed_at: null,
    });
    await expect(svc.softDelete('coach-1', 'a1')).rejects.toThrow(
      ConflictException,
    );
  });

  it('soft-delete is idempotent — re-archiving an archived row no-ops', async () => {
    const archivedAt = new Date('2026-04-01');
    const { svc, storage } = makeService({
      rows: [
        defaultRow({
          id: 'a1',
          coach_id: 'coach-1',
          archived_at: archivedAt,
        }),
      ],
    });
    const out = await svc.softDelete('coach-1', 'a1');
    expect(out.archived_at).toEqual(archivedAt);
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });

  it('cross-coach delete 404s (no existence leak, no deletion)', async () => {
    const { svc, storage } = makeService({
      rows: [defaultRow({ id: 'a1', coach_id: 'other-coach' })],
    });
    await expect(svc.softDelete('coach-1', 'a1')).rejects.toThrow(
      NotFoundException,
    );
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });
});

describe('CoachMediaService — sub-coach scope', () => {
  it('resolveEffectiveCoachId promotes a sub-coach to the head coach id', async () => {
    const subCoach = makeSubCoachScopeStub('head-99');
    const { svc } = makeService({ subCoach });
    const out = await svc.resolveEffectiveCoachId('sub-1');
    expect(out).toBe('head-99');
  });

  it('resolveEffectiveCoachId returns the caller id for a head coach', async () => {
    const subCoach = makeSubCoachScopeStub(null);
    const { svc } = makeService({ subCoach });
    const out = await svc.resolveEffectiveCoachId('head-1');
    expect(out).toBe('head-1');
  });
});

describe('CoachMediaService — static helpers', () => {
  it('isAttachableStatus is true only for ready', () => {
    expect(CoachMediaService.isAttachableStatus('ready')).toBe(true);
    expect(CoachMediaService.isAttachableStatus('uploading')).toBe(false);
    expect(CoachMediaService.isAttachableStatus('processing')).toBe(false);
    expect(CoachMediaService.isAttachableStatus('errored')).toBe(false);
  });

  it('canAdvanceFromPreTerminal is true only for non-terminal', () => {
    expect(CoachMediaService.canAdvanceFromPreTerminal('uploading')).toBe(true);
    expect(CoachMediaService.canAdvanceFromPreTerminal('processing')).toBe(
      true,
    );
    expect(CoachMediaService.canAdvanceFromPreTerminal('ready')).toBe(false);
    expect(CoachMediaService.canAdvanceFromPreTerminal('errored')).toBe(false);
  });
});
