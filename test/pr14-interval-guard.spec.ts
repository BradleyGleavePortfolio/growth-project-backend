import { BadRequestException } from '@nestjs/common';
import { CheckoutService } from '../src/checkout/checkout.service';

// PR-14 R2 P2-2 — runtime guard on pkg.interval. CoachPackage.interval is
// a free-form Prisma String?; without this guard a corrupt value (typo,
// future migration drift) would round-trip to Stripe and surface an
// opaque 400 to the buyer. assertStripeInterval refuses anything outside
// week|month|year up front.

describe('CheckoutService.assertStripeInterval (PR-14 R2 P2-2)', () => {
  it.each([
    ['week' as const],
    ['month' as const],
    ['year' as const],
  ])('returns the literal for a valid Stripe interval: %s', (interval) => {
    expect(CheckoutService.assertStripeInterval(interval, 'pkg-1')).toBe(
      interval,
    );
  });

  it.each(['daily', 'hour', 'WEEK', 'mensual', '', null, undefined])(
    'rejects invalid / corrupt interval %p with BadRequestException',
    (interval) => {
      expect(() =>
        CheckoutService.assertStripeInterval(
          interval as unknown as string,
          'pkg-corrupt',
        ),
      ).toThrow(BadRequestException);
    },
  );

  it('error envelope carries the packageId so operators can identify the bad row', () => {
    try {
      CheckoutService.assertStripeInterval('daily', 'pkg-corrupt-id');
      fail('expected throw');
    } catch (err) {
      const e = err as BadRequestException;
      const resp = e.getResponse() as { error: string; message: string };
      expect(resp.error).toBe('PACKAGE_INTERVAL_INVALID');
      expect(resp.message).toContain('pkg-corrupt-id');
      expect(resp.message).toContain('daily');
    }
  });
});
