import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../src/prisma.service';
import { PackagesService } from '../src/packages/packages.service';
import { InviteGrantService } from '../src/invite-grant/invite-grant.service';

describe('LS-1TO1: invite grants obey the same coaching rule as a native purchase', () => {
  function fixture(blocked: boolean, mode: 'free' | 'prepaid') {
    const client = {
      id: 'buyer', role: 'student', coach_id: 'coach',
      email: 'buyer@example.test', name: 'Buyer',
    };
    const pkg = {
      id: 'package', coach_id: 'coach', name: 'Coaching',
      amount_cents: mode === 'free' ? 0 : 4900,
      currency: 'usd', billing_type: 'one_time', duration_periods: null,
      is_active: true, archived_at: null, published_at: new Date(),
      requires_contract: false, contract_template_id: null,
    };
    const upsert = jest.fn(async ({ create }: { create: Record<string, unknown> }) => ({
      id: 'purchase', ...create,
    }));
    const db = {
      coachPackage: {
        findUnique: jest.fn(async ({ where }: { where: { coach?: unknown } }) => (
          where.coach && blocked ? null : pkg
        )),
      },
      coachProfile: {
        findUnique: jest.fn(async () => ({
          user_id: 'coach', invite_code: 'COACH-CODE',
          invite_code_package_id: pkg.id, invite_code_grant_mode: mode,
        })),
      },
      user: { findUnique: jest.fn(async () => client) },
      clientPurchase: { findUnique: jest.fn(async () => null), upsert },
      $transaction: jest.fn(),
    };
    db.$transaction.mockImplementation(async (run) => run(db));
    const prisma = db as unknown as PrismaService;
    const grants = new InviteGrantService(
      prisma, { write: jest.fn(async () => undefined) } as never,
      undefined, undefined, { isGranted: jest.fn(async () => true) } as never,
    );
    return {
      client, pkg, upsert, grants,
      packages: new PackagesService(prisma, {} as never),
    };
  }

  it.each(['free', 'prepaid'] as const)('still grants an ordinary %s code', async (mode) => {
    const f = fixture(false, mode);
    await expect(f.grants.claimGrantForCode(f.client, 'COACH-CODE')).resolves.toMatchObject({
      status: 'created',
    });
    expect(f.upsert).toHaveBeenCalledTimes(1);
  });

  it.each(['free', 'prepaid'] as const)(
    'refuses a %s code for a buyer blocked from coaching with its seller',
    async (mode) => {
      const f = fixture(true, mode);
      await expect(f.packages.getById(f.pkg.id, f.client.id)).resolves.toBeNull();
      await expect(f.grants.claimGrantForCode(f.client, 'COACH-CODE')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(f.upsert).not.toHaveBeenCalled();
    },
  );
});
