import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { HirerVerifiedGuard } from '../hirer-verified.guard';

type SubRow = { status: string } | null;

function makeGuard(opts: {
  subCoachRows?: number;
  subscription?: SubRow;
}): {
  guard: HirerVerifiedGuard;
  count: jest.Mock;
  findUnique: jest.Mock;
} {
  const count = jest.fn(() => opts.subCoachRows ?? 0);
  const findUnique = jest.fn(() => opts.subscription ?? null);
  const prisma = Object.assign(
    Object.create(PrismaService.prototype) as PrismaService,
    {
      teamSubCoachAssignment: { count },
      coachSubscription: { findUnique },
    },
  );
  return { guard: new HirerVerifiedGuard(prisma), count, findUnique };
}

// A typed, minimal ExecutionContext exposing only switchToHttp().getRequest()
// — same idiom as src/community/ack/ack.controller.spec.ts.
function ctx(user: { id: string; role: string } | null): ExecutionContext {
  const partial: Pick<ExecutionContext, 'switchToHttp'> = {
    switchToHttp: () =>
      ({ getRequest: () => ({ user }) }) as ReturnType<
        ExecutionContext['switchToHttp']
      >,
  };
  return partial as ExecutionContext;
}

describe('HirerVerifiedGuard', () => {
  it('allows a gym owner without touching subscription state', async () => {
    const { guard, findUnique } = makeGuard({});
    await expect(
      guard.canActivate(ctx({ id: 'o1', role: 'owner' })),
    ).resolves.toBe(true);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('allows a head coach with an active subscription', async () => {
    const { guard } = makeGuard({
      subCoachRows: 0,
      subscription: { status: 'active' },
    });
    await expect(
      guard.canActivate(ctx({ id: 'c1', role: 'coach' })),
    ).resolves.toBe(true);
  });

  it('allows a trialing or grandfathered coach', async () => {
    for (const status of ['trialing', 'grandfathered']) {
      const { guard } = makeGuard({ subscription: { status } });
      await expect(
        guard.canActivate(ctx({ id: 'c1', role: 'coach' })),
      ).resolves.toBe(true);
    }
  });

  it('rejects a sub-coach (non-archived assignment)', async () => {
    const { guard, findUnique } = makeGuard({ subCoachRows: 1 });
    await expect(
      guard.canActivate(ctx({ id: 'sc1', role: 'coach' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(findUnique).not.toHaveBeenCalled();
  });

  // TM-P1: no coach plans, so an inactive or missing subscription row never blocks hiring.
  it('TM-P1: allows a coach with an inactive subscription row, without reading it', async () => {
    for (const status of ['past_due', 'canceled']) {
      const { guard, findUnique } = makeGuard({ subscription: { status } });
      await expect(guard.canActivate(ctx({ id: 'c1', role: 'coach' }))).resolves.toBe(true);
      expect(findUnique).not.toHaveBeenCalled();
    }
  });

  it('TM-P1: allows a coach with no subscription row', async () => {
    const { guard } = makeGuard({ subscription: null });
    await expect(
      guard.canActivate(ctx({ id: 'c1', role: 'coach' })),
    ).resolves.toBe(true);
  });

  it('rejects a student', async () => {
    const { guard } = makeGuard({});
    await expect(
      guard.canActivate(ctx({ id: 's1', role: 'student' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects an unauthenticated request', async () => {
    const { guard } = makeGuard({});
    await expect(guard.canActivate(ctx(null))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
