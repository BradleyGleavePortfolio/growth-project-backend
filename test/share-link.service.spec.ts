import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../src/prisma.service';
import { ShareLinkService } from '../src/share-link/share-link.service';

// R43 — ShareLinkService unit tests. Prisma is mocked so no DB connection
// is touched.

type Pkg = {
  id: string;
  coach_id: string;
  archived_at: Date | null;
  share_token: string | null;
  share_link_enabled: boolean;
  share_link_generated_at: Date | null;
};

const COACH_ID = 'coach-1';
const PKG_ID = 'pkg-1';

function makePkg(overrides: Partial<Pkg> = {}): Pkg {
  return {
    id: PKG_ID,
    coach_id: COACH_ID,
    archived_at: null,
    share_token: null,
    share_link_enabled: true,
    share_link_generated_at: null,
    ...overrides,
  };
}

describe('ShareLinkService', () => {
  let service: ShareLinkService;
  let prismaFindUnique: jest.Mock;
  let prismaUpdateMany: jest.Mock;

  beforeEach(async () => {
    prismaFindUnique = jest.fn();
    prismaUpdateMany = jest.fn();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ShareLinkService,
        {
          provide: PrismaService,
          useValue: {
            coachPackage: {
              findUnique: prismaFindUnique,
              updateMany: prismaUpdateMany,
            },
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: (k: string) =>
              k === 'STOREFRONT_BASE_URL' ? 'https://tgp.app' : undefined,
          },
        },
      ],
    }).compile();
    service = module.get(ShareLinkService);
  });

  it('throws 404 when the package does not exist', async () => {
    prismaFindUnique.mockResolvedValueOnce(null);
    await expect(service.mintOrGet(COACH_ID, PKG_ID)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('throws 404 when the caller is not the package owner', async () => {
    prismaFindUnique.mockResolvedValueOnce(
      makePkg({ coach_id: 'other-coach' }),
    );
    await expect(service.mintOrGet(COACH_ID, PKG_ID)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('throws 404 when the package is archived', async () => {
    prismaFindUnique.mockResolvedValueOnce(
      makePkg({ archived_at: new Date() }),
    );
    await expect(service.mintOrGet(COACH_ID, PKG_ID)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('returns the existing token without touching update (idempotent)', async () => {
    const generatedAt = new Date('2026-01-15T10:00:00Z');
    prismaFindUnique.mockResolvedValueOnce(
      makePkg({
        share_token: 'AbCdEf12gH',
        share_link_enabled: true,
        share_link_generated_at: generatedAt,
      }),
    );
    const result = await service.mintOrGet(COACH_ID, PKG_ID);
    expect(result.share_token).toBe('AbCdEf12gH');
    expect(result.share_url).toBe('https://tgp.app/join/AbCdEf12gH');
    expect(result.share_link_enabled).toBe(true);
    expect(result.share_link_generated_at).toEqual(generatedAt);
    expect(prismaUpdateMany).not.toHaveBeenCalled();
  });

  it('mints a new token on first call (atomic updateMany count=1)', async () => {
    prismaFindUnique.mockResolvedValueOnce(makePkg());
    prismaUpdateMany.mockResolvedValueOnce({ count: 1 });
    const result = await service.mintOrGet(COACH_ID, PKG_ID);
    expect(result.share_token).toMatch(/^[A-Za-z0-9]{10}$/);
    expect(result.share_url).toBe(`https://tgp.app/join/${result.share_token}`);
    expect(prismaUpdateMany).toHaveBeenCalledTimes(1);
    // Critical: updateMany WHERE must include share_token: null so two
    // concurrent first-time callers cannot both overwrite each other.
    const call = prismaUpdateMany.mock.calls[0][0];
    expect(call.where).toMatchObject({
      id: PKG_ID,
      coach_id: COACH_ID,
      archived_at: null,
      share_token: null,
    });
  });

  it('retries on token collision (P2002) and succeeds on second attempt', async () => {
    prismaFindUnique.mockResolvedValueOnce(makePkg());
    const p2002: Error & { code?: string } = new Error('unique constraint');
    p2002.code = 'P2002';
    prismaUpdateMany
      .mockRejectedValueOnce(p2002)
      .mockResolvedValueOnce({ count: 1 });
    const result = await service.mintOrGet(COACH_ID, PKG_ID);
    expect(result.share_token).toMatch(/^[A-Za-z0-9]{10}$/);
    expect(prismaUpdateMany).toHaveBeenCalledTimes(2);
  });

  it('throws 503 after 5 consecutive collisions', async () => {
    prismaFindUnique.mockResolvedValueOnce(makePkg());
    const p2002: Error & { code?: string } = new Error('unique constraint');
    p2002.code = 'P2002';
    prismaUpdateMany
      .mockRejectedValueOnce(p2002)
      .mockRejectedValueOnce(p2002)
      .mockRejectedValueOnce(p2002)
      .mockRejectedValueOnce(p2002)
      .mockRejectedValueOnce(p2002);
    await expect(service.mintOrGet(COACH_ID, PKG_ID)).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  // P1-2 — Concurrent mint race. Two simultaneous first-time requests
  // both observe share_token = null. The conditional updateMany ensures
  // only one wins (count = 1); the loser sees count = 0 and re-reads
  // the persisted token rather than overwriting it.
  it('returns the winning token when a concurrent caller wins the race', async () => {
    const winnerToken = 'WiNnerTok1';
    const generatedAt = new Date('2026-03-01T00:00:00Z');
    prismaFindUnique
      .mockResolvedValueOnce(makePkg()) // initial read — no token
      .mockResolvedValueOnce({
        // re-read after losing the race
        coach_id: COACH_ID,
        archived_at: null,
        share_token: winnerToken,
        share_link_enabled: true,
        share_link_generated_at: generatedAt,
      });
    // Our updateMany hits count = 0 because the concurrent caller's
    // updateMany already moved share_token away from null.
    prismaUpdateMany.mockResolvedValueOnce({ count: 0 });
    const result = await service.mintOrGet(COACH_ID, PKG_ID);
    expect(result.share_token).toBe(winnerToken);
    expect(result.share_link_generated_at).toEqual(generatedAt);
    // Critical: we did not call updateMany a second time — never
    // overwrite an existing share_token.
    expect(prismaUpdateMany).toHaveBeenCalledTimes(1);
  });
});
