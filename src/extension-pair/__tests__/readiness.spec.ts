/**
 * S11-C readiness block (docs/decisions/2026-09-26-s11-journey.md D-S11-5, D-S11-8 row S11-C;
 * §3 J17). Unit level: the setup reads `session` and `current` carry an optional, read-only,
 * owner-scoped `readiness` block derived from the bound server run and its S10-B declaration
 * rows. Counts only; unknown stays unknown; the wording never claims source authorization.
 */
import 'reflect-metadata';
import { ExtensionPairService } from '../extension-pair.service';
import { PairReadiness, PairSessionResult, READINESS_RUN_STATES } from '../extension-pair.dto';
import { asAuthDouble, asPrismaDouble } from './test-doubles.test';

const intent = '5b0c7f1e-8a39-4f55-9d3c-1f2a3b4c5d6e';
const DIGEST = 'a'.repeat(64);
const CHALLENGE_HEX = 'c'.repeat(64);
const activeCoach = { role: { in: ['coach', 'owner'] }, deleted_at: null };

type RunRow = { terminal_status: string | null; declarations: { source_platform: string }[] };

function setup(run: RunRow | null | Error, setupRow?: object | null) {
  const stored =
    setupRow === undefined
      ? {
          id: intent,
          coach_id: 'coach-1',
          chosen_platform: 'label-only',
          paired_at: new Date(1),
          superseded_at: null,
          challenge: { expires_at: new Date(0), failed_attempts: 0 },
        }
      : setupRow;
  const findRun = jest.fn(async () => {
    if (run instanceof Error) throw run;
    return run;
  });
  const prisma = {
    importIntent: { findFirst: jest.fn().mockResolvedValue(stored) },
    scoutImport: { findFirst: findRun },
    // Write surfaces that must never be touched by a setup read.
    $executeRaw: jest.fn(),
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
    scoutRunDeclaration: { findMany: jest.fn(), create: jest.fn() },
  };
  const auth = { mintExtensionSessionForCoach: jest.fn() };
  const svc = new ExtensionPairService(asPrismaDouble(prisma), asAuthDouble(auth));
  return { prisma, auth, svc, findRun };
}

const RUN_QUERY = {
  where: { coach_id: 'coach-1', import_intent_id: intent, mode: 'server' },
  select: { terminal_status: true, declarations: { select: { source_platform: true } } },
};

function expectNoWrites(
  prisma: ReturnType<typeof setup>['prisma'],
  auth: ReturnType<typeof setup>['auth'],
) {
  expect(prisma.$executeRaw).not.toHaveBeenCalled();
  expect(prisma.$queryRaw).not.toHaveBeenCalled();
  expect(prisma.$transaction).not.toHaveBeenCalled();
  expect(prisma.scoutRunDeclaration.findMany).not.toHaveBeenCalled();
  expect(prisma.scoutRunDeclaration.create).not.toHaveBeenCalled();
  expect(auth.mintExtensionSessionForCoach).not.toHaveBeenCalled();
}

describe('S11-C setup readiness (D-S11-5)', () => {
  it('no server run: none, not declared, platform count null (never 0)', async () => {
    const { svc, prisma, auth, findRun } = setup(null);
    const r = await svc.session('coach-1', intent);
    expect(r).toEqual({
      status: 'paired',
      import_intent_id: intent,
      chosen_platform: 'label-only',
      readiness: { run: 'none', source_declared: false, declared_platforms: null },
    });
    expect(findRun).toHaveBeenCalledTimes(1);
    expect(findRun).toHaveBeenCalledWith(RUN_QUERY);
    expectNoWrites(prisma, auth);
  });

  it('open run without declarations: open, not declared, zero platforms', async () => {
    const { svc } = setup({ terminal_status: null, declarations: [] });
    expect((await svc.session('coach-1', intent)).readiness).toEqual({
      run: 'open',
      source_declared: false,
      declared_platforms: 0,
    });
  });

  it('counts DISTINCT platforms only; no names, digests or challenge', async () => {
    const { svc } = setup({
      terminal_status: null,
      declarations: [
        { source_platform: 'synthetic-alpha' },
        { source_platform: 'synthetic-alpha' },
        { source_platform: 'synthetic-beta' },
      ],
    });
    const r = await svc.session('coach-1', intent);
    expect(r.readiness).toEqual({ run: 'open', source_declared: true, declared_platforms: 2 });
    const body = JSON.stringify(r);
    for (const secret of ['synthetic-alpha', 'synthetic-beta', DIGEST, CHALLENGE_HEX]) {
      expect(body).not.toContain(secret);
    }
    expect(Object.keys(r.readiness ?? {}).sort()).toEqual([
      'declared_platforms',
      'run',
      'source_declared',
    ]);
  });

  it('terminal run: terminal only, never its status or reason', async () => {
    const { svc } = setup({
      terminal_status: 'complete',
      declarations: [{ source_platform: 'x' }],
    });
    const r = await svc.session('coach-1', intent);
    expect(r.readiness).toEqual({ run: 'terminal', source_declared: true, declared_platforms: 1 });
    expect(JSON.stringify(r)).not.toContain('complete');
  });

  it('current() carries the block, scoped by caller and setup row id', async () => {
    const { svc, prisma, findRun } = setup({ terminal_status: null, declarations: [] });
    const r = await svc.current('coach-1');
    expect(r.readiness).toEqual({ run: 'open', source_declared: false, declared_platforms: 0 });
    expect(prisma.importIntent.findFirst).toHaveBeenCalledWith({
      where: { superseded_at: null, coach_id: 'coach-1', coach: activeCoach },
      include: { challenge: { select: { expires_at: true, failed_attempts: true } } },
    });
    expect(findRun).toHaveBeenCalledWith(RUN_QUERY);
  });

  it('foreign or unknown setup: the existing uniform 404, and the run is never read', async () => {
    const { svc, findRun } = setup({ terminal_status: null, declarations: [] }, null);
    await expect(svc.session('coach-2', intent)).rejects.toMatchObject({ status: 404 });
    await expect(svc.current('coach-2')).rejects.toMatchObject({ status: 404 });
    expect(findRun).not.toHaveBeenCalled();
  });

  it('read failure: the block is ABSENT (unknown), setup recovery still answers', async () => {
    const { svc } = setup(new Error('db unavailable'));
    const r: PairSessionResult = await svc.session('coach-1', intent);
    expect(r).toEqual({
      status: 'paired',
      import_intent_id: intent,
      chosen_platform: 'label-only',
    });
    expect(Object.prototype.hasOwnProperty.call(r, 'readiness')).toBe(false);
  });

  it('double with NO run table: block absent, setup still answers (no throw)', async () => {
    const prisma = {
      importIntent: {
        findFirst: jest.fn().mockResolvedValue({
          id: intent,
          coach_id: 'coach-1',
          chosen_platform: 'label-only',
          paired_at: null,
          superseded_at: null,
          challenge: { expires_at: new Date(Date.now() + 60_000), failed_attempts: 0 },
        }),
      },
    };
    const auth = { mintExtensionSessionForCoach: jest.fn() };
    const svc = new ExtensionPairService(asPrismaDouble(prisma), asAuthDouble(auth));
    for (const r of [await svc.session('coach-1', intent), await svc.current('coach-1')]) {
      expect(r).toEqual({
        status: 'pending',
        import_intent_id: intent,
        chosen_platform: 'label-only',
      });
      expect(r).not.toHaveProperty('readiness');
    }
    expect(auth.mintExtensionSessionForCoach).not.toHaveBeenCalled();
  });

  it('wording: neutral "declaration received"; optional; closed vocabulary', () => {
    const key = 'swagger/apiModelProperties';
    const declared = Reflect.getMetadata(key, PairReadiness.prototype, 'source_declared');
    expect(declared.description).toContain('"declaration received"');
    expect(declared.description).toContain('never as source authorized, ready or connected');
    const run = Reflect.getMetadata(key, PairReadiness.prototype, 'run');
    expect(run.enum).toEqual(['none', 'open', 'terminal']);
    expect([...READINESS_RUN_STATES]).toEqual(['none', 'open', 'terminal']);
    const count = Reflect.getMetadata(key, PairReadiness.prototype, 'declared_platforms');
    expect(count.nullable).toBe(true);
    const block = Reflect.getMetadata(key, PairSessionResult.prototype, 'readiness');
    expect(block.required).toBe(false);
  });
});
