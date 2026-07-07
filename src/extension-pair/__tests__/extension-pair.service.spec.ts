import { BadRequestException, GoneException } from '@nestjs/common';
import { ExtensionPairService } from '../extension-pair.service';
import { asAuthDouble, asPrismaDouble } from './test-doubles';

// Minimal in-shape doubles. We drive the service directly with mocked Prisma +
// AuthService so no network / DB is touched (DESIGN.md v0.3 §11: hermetic).

interface Row {
  id: string;
  code: string;
  coach_id: string;
  chosen_platform: string;
  expires_at: Date;
  used_at: Date | null;
  created_at: Date;
}

function makeRow(overrides: Partial<Row> = {}): Row {
  return {
    id: 'row-1',
    code: '142856',
    coach_id: 'coach-1',
    chosen_platform: 'truecoach',
    expires_at: new Date(Date.now() + 120_000),
    used_at: null,
    created_at: new Date(),
    ...overrides,
  };
}

function makePrisma() {
  return {
    extensionPairCode: {
      create: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
  };
}

function makeAuth() {
  return {
    mintExtensionSessionForCoach: jest.fn().mockResolvedValue({
      access_token: 'access-xyz',
      refresh_token: 'refresh-xyz',
    }),
  };
}

describe('ExtensionPairService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let auth: ReturnType<typeof makeAuth>;
  let svc: ExtensionPairService;

  beforeEach(() => {
    prisma = makePrisma();
    auth = makeAuth();
    svc = new ExtensionPairService(asPrismaDouble(prisma), asAuthDouble(auth));
    delete process.env.PAIR_CODE_TTL_SECONDS;
  });

  describe('init', () => {
    it('mints a 6-digit code bound to coach + platform and returns expiry', async () => {
      prisma.extensionPairCode.create.mockImplementation(async ({ data }: any) => data);

      const result = await svc.init('coach-1', 'truecoach');

      expect(result.pairing_code).toMatch(/^[0-9]{6}$/);
      expect(typeof result.expires_at).toBe('string');
      expect(Number.isNaN(Date.parse(result.expires_at))).toBe(false);

      const createArg = prisma.extensionPairCode.create.mock.calls[0][0].data;
      expect(createArg.coach_id).toBe('coach-1');
      expect(createArg.chosen_platform).toBe('truecoach');
      expect(createArg.expires_at).toBeInstanceOf(Date);
    });

    it('defaults the TTL to 120s (nominal) when env is unset', async () => {
      prisma.extensionPairCode.create.mockImplementation(async ({ data }: any) => data);
      const before = Date.now();
      const result = await svc.init('coach-1', 'truecoach');
      const ttlMs = Date.parse(result.expires_at) - before;
      expect(ttlMs).toBeGreaterThan(110_000);
      expect(ttlMs).toBeLessThanOrEqual(121_000);
    });

    it('honors PAIR_CODE_TTL_SECONDS within clamp bounds', async () => {
      process.env.PAIR_CODE_TTL_SECONDS = '240';
      prisma.extensionPairCode.create.mockImplementation(async ({ data }: any) => data);
      const before = Date.now();
      const result = await svc.init('coach-1', 'truecoach');
      const ttlMs = Date.parse(result.expires_at) - before;
      expect(ttlMs).toBeGreaterThan(230_000);
      expect(ttlMs).toBeLessThanOrEqual(241_000);
    });

    it('clamps an over-large TTL down to the 300s ceiling', async () => {
      process.env.PAIR_CODE_TTL_SECONDS = '99999';
      prisma.extensionPairCode.create.mockImplementation(async ({ data }: any) => data);
      const before = Date.now();
      const result = await svc.init('coach-1', 'truecoach');
      const ttlMs = Date.parse(result.expires_at) - before;
      expect(ttlMs).toBeLessThanOrEqual(301_000);
    });

    it('retries on a unique-code collision then succeeds', async () => {
      prisma.extensionPairCode.create
        .mockRejectedValueOnce({ code: 'P2002' })
        .mockImplementation(async ({ data }: any) => data);

      const result = await svc.init('coach-1', 'truecoach');
      expect(result.pairing_code).toMatch(/^[0-9]{6}$/);
      expect(prisma.extensionPairCode.create).toHaveBeenCalledTimes(2);
    });

    it('propagates a non-unique DB error immediately', async () => {
      prisma.extensionPairCode.create.mockRejectedValue({ code: 'P1001' });
      await expect(svc.init('coach-1', 'truecoach')).rejects.toMatchObject({ code: 'P1001' });
      expect(prisma.extensionPairCode.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('status', () => {
    it('returns pending for an unused, unexpired, owned code', async () => {
      prisma.extensionPairCode.findUnique.mockResolvedValue(makeRow());
      expect(await svc.status('coach-1', '142856')).toEqual({ status: 'pending' });
    });

    it('returns paired once the code has been redeemed', async () => {
      prisma.extensionPairCode.findUnique.mockResolvedValue(makeRow({ used_at: new Date() }));
      expect(await svc.status('coach-1', '142856')).toEqual({ status: 'paired' });
    });

    it('returns expired for an unused code past its TTL', async () => {
      prisma.extensionPairCode.findUnique.mockResolvedValue(
        makeRow({ expires_at: new Date(Date.now() - 1_000) }),
      );
      expect(await svc.status('coach-1', '142856')).toEqual({ status: 'expired' });
    });

    it('reports expired (never leaks existence) for an unknown code', async () => {
      prisma.extensionPairCode.findUnique.mockResolvedValue(null);
      expect(await svc.status('coach-1', '000000')).toEqual({ status: 'expired' });
    });

    it("reports expired for another coach's code (scoping)", async () => {
      prisma.extensionPairCode.findUnique.mockResolvedValue(makeRow({ coach_id: 'coach-2' }));
      expect(await svc.status('coach-1', '142856')).toEqual({ status: 'expired' });
    });
  });

  describe('redeem', () => {
    it('happy path: claims the code and returns a coach-bound token pair', async () => {
      prisma.extensionPairCode.findUnique.mockResolvedValue(makeRow());
      prisma.extensionPairCode.updateMany.mockResolvedValue({ count: 1 });

      const result = await svc.redeem('142856');

      expect(result).toEqual({
        access_token: 'access-xyz',
        refresh_token: 'refresh-xyz',
        chosen_platform: 'truecoach',
      });
      expect(auth.mintExtensionSessionForCoach).toHaveBeenCalledWith('coach-1');
      // Single-use claim is a conditional update guarded by used_at + expiry.
      const where = prisma.extensionPairCode.updateMany.mock.calls[0][0].where;
      expect(where.id).toBe('row-1');
      expect(where.used_at).toBeNull();
    });

    it('rejects an unknown code with 400 invalid', async () => {
      prisma.extensionPairCode.findUnique.mockResolvedValue(null);
      await expect(svc.redeem('000000')).rejects.toBeInstanceOf(BadRequestException);
      expect(auth.mintExtensionSessionForCoach).not.toHaveBeenCalled();
    });

    it('rejects an already-used code with 410 already_used', async () => {
      prisma.extensionPairCode.findUnique.mockResolvedValue(makeRow({ used_at: new Date() }));
      await expect(svc.redeem('142856')).rejects.toBeInstanceOf(GoneException);
      await expect(svc.redeem('142856')).rejects.toMatchObject({
        response: { code: 'already_used' },
      });
      expect(prisma.extensionPairCode.updateMany).not.toHaveBeenCalled();
    });

    it('rejects an expired code with 410 expired', async () => {
      prisma.extensionPairCode.findUnique.mockResolvedValue(
        makeRow({ expires_at: new Date(Date.now() - 1_000) }),
      );
      await expect(svc.redeem('142856')).rejects.toMatchObject({
        response: { code: 'expired' },
      });
      expect(prisma.extensionPairCode.updateMany).not.toHaveBeenCalled();
    });

    it('treats a lost single-use race (claim count 0) as already_used', async () => {
      prisma.extensionPairCode.findUnique.mockResolvedValue(makeRow());
      prisma.extensionPairCode.updateMany.mockResolvedValue({ count: 0 });
      await expect(svc.redeem('142856')).rejects.toMatchObject({
        response: { code: 'already_used' },
      });
      expect(auth.mintExtensionSessionForCoach).not.toHaveBeenCalled();
    });

    it('does not mint a token when the code is invalid', async () => {
      prisma.extensionPairCode.findUnique.mockResolvedValue(null);
      await expect(svc.redeem('123456')).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.extensionPairCode.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('init — TTL edge cases', () => {
    beforeEach(() => {
      prisma.extensionPairCode.create.mockImplementation(async ({ data }: any) => data);
    });

    it('falls back to the 120s default when the env value is non-numeric', async () => {
      process.env.PAIR_CODE_TTL_SECONDS = 'not-a-number';
      const before = Date.now();
      const result = await svc.init('coach-1', 'truecoach');
      const ttlMs = Date.parse(result.expires_at) - before;
      expect(ttlMs).toBeGreaterThan(110_000);
      expect(ttlMs).toBeLessThanOrEqual(121_000);
    });

    it('clamps a below-floor TTL up to the 30s minimum', async () => {
      process.env.PAIR_CODE_TTL_SECONDS = '1';
      const before = Date.now();
      const result = await svc.init('coach-1', 'truecoach');
      const ttlMs = Date.parse(result.expires_at) - before;
      expect(ttlMs).toBeGreaterThan(29_000);
      expect(ttlMs).toBeLessThanOrEqual(31_000);
    });

    it('gives up with a 400 after exhausting all collision retries', async () => {
      prisma.extensionPairCode.create.mockRejectedValue({ code: 'P2002' });
      await expect(svc.init('coach-1', 'truecoach')).rejects.toBeInstanceOf(BadRequestException);
      // 5 attempts, all colliding.
      expect(prisma.extensionPairCode.create).toHaveBeenCalledTimes(5);
    });

    it('mints a fresh 6-digit code on each call', async () => {
      const seen = new Set<string>();
      for (let i = 0; i < 25; i++) {
        const result = await svc.init('coach-1', 'truecoach');
        expect(result.pairing_code).toMatch(/^[0-9]{6}$/);
        seen.add(result.pairing_code);
      }
      // Not a strict uniqueness guarantee, but a CSPRNG over 10^6 should not
      // collide across 25 draws; this catches an accidental constant code.
      expect(seen.size).toBeGreaterThan(1);
    });
  });

  describe('status — precedence + scoping', () => {
    it('reports paired (used wins) even for a code that is also past expiry', async () => {
      prisma.extensionPairCode.findUnique.mockResolvedValue(
        makeRow({ used_at: new Date(), expires_at: new Date(Date.now() - 1_000) }),
      );
      expect(await svc.status('coach-1', '142856')).toEqual({ status: 'paired' });
    });

    it("does not leak another coach's used code as paired", async () => {
      prisma.extensionPairCode.findUnique.mockResolvedValue(
        makeRow({ coach_id: 'coach-2', used_at: new Date() }),
      );
      expect(await svc.status('coach-1', '142856')).toEqual({ status: 'expired' });
    });

    it('looks the code up by its exact value', async () => {
      prisma.extensionPairCode.findUnique.mockResolvedValue(makeRow());
      await svc.status('coach-1', '142856');
      expect(prisma.extensionPairCode.findUnique).toHaveBeenCalledWith({
        where: { code: '142856' },
      });
    });
  });
});
