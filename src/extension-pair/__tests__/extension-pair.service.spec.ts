import { BadRequestException, GoneException } from '@nestjs/common';
import { ExtensionPairService } from '../extension-pair.service';
import { asAuthDouble, asPrismaDouble } from './test-doubles.test';

// Minimal in-shape doubles. We drive the service directly with mocked Prisma +
// AuthService so no network / DB is touched (DESIGN.md v0.3 §11: hermetic).

interface Row {
  id: string;
  code: string;
  coach_id: string;
  chosen_platform: string;
  expires_at: Date;
  used_at: Date | null;
  failed_attempts: number;
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
    failed_attempts: 0,
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
      // A failed attempt charges the row; default stays well under the lockout
      // ceiling so the underlying failure code surfaces unless a test overrides.
      update: jest.fn().mockResolvedValue({ failed_attempts: 1 }),
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

    // Single-active-code invariant (round-2): a fresh mint supersedes every
    // prior still-live code for the same coach.
    it('expires prior live codes for the coach after a successful mint, sparing the new one', async () => {
      prisma.extensionPairCode.create.mockImplementation(async ({ data }: any) => data);

      const result = await svc.init('coach-1', 'truecoach');

      expect(prisma.extensionPairCode.updateMany).toHaveBeenCalledTimes(1);
      const call = prisma.extensionPairCode.updateMany.mock.calls[0][0];
      // Scoped to the minting coach's still-live (unused + unexpired) codes…
      expect(call.where.coach_id).toBe('coach-1');
      expect(call.where.used_at).toBeNull();
      expect(call.where.expires_at.gt).toBeInstanceOf(Date);
      // …excluding the code minted in THIS call (codes are unique).
      expect(call.where.code).toEqual({ not: result.pairing_code });
      // Prior codes are expired immediately, not deleted (audit trail intact).
      expect(call.data.expires_at).toBeInstanceOf(Date);
      expect(call.data.expires_at.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('does not touch existing codes when the mint itself fails', async () => {
      // A failed mint must never nuke a coach's existing valid code — the
      // invalidation runs only AFTER a successful create.
      prisma.extensionPairCode.create.mockRejectedValue({ code: 'P2002' });
      await expect(svc.init('coach-1', 'truecoach')).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.extensionPairCode.updateMany).not.toHaveBeenCalled();
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
      // Mint-then-claim: the loser may have minted (mint is DB-stateless), but
      // its session is orphaned — never returned to the caller.
      expect(auth.mintExtensionSessionForCoach).toHaveBeenCalledTimes(1);
    });

    // Mint-then-claim atomicity (round-2, accepted): a mint failure must never
    // burn the code — used_at stays NULL so the coach can retry.
    it('does not flip used_at when the mint rejects (demoted coach) — code stays retryable', async () => {
      prisma.extensionPairCode.findUnique.mockResolvedValue(makeRow());
      auth.mintExtensionSessionForCoach.mockRejectedValue(
        new BadRequestException({ code: 'invalid', message: 'Invalid pairing code.' }),
      );
      await expect(svc.redeem('142856')).rejects.toMatchObject({
        response: { code: 'invalid' },
      });
      // The single-use claim never fires, so used_at was never set.
      expect(prisma.extensionPairCode.updateMany).not.toHaveBeenCalled();
    });

    it('does not flip used_at when the mint fails transiently (Supabase error)', async () => {
      prisma.extensionPairCode.findUnique.mockResolvedValue(makeRow());
      auth.mintExtensionSessionForCoach.mockRejectedValue(new Error('supabase down'));
      await expect(svc.redeem('142856')).rejects.toThrow('supabase down');
      expect(prisma.extensionPairCode.updateMany).not.toHaveBeenCalled();
    });

    it('claims the code only AFTER a successful mint (mint-then-claim order)', async () => {
      const order: string[] = [];
      prisma.extensionPairCode.findUnique.mockResolvedValue(makeRow());
      auth.mintExtensionSessionForCoach.mockImplementation(async () => {
        order.push('mint');
        return { access_token: 'access-xyz', refresh_token: 'refresh-xyz' };
      });
      prisma.extensionPairCode.updateMany.mockImplementation(async () => {
        order.push('claim');
        return { count: 1 };
      });
      await svc.redeem('142856');
      expect(order).toEqual(['mint', 'claim']);
    });

    it('valid claim then a demoted mint: caller sees invalid and the code is NOT burned', async () => {
      // Service-level demotion race: the row is perfectly valid at redeem time,
      // but the coach was demoted between init and redeem so the mint rejects
      // with the generic invalid body. The redeem must surface that same body
      // and must NOT leave used_at set — no write ever reaches the row.
      prisma.extensionPairCode.findUnique.mockResolvedValue(makeRow({ failed_attempts: 0 }));
      auth.mintExtensionSessionForCoach.mockRejectedValue(
        new BadRequestException({ code: 'invalid', message: 'Invalid pairing code.' }),
      );
      await expect(svc.redeem('142856')).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.extensionPairCode.updateMany).not.toHaveBeenCalled();
      expect(prisma.extensionPairCode.update).not.toHaveBeenCalled();
    });

    it('does not mint a token when the code is invalid', async () => {
      prisma.extensionPairCode.findUnique.mockResolvedValue(null);
      await expect(svc.redeem('123456')).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.extensionPairCode.updateMany).not.toHaveBeenCalled();
    });

    it('rejects as invalid when the stored code fails the constant-time compare', async () => {
      // Defence in depth: even if a row surfaces whose stored code does not
      // byte-equal the presented one, the timing-safe compare must reject it as
      // `invalid` (never claim it) — the row lookup alone is not the authority.
      prisma.extensionPairCode.findUnique.mockResolvedValue(makeRow({ code: '999999' }));
      await expect(svc.redeem('142856')).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.extensionPairCode.updateMany).not.toHaveBeenCalled();
      expect(auth.mintExtensionSessionForCoach).not.toHaveBeenCalled();
    });
  });

  // Per-code brute-force lockout (P2). MAX = 5 (REDEEM_MAX_FAILED_ATTEMPTS).
  describe('redeem — per-code lockout', () => {
    const MAX = 5;

    it('still redeems a valid code sitting at MAX-1 prior failed attempts', async () => {
      prisma.extensionPairCode.findUnique.mockResolvedValue(makeRow({ failed_attempts: MAX - 1 }));
      prisma.extensionPairCode.updateMany.mockResolvedValue({ count: 1 });

      const result = await svc.redeem('142856');

      expect(result.access_token).toBe('access-xyz');
      // The atomic claim itself must refuse to fire at/above the ceiling.
      const where = prisma.extensionPairCode.updateMany.mock.calls[0][0].where;
      expect(where.failed_attempts).toEqual({ lt: MAX });
    });

    it('locks a code that has reached MAX failed attempts (410 locked, no mint)', async () => {
      prisma.extensionPairCode.findUnique.mockResolvedValue(makeRow({ failed_attempts: MAX }));
      await expect(svc.redeem('142856')).rejects.toMatchObject({ response: { code: 'locked' } });
      await expect(svc.redeem('142856')).rejects.toBeInstanceOf(GoneException);
      expect(prisma.extensionPairCode.updateMany).not.toHaveBeenCalled();
      expect(auth.mintExtensionSessionForCoach).not.toHaveBeenCalled();
    });

    it('charges a failed attempt when an expired code is hammered', async () => {
      prisma.extensionPairCode.findUnique.mockResolvedValue(
        makeRow({ expires_at: new Date(Date.now() - 1_000), failed_attempts: 1 }),
      );
      prisma.extensionPairCode.update.mockResolvedValue({ failed_attempts: 2 });

      await expect(svc.redeem('142856')).rejects.toMatchObject({ response: { code: 'expired' } });
      expect(prisma.extensionPairCode.update).toHaveBeenCalledWith({
        where: { id: 'row-1' },
        data: { failed_attempts: { increment: 1 } },
        select: { failed_attempts: true },
      });
    });

    it('the Nth failed attempt flips the response from expired to locked', async () => {
      prisma.extensionPairCode.findUnique.mockResolvedValue(
        makeRow({ expires_at: new Date(Date.now() - 1_000), failed_attempts: MAX - 1 }),
      );
      // The increment tips the counter to MAX → the caller sees `locked`.
      prisma.extensionPairCode.update.mockResolvedValue({ failed_attempts: MAX });

      await expect(svc.redeem('142856')).rejects.toMatchObject({ response: { code: 'locked' } });
    });

    it('does not charge a failed attempt on a benign lost single-use race', async () => {
      // A lost race means another redeem legitimately WON the code — that is a
      // success elsewhere, not a brute-force miss, so it must not burn budget.
      prisma.extensionPairCode.findUnique.mockResolvedValue(makeRow());
      prisma.extensionPairCode.updateMany.mockResolvedValue({ count: 0 });
      await expect(svc.redeem('142856')).rejects.toMatchObject({
        response: { code: 'already_used' },
      });
      expect(prisma.extensionPairCode.update).not.toHaveBeenCalled();
    });

    it('reports locked (not already_used) for a code that is both used AND at MAX', async () => {
      // Lockout precedence: a harvested code that was redeemed once and then
      // hammered to the ceiling must read as terminally `locked`, not leak the
      // softer `already_used` — the two share a 410 but a coach re-mints on
      // either, and `locked` is the truthful terminal state.
      prisma.extensionPairCode.findUnique.mockResolvedValue(
        makeRow({ used_at: new Date(), failed_attempts: MAX }),
      );
      await expect(svc.redeem('142856')).rejects.toMatchObject({ response: { code: 'locked' } });
    });

    it('reports locked without charging further once an expired code is already at MAX', async () => {
      // Precedence again: past the ceiling the increment path is short-circuited,
      // so a locked+expired code neither over-counts nor downgrades to `expired`.
      prisma.extensionPairCode.findUnique.mockResolvedValue(
        makeRow({ expires_at: new Date(Date.now() - 1_000), failed_attempts: MAX }),
      );
      await expect(svc.redeem('142856')).rejects.toMatchObject({ response: { code: 'locked' } });
      expect(prisma.extensionPairCode.update).not.toHaveBeenCalled();
    });

    it('does not charge a failed attempt on the happy-path claim', async () => {
      // A successful redeem is not a brute-force miss; the attempt counter must
      // stay untouched so a legitimate holder never edges toward lockout.
      prisma.extensionPairCode.findUnique.mockResolvedValue(makeRow({ failed_attempts: 2 }));
      prisma.extensionPairCode.updateMany.mockResolvedValue({ count: 1 });
      await svc.redeem('142856');
      expect(prisma.extensionPairCode.update).not.toHaveBeenCalled();
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
