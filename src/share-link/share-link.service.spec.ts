import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { ShareLinkService } from './share-link.service';

// R43 — ShareLinkService unit tests. Prisma is mocked so no DB connection
// is touched. Tests cover: ownership 404, idempotent return when the token
// already exists, fresh mint, collision retry, and the 5-attempt cap.

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
  let prismaUpdate: jest.Mock;

  beforeEach(async () => {
    prismaFindUnique = jest.fn();
    prismaUpdate = jest.fn();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ShareLinkService,
        {
          provide: PrismaService,
          useValue: {
            coachPackage: {
              findUnique: prismaFindUnique,
              update: prismaUpdate,
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
    expect(prismaUpdate).not.toHaveBeenCalled();
  });

  it('mints a new token on first call', async () => {
    // findUnique calls: (1) package lookup → no token; (2) collision check → null
    prismaFindUnique
      .mockResolvedValueOnce(makePkg())
      .mockResolvedValueOnce(null);
    prismaUpdate.mockImplementationOnce(async ({ data }) => ({
      share_token: data.share_token,
      share_link_enabled: true,
      share_link_generated_at: data.share_link_generated_at,
    }));
    const result = await service.mintOrGet(COACH_ID, PKG_ID);
    expect(result.share_token).toMatch(/^[A-Za-z0-9]{10}$/);
    expect(result.share_url).toBe(`https://tgp.app/join/${result.share_token}`);
    expect(prismaUpdate).toHaveBeenCalledTimes(1);
  });

  it('retries on token collision and succeeds on second attempt', async () => {
    prismaFindUnique
      .mockResolvedValueOnce(makePkg()) // package
      .mockResolvedValueOnce({ id: 'someone-else' }) // first candidate collides
      .mockResolvedValueOnce(null); // second candidate is free
    prismaUpdate.mockImplementationOnce(async ({ data }) => ({
      share_token: data.share_token,
      share_link_enabled: true,
      share_link_generated_at: data.share_link_generated_at,
    }));
    const result = await service.mintOrGet(COACH_ID, PKG_ID);
    expect(result.share_token).toMatch(/^[A-Za-z0-9]{10}$/);
    expect(prismaUpdate).toHaveBeenCalledTimes(1);
  });

  it('throws 503 after 5 consecutive collisions', async () => {
    prismaFindUnique
      .mockResolvedValueOnce(makePkg()) // package lookup
      .mockResolvedValueOnce({ id: 'x' })
      .mockResolvedValueOnce({ id: 'x' })
      .mockResolvedValueOnce({ id: 'x' })
      .mockResolvedValueOnce({ id: 'x' })
      .mockResolvedValueOnce({ id: 'x' });
    await expect(service.mintOrGet(COACH_ID, PKG_ID)).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(prismaUpdate).not.toHaveBeenCalled();
  });

  it('recovers from a concurrent P2002 by re-reading the persisted token', async () => {
    const generatedAt = new Date('2026-02-01T00:00:00Z');
    prismaFindUnique
      .mockResolvedValueOnce(makePkg()) // package
      .mockResolvedValueOnce(null) // candidate not found
      .mockResolvedValueOnce({
        // re-read after P2002
        share_token: 'XyZaBcDeF0',
        share_link_enabled: true,
        share_link_generated_at: generatedAt,
      });
    const p2002: Error & { code?: string } = new Error('unique constraint');
    p2002.code = 'P2002';
    prismaUpdate.mockRejectedValueOnce(p2002);
    const result = await service.mintOrGet(COACH_ID, PKG_ID);
    expect(result.share_token).toBe('XyZaBcDeF0');
    expect(result.share_link_generated_at).toEqual(generatedAt);
  });
});
