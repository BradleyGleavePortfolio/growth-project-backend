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

// Builds just the slice of ExecutionContext the guard reads
// (switchToHttp().getRequest()), assembled onto a fresh object typed as
// Pick<ExecutionContext, 'switchToHttp'> so no whole-context cast is needed.
function ctx(user: { id: string; role: string } | null): ExecutionContext {
  const partial: Pick<ExecutionContext, 'switchToHttp'> = {
    switchToHttp: () => ({
      getRequest: () => ({ user }),
      getResponse: () => ({}),
      getNext: () => ({}),
    }),
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

  it('rejects a coach with a past_due subscription', async () => {
    const { guard } = makeGuard({ subscription: { status: 'past_due' } });
    await expect(
      guard.canActivate(ctx({ id: 'c1', role: 'coach' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a coach with no subscription row', async () => {
    const { guard } = makeGuard({ subscription: null });
    await expect(
      guard.canActivate(ctx({ id: 'c1', role: 'coach' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
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
