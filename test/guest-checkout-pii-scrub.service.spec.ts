import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { PrismaService } from '../src/prisma.service';
import { GuestCheckoutPiiScrubService } from '../src/storefront/guest-checkout-pii-scrub.service';

// Audit #3 P2-3 — daily PII scrub coverage.

describe('GuestCheckoutPiiScrubService', () => {
  let service: GuestCheckoutPiiScrubService;
  let prisma: {
    guestCheckout: { findMany: jest.Mock; updateMany: jest.Mock };
  };
  let config: { get: jest.Mock };

  beforeEach(async () => {
    prisma = {
      guestCheckout: {
        findMany: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    config = {
      get: jest.fn((k: string) =>
        k === 'GUEST_CHECKOUT_PII_SALT' ? 'test-salt' : undefined,
      ),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GuestCheckoutPiiScrubService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();
    service = module.get(GuestCheckoutPiiScrubService);
  });

  it('scopes the scan to rows past retention with no created_user and unscrubbed', async () => {
    prisma.guestCheckout.findMany.mockResolvedValueOnce([]);
    await service.run();
    const where = prisma.guestCheckout.findMany.mock.calls[0][0].where;
    expect(where.data_retention_at).toEqual({
      not: null,
      lte: expect.any(Date),
    });
    expect(where.scrubbed_at).toBeNull();
    expect(where.created_user_id).toBeNull();
  });

  it('hashes guest_email with sha256 + salt and redacts guest_name', async () => {
    prisma.guestCheckout.findMany
      .mockResolvedValueOnce([
        { id: 'gc-old', guest_email: 'Jane@Example.com' },
      ])
      .mockResolvedValueOnce([]);
    await service.run();
    const update = prisma.guestCheckout.updateMany.mock.calls[0][0];
    expect(update.where).toEqual({ id: 'gc-old', scrubbed_at: null });
    expect(update.data.guest_name).toBe('REDACTED');
    expect(update.data.guest_email).toMatch(/^sha256:[a-f0-9]{64}$/);
    // Hash should be stable: lower(email) || salt.
    const expected =
      'sha256:' +
      createHash('sha256').update('jane@example.com').update('test-salt').digest('hex');
    expect(update.data.guest_email).toBe(expected);
    expect(update.data.scrubbed_at).toBeInstanceOf(Date);
  });

  it('paginates: keeps scanning while batches come back full', async () => {
    const full = Array.from({ length: 200 }).map((_, i) => ({
      id: `gc-${i}`,
      guest_email: `user${i}@example.com`,
    }));
    prisma.guestCheckout.findMany
      .mockResolvedValueOnce(full)
      .mockResolvedValueOnce([{ id: 'last', guest_email: 'last@example.com' }])
      .mockResolvedValueOnce([]);
    await service.run();
    // Two batches scrubbed (200 + 1) then a short page exits the loop.
    expect(prisma.guestCheckout.updateMany).toHaveBeenCalledTimes(201);
  });

  it('does not throw when a row update fails', async () => {
    prisma.guestCheckout.findMany
      .mockResolvedValueOnce([{ id: 'gc-broken', guest_email: 'x@y.z' }])
      .mockResolvedValueOnce([]);
    prisma.guestCheckout.updateMany.mockRejectedValueOnce(new Error('boom'));
    await expect(service.run()).resolves.toBeUndefined();
  });
});
