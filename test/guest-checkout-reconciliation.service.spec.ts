import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../src/prisma.service';
import { GuestCheckoutReconciliationService } from '../src/storefront/guest-checkout-reconciliation.service';
import { GuestCheckoutService } from '../src/storefront/guest-checkout.service';

// Audit #3 P1-6 + P1-7 — reconciliation worker tests. The worker is the
// durable retry path for paid checkouts whose conversion didn't finish
// inline; without it, a crash between Stripe ack and Supabase create
// leaves the buyer paid-but-not-provisioned forever.

describe('GuestCheckoutReconciliationService', () => {
  let service: GuestCheckoutReconciliationService;
  let prisma: { guestCheckout: { findMany: jest.Mock } };
  let guestCheckout: { reconcilePaidCheckout: jest.Mock };

  beforeEach(async () => {
    prisma = {
      guestCheckout: { findMany: jest.fn() },
    };
    guestCheckout = {
      reconcilePaidCheckout: jest.fn().mockResolvedValue(undefined),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GuestCheckoutReconciliationService,
        { provide: PrismaService, useValue: prisma },
        { provide: GuestCheckoutService, useValue: guestCheckout },
      ],
    }).compile();
    service = module.get(GuestCheckoutReconciliationService);
  });

  it('scans conversion_failed_retryable rows with retry_count < 5', async () => {
    prisma.guestCheckout.findMany
      .mockResolvedValueOnce([{ id: 'gc-1' }, { id: 'gc-2' }]) // retryable branch
      .mockResolvedValueOnce([]); // orphaned-paid branch

    await service.run();

    expect(prisma.guestCheckout.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'conversion_failed_retryable',
          retry_count: { lt: 5 },
        }),
      }),
    );
    expect(guestCheckout.reconcilePaidCheckout).toHaveBeenCalledTimes(2);
    expect(guestCheckout.reconcilePaidCheckout).toHaveBeenNthCalledWith(1, 'gc-1');
    expect(guestCheckout.reconcilePaidCheckout).toHaveBeenNthCalledWith(2, 'gc-2');
  });

  it('scans orphaned paid rows (P1-7) past the grace window', async () => {
    prisma.guestCheckout.findMany
      .mockResolvedValueOnce([]) // retryable branch empty
      .mockResolvedValueOnce([{ id: 'gc-orphan' }]); // orphaned-paid

    await service.run();

    const orphanCall = prisma.guestCheckout.findMany.mock.calls[1][0];
    expect(orphanCall.where).toEqual(
      expect.objectContaining({
        status: 'paid',
        created_user_id: null,
        created_at: { lte: expect.any(Date) },
      }),
    );
    expect(guestCheckout.reconcilePaidCheckout).toHaveBeenCalledWith('gc-orphan');
  });

  it('does not throw when a row reconciliation crashes', async () => {
    prisma.guestCheckout.findMany
      .mockResolvedValueOnce([{ id: 'gc-broken' }])
      .mockResolvedValueOnce([]);
    guestCheckout.reconcilePaidCheckout.mockRejectedValueOnce(
      new Error('boom'),
    );

    // run() must never throw — a cron crash would freeze the worker.
    await expect(service.run()).resolves.toBeUndefined();
  });

  it('does not throw when Prisma findMany crashes', async () => {
    prisma.guestCheckout.findMany.mockRejectedValueOnce(
      new Error('prisma down'),
    );
    await expect(service.run()).resolves.toBeUndefined();
    // Worker never proceeds to a second branch on a top-level crash —
    // we still want a benign return.
    expect(guestCheckout.reconcilePaidCheckout).not.toHaveBeenCalled();
  });
});
