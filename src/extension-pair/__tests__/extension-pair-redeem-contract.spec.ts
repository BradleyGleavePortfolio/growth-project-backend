// The redeem failure contract (DESIGN.md v0.3 §4) is load-bearing: the
// extension popup maps each { code } to a distinct user-facing string, and the
// HTTP status distinguishes "retryable input" (400) from "dead code" (410).
// These tests assert the exact status + structured body for every failure mode,
// and that no token is minted on any failure path.
import { BadRequestException, GoneException, HttpException } from '@nestjs/common';
import { ExtensionPairService } from '../extension-pair.service';
import { asAuthDouble, asPrismaDouble } from './test-doubles.test';

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
      // A failed attempt charges the row; default well under the lockout ceiling
      // so the underlying failure code (e.g. `expired`) is what surfaces.
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

async function captureError(p: Promise<unknown>): Promise<HttpException> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpException) return e;
    throw new Error(`expected an HttpException, got ${String(e)}`);
  }
  throw new Error('expected the redeem promise to reject');
}

describe('ExtensionPairService.redeem — failure contract', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let auth: ReturnType<typeof makeAuth>;
  let svc: ExtensionPairService;

  beforeEach(() => {
    prisma = makePrisma();
    auth = makeAuth();
    svc = new ExtensionPairService(asPrismaDouble(prisma), asAuthDouble(auth));
  });

  it('unknown code → HTTP 400 with { code: "invalid" }', async () => {
    prisma.extensionPairCode.findUnique.mockResolvedValue(null);
    const err = await captureError(svc.redeem('000000'));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getStatus()).toBe(400);
    expect(err.getResponse()).toMatchObject({ code: 'invalid' });
    expect(auth.mintExtensionSessionForCoach).not.toHaveBeenCalled();
  });

  it('already-used code → HTTP 410 with { code: "already_used" }', async () => {
    prisma.extensionPairCode.findUnique.mockResolvedValue(makeRow({ used_at: new Date() }));
    const err = await captureError(svc.redeem('142856'));
    expect(err).toBeInstanceOf(GoneException);
    expect(err.getStatus()).toBe(410);
    expect(err.getResponse()).toMatchObject({ code: 'already_used' });
    expect(prisma.extensionPairCode.updateMany).not.toHaveBeenCalled();
    expect(auth.mintExtensionSessionForCoach).not.toHaveBeenCalled();
  });

  it('expired code → HTTP 410 with { code: "expired" }', async () => {
    prisma.extensionPairCode.findUnique.mockResolvedValue(
      makeRow({ expires_at: new Date(Date.now() - 1_000) }),
    );
    const err = await captureError(svc.redeem('142856'));
    expect(err).toBeInstanceOf(GoneException);
    expect(err.getStatus()).toBe(410);
    expect(err.getResponse()).toMatchObject({ code: 'expired' });
    expect(auth.mintExtensionSessionForCoach).not.toHaveBeenCalled();
  });

  it('locked code (attempt budget exhausted) → HTTP 410 with { code: "locked" }', async () => {
    prisma.extensionPairCode.findUnique.mockResolvedValue(makeRow({ failed_attempts: 5 }));
    const err = await captureError(svc.redeem('142856'));
    expect(err).toBeInstanceOf(GoneException);
    expect(err.getStatus()).toBe(410);
    expect(err.getResponse()).toMatchObject({ code: 'locked' });
    expect(prisma.extensionPairCode.updateMany).not.toHaveBeenCalled();
    expect(auth.mintExtensionSessionForCoach).not.toHaveBeenCalled();
  });

  it('lost single-use race (claim count 0) → HTTP 410 already_used', async () => {
    prisma.extensionPairCode.findUnique.mockResolvedValue(makeRow());
    prisma.extensionPairCode.updateMany.mockResolvedValue({ count: 0 });
    const err = await captureError(svc.redeem('142856'));
    expect(err).toBeInstanceOf(GoneException);
    expect(err.getStatus()).toBe(410);
    expect(err.getResponse()).toMatchObject({ code: 'already_used' });
    expect(auth.mintExtensionSessionForCoach).not.toHaveBeenCalled();
  });

  it('already-used precedence: a code both used AND expired reads as already_used', async () => {
    prisma.extensionPairCode.findUnique.mockResolvedValue(
      makeRow({ used_at: new Date(), expires_at: new Date(Date.now() - 1_000) }),
    );
    const err = await captureError(svc.redeem('142856'));
    expect(err.getResponse()).toMatchObject({ code: 'already_used' });
  });

  it('claims with a used_at NULL + unexpired guard and mints exactly once on success', async () => {
    prisma.extensionPairCode.findUnique.mockResolvedValue(makeRow());
    prisma.extensionPairCode.updateMany.mockResolvedValue({ count: 1 });

    await svc.redeem('142856');

    const call = prisma.extensionPairCode.updateMany.mock.calls[0][0];
    expect(call.where.id).toBe('row-1');
    expect(call.where.used_at).toBeNull();
    expect(call.where.expires_at.gt).toBeInstanceOf(Date);
    expect(call.data.used_at).toBeInstanceOf(Date);
    expect(auth.mintExtensionSessionForCoach).toHaveBeenCalledTimes(1);
  });

  it("binds the minted token to the code's coach, not the caller", async () => {
    prisma.extensionPairCode.findUnique.mockResolvedValue(makeRow({ coach_id: 'coach-99' }));
    prisma.extensionPairCode.updateMany.mockResolvedValue({ count: 1 });
    const result = await svc.redeem('142856');
    expect(auth.mintExtensionSessionForCoach).toHaveBeenCalledWith('coach-99');
    expect(result.chosen_platform).toBe('truecoach');
  });

  it('passes the stored platform through unchanged for each supported source', async () => {
    for (const platform of ['truecoach', 'trainerize', 'mypthub']) {
      auth.mintExtensionSessionForCoach.mockClear();
      prisma.extensionPairCode.findUnique.mockResolvedValue(makeRow({ chosen_platform: platform }));
      prisma.extensionPairCode.updateMany.mockResolvedValue({ count: 1 });
      const result = await svc.redeem('142856');
      expect(result.chosen_platform).toBe(platform);
    }
  });
});
