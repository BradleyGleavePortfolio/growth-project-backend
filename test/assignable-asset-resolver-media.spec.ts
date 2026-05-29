import { Prisma } from '@prisma/client';
import { MediaAssetResolver } from '../src/packages/asset-resolvers/media-asset.resolver';
import { ResolverSubCoachScope } from '../src/packages/asset-resolvers/sub-coach-scope.helper';
import {
  MediaAssetNotFoundError,
  SubCoachOutOfScopeError,
} from '../src/packages/asset-resolvers/assignable-asset-resolver.errors';

function makeScope(allowed: boolean, isSub = false, headId: string | null = null) {
  return new ResolverSubCoachScope({
    canAccessClient: jest.fn(async () => allowed),
    getHeadCoachIdForSubCoach: jest.fn(async () => (isSub ? headId : null)),
  } as unknown as ConstructorParameters<typeof ResolverSubCoachScope>[0]);
}

interface PrismaStubOpts {
  asset?: { id: string; coach_id: string; archived_at: Date | null } | null;
  grantCreateResult?: { id: string };
  grantCreateError?: unknown;
  existingGrant?: { id: string } | null;
}

function makePrismaStub(opts: PrismaStubOpts) {
  const create = opts.grantCreateError
    ? jest.fn(async () => {
        throw opts.grantCreateError;
      })
    : jest.fn(async () => opts.grantCreateResult ?? { id: 'grant-new' });
  const findUnique = jest.fn(async () => opts.existingGrant ?? null);
  return {
    coachMediaAsset: {
      findUnique: jest.fn(async () => opts.asset ?? null),
    },
    clientAssetGrant: {
      create,
      findUnique,
    },
  };
}

function p2002() {
  return new Prisma.PrismaClientKnownRequestError('unique violation', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

describe('MediaAssetResolver (pdf + video)', () => {
  it('canHandle covers both pdf and video', () => {
    const r = new MediaAssetResolver(
      makePrismaStub({ asset: null }) as unknown as ConstructorParameters<typeof MediaAssetResolver>[0],
      makeScope(true),
    );
    expect(r.canHandle('pdf')).toBe(true);
    expect(r.canHandle('video')).toBe(true);
    expect(r.canHandle('workout_plan')).toBe(false);
    expect(r.canHandle('auto_message')).toBe(false);
  });

  it('creates a ClientAssetGrant and returns its id (happy path)', async () => {
    const stub = makePrismaStub({
      asset: { id: 'asset-1', coach_id: 'coach-1', archived_at: null },
      grantCreateResult: { id: 'grant-1' },
    });
    const resolver = new MediaAssetResolver(
      stub as unknown as ConstructorParameters<typeof MediaAssetResolver>[0],
      makeScope(true),
    );
    const res = await resolver.materialise({
      clientId: 'client-1',
      coachId: 'coach-1',
      assetId: 'asset-1',
      scheduledDropId: 'drop-99',
    });
    expect(res.materialisedRef).toBe('grant-1');
    expect(stub.clientAssetGrant.create).toHaveBeenCalledWith({
      data: {
        client_id: 'client-1',
        media_asset_id: 'asset-1',
        granted_via_drop_id: 'drop-99',
      },
      select: { id: true },
    });
  });

  it('idempotent on duplicate INSERT: P2002 → returns existing grant id (on-conflict-nothing)', async () => {
    const stub = makePrismaStub({
      asset: { id: 'asset-1', coach_id: 'coach-1', archived_at: null },
      grantCreateError: p2002(),
      existingGrant: { id: 'grant-existing' },
    });
    const resolver = new MediaAssetResolver(
      stub as unknown as ConstructorParameters<typeof MediaAssetResolver>[0],
      makeScope(true),
    );
    const res = await resolver.materialise({
      clientId: 'client-1',
      coachId: 'coach-1',
      assetId: 'asset-1',
    });
    expect(res.materialisedRef).toBe('grant-existing');
    expect(stub.clientAssetGrant.findUnique).toHaveBeenCalledWith({
      where: {
        client_id_media_asset_id: {
          client_id: 'client-1',
          media_asset_id: 'asset-1',
        },
      },
      select: { id: true },
    });
  });

  it('throws MediaAssetNotFoundError when the CoachMediaAsset does not exist (upload pipeline is PR-12)', async () => {
    const stub = makePrismaStub({ asset: null });
    const resolver = new MediaAssetResolver(
      stub as unknown as ConstructorParameters<typeof MediaAssetResolver>[0],
      makeScope(true),
    );
    await expect(
      resolver.materialise({
        clientId: 'c1',
        coachId: 'coach-1',
        assetId: 'never-uploaded',
      }),
    ).rejects.toThrow(MediaAssetNotFoundError);
    expect(stub.clientAssetGrant.create).not.toHaveBeenCalled();
  });

  it('throws MediaAssetNotFoundError when the asset is archived (soft-deleted)', async () => {
    const stub = makePrismaStub({
      asset: { id: 'asset-1', coach_id: 'coach-1', archived_at: new Date() },
    });
    const resolver = new MediaAssetResolver(
      stub as unknown as ConstructorParameters<typeof MediaAssetResolver>[0],
      makeScope(true),
    );
    await expect(
      resolver.materialise({
        clientId: 'c1',
        coachId: 'coach-1',
        assetId: 'asset-1',
      }),
    ).rejects.toThrow(MediaAssetNotFoundError);
  });

  it('refuses cross-tenant access: asset.coach_id !== acting.tenantCoachId → MediaAssetNotFoundError', async () => {
    const stub = makePrismaStub({
      asset: { id: 'asset-1', coach_id: 'other-coach', archived_at: null },
    });
    const resolver = new MediaAssetResolver(
      stub as unknown as ConstructorParameters<typeof MediaAssetResolver>[0],
      makeScope(true),
    );
    await expect(
      resolver.materialise({
        clientId: 'c1',
        coachId: 'coach-1',
        assetId: 'asset-1',
      }),
    ).rejects.toThrow(MediaAssetNotFoundError);
    expect(stub.clientAssetGrant.create).not.toHaveBeenCalled();
  });

  it('honours ambient tx: ALL DB reads + writes go through the tx (PrismaService is NEVER touched)', async () => {
    const txStub = makePrismaStub({
      asset: { id: 'asset-1', coach_id: 'coach-1', archived_at: null },
      grantCreateResult: { id: 'grant-tx' },
    });
    const prismaStub = makePrismaStub({
      asset: { id: 'asset-1', coach_id: 'coach-1', archived_at: null },
      grantCreateResult: { id: 'should-not-be-used' },
    });
    const resolver = new MediaAssetResolver(
      prismaStub as unknown as ConstructorParameters<typeof MediaAssetResolver>[0],
      makeScope(true),
    );
    const res = await resolver.materialise({
      clientId: 'c1',
      coachId: 'coach-1',
      assetId: 'asset-1',
      tx: txStub as unknown as Parameters<MediaAssetResolver['materialise']>[0]['tx'],
    });
    expect(res.materialisedRef).toBe('grant-tx');
    expect(txStub.coachMediaAsset.findUnique).toHaveBeenCalledTimes(1);
    expect(txStub.clientAssetGrant.create).toHaveBeenCalledTimes(1);
    expect(prismaStub.coachMediaAsset.findUnique).not.toHaveBeenCalled();
    expect(prismaStub.clientAssetGrant.create).not.toHaveBeenCalled();
  });

  it('respects sub-coach scope: tenant id used for asset ownership check is the head coach id', async () => {
    const stub = makePrismaStub({
      asset: { id: 'asset-1', coach_id: 'head-99', archived_at: null },
      grantCreateResult: { id: 'grant-1' },
    });
    const resolver = new MediaAssetResolver(
      stub as unknown as ConstructorParameters<typeof MediaAssetResolver>[0],
      makeScope(true, true, 'head-99'),
    );
    const res = await resolver.materialise({
      clientId: 'c1',
      coachId: 'sub-1',
      assetId: 'asset-1',
    });
    expect(res.materialisedRef).toBe('grant-1');
  });

  it('refuses out-of-scope sub-coaches before any DB call', async () => {
    const stub = makePrismaStub({});
    const resolver = new MediaAssetResolver(
      stub as unknown as ConstructorParameters<typeof MediaAssetResolver>[0],
      makeScope(false),
    );
    await expect(
      resolver.materialise({
        clientId: 'c1',
        coachId: 'sub-1',
        assetId: 'asset-1',
      }),
    ).rejects.toThrow(SubCoachOutOfScopeError);
    expect(stub.coachMediaAsset.findUnique).not.toHaveBeenCalled();
  });
});
