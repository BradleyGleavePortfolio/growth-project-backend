import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../src/prisma.service';
import {
  ShareLinkService,
  SHARE_TOKEN_LENGTH,
  SHARE_TOKEN_REGEX,
} from '../src/share-link/share-link.service';

// R43 — ShareLinkService unit tests. Prisma is mocked so no DB connection
// is touched.
//
// Round 3 update (P1-3 / P1-4 / P2-1 / P2-2): tokens are 21 chars from the
// nanoid alphabet, the initial read is tenant-scoped (findFirst with
// coach_id), and there is no separate ownership check inside the service
// because the WHERE clause carries it.

type Pkg = {
  id: string;
  share_token: string | null;
  share_link_enabled: boolean;
  share_link_generated_at: Date | null;
};

const COACH_ID = 'coach-1';
const PKG_ID = 'pkg-1';

function makePkg(overrides: Partial<Pkg> = {}): Pkg {
  return {
    id: PKG_ID,
    share_token: null,
    share_link_enabled: true,
    share_link_generated_at: null,
    ...overrides,
  };
}

describe('ShareLinkService', () => {
  let service: ShareLinkService;
  let prismaFindFirst: jest.Mock;
  let prismaUpdateMany: jest.Mock;

  beforeEach(async () => {
    prismaFindFirst = jest.fn();
    prismaUpdateMany = jest.fn();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ShareLinkService,
        {
          provide: PrismaService,
          useValue: {
            coachPackage: {
              findFirst: prismaFindFirst,
              updateMany: prismaUpdateMany,
            },
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: (k: string) =>
              k === 'STOREFRONT_BASE_URL'
                ? 'https://storefront.example.com'
                : undefined,
          },
        },
      ],
    }).compile();
    service = module.get(ShareLinkService);
  });

  it('throws 404 when the package does not exist for this coach (tenant-scoped read)', async () => {
    prismaFindFirst.mockResolvedValueOnce(null);
    await expect(service.mintOrGet(COACH_ID, PKG_ID)).rejects.toThrow(
      NotFoundException,
    );
    // Critical: the WHERE clause must scope by coach_id so a foreign
    // coach's package UUID never returns a row to application code.
    const call = prismaFindFirst.mock.calls[0][0];
    expect(call.where).toMatchObject({
      id: PKG_ID,
      coach_id: COACH_ID,
      archived_at: null,
    });
  });

  it('returns the existing token without touching update (idempotent)', async () => {
    const generatedAt = new Date('2026-01-15T10:00:00Z');
    const existingToken = 'AbCdEf12gHiJ34kLmNoP_'; // 21 chars
    prismaFindFirst.mockResolvedValueOnce(
      makePkg({
        share_token: existingToken,
        share_link_enabled: true,
        share_link_generated_at: generatedAt,
      }),
    );
    const result = await service.mintOrGet(COACH_ID, PKG_ID);
    expect(result.share_token).toBe(existingToken);
    expect(result.share_url).toBe(
      `https://storefront.example.com/join/${existingToken}`,
    );
    expect(result.share_link_enabled).toBe(true);
    expect(result.share_link_generated_at).toEqual(generatedAt);
    expect(prismaUpdateMany).not.toHaveBeenCalled();
  });

  it('mints a 21-char nanoid-alphabet token on first call (atomic updateMany count=1)', async () => {
    prismaFindFirst.mockResolvedValueOnce(makePkg());
    prismaUpdateMany.mockResolvedValueOnce({ count: 1 });
    const result = await service.mintOrGet(COACH_ID, PKG_ID);
    expect(result.share_token).toHaveLength(SHARE_TOKEN_LENGTH);
    expect(SHARE_TOKEN_REGEX.test(result.share_token)).toBe(true);
    expect(result.share_url).toBe(
      `https://storefront.example.com/join/${result.share_token}`,
    );
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
    prismaFindFirst.mockResolvedValueOnce(makePkg());
    const p2002: Error & { code?: string } = new Error('unique constraint');
    p2002.code = 'P2002';
    prismaUpdateMany
      .mockRejectedValueOnce(p2002)
      .mockResolvedValueOnce({ count: 1 });
    const result = await service.mintOrGet(COACH_ID, PKG_ID);
    expect(result.share_token).toHaveLength(SHARE_TOKEN_LENGTH);
    expect(SHARE_TOKEN_REGEX.test(result.share_token)).toBe(true);
    expect(prismaUpdateMany).toHaveBeenCalledTimes(2);
  });

  it('throws 503 after 5 consecutive collisions', async () => {
    prismaFindFirst.mockResolvedValueOnce(makePkg());
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
    const winnerToken = 'WiNnerTokenXYZabc1234'; // 21 chars
    const generatedAt = new Date('2026-03-01T00:00:00Z');
    prismaFindFirst
      .mockResolvedValueOnce(makePkg()) // initial read — no token
      .mockResolvedValueOnce({
        // re-read after losing the race — still tenant-scoped
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

  // P1-3 — token shape regression. The 10-char tokens minted before
  // Round 3 are not produced by mintToken any more; the regex rejects
  // them and the legacy-invalidation migration clears them.
  // Audit #4 P2-4 — one-way revocation. The current token is nulled
  // and share_link_revoked_at is stamped; a follow-up mint produces
  // a fresh token instead of reviving the dead one.
  describe('revoke', () => {
    it('flips share_link_revoked_at and nulls share_token in one write', async () => {
      prismaUpdateMany.mockResolvedValueOnce({ count: 1 });
      await expect(service.revoke(COACH_ID, PKG_ID)).resolves.toEqual({
        revoked: true,
      });
      const call = prismaUpdateMany.mock.calls[0][0];
      expect(call.where).toMatchObject({
        id: PKG_ID,
        coach_id: COACH_ID,
        archived_at: null,
        share_token: { not: null },
        share_link_revoked_at: null,
      });
      expect(call.data.share_link_revoked_at).toBeInstanceOf(Date);
      expect(call.data.share_token).toBeNull();
      expect(call.data.share_link_enabled).toBe(false);
    });

    it('404s when the package is not owned, archived, or already revoked', async () => {
      prismaUpdateMany.mockResolvedValueOnce({ count: 0 });
      await expect(service.revoke(COACH_ID, PKG_ID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  it('mints tokens that match the canonical nanoid 21-char regex', () => {
    for (let i = 0; i < 50; i += 1) {
      // Cycle the mock so each call is fresh.
      prismaFindFirst.mockResolvedValueOnce(makePkg());
      prismaUpdateMany.mockResolvedValueOnce({ count: 1 });
    }
    return Promise.all(
      Array.from({ length: 50 }, () => service.mintOrGet(COACH_ID, PKG_ID)),
    ).then((results) => {
      for (const r of results) {
        expect(SHARE_TOKEN_REGEX.test(r.share_token)).toBe(true);
      }
    });
  });
});
