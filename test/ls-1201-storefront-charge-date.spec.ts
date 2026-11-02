import { Test } from '@nestjs/testing';
import { PrismaService } from '../src/prisma.service';
import { CheckoutService } from '../src/checkout/checkout.service';
import { ThankYouService } from '../src/storefront/thank-you.service';
import { renderThankYouPage } from '../src/storefront/thank-you.html';
import { buyerChargeDay } from '../src/storefront/pay-page.html';

describe('LS-1201 B1: every live storefront Next charge row uses the Pacific day', () => {
  const RealDateTimeFormat = Intl.DateTimeFormat;

  beforeEach(() => {
    // Model the UTC backend host, without depending on the test runner's zone.
    jest.spyOn(Intl, 'DateTimeFormat').mockImplementation(
      (locales, options) => new RealDateTimeFormat(locales, { timeZone: 'UTC', ...options }),
    );
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['17:30 PDT', '2026-09-09T00:30:00Z', 'Sep 8, 2026'],
    ['16:30 PST', '2026-12-09T00:30:00Z', 'Dec 8, 2026'],
    ['fall transition week', '2026-11-03T00:30:00Z', 'Nov 2, 2026'],
    ['spring transition week', '2026-03-13T01:30:00Z', 'Mar 12, 2026'],
    ['morning control', '2026-09-08T16:30:00Z', 'Sep 8, 2026'],
  ])('LS-1201 B1: hosted checkout return at %s agrees with the pay page', async (_label, iso, expected) => {
    const purchase = {
      id: 'purchase-date-proof', client_user_id: 'buyer-date-proof',
      stripe_checkout_session_id: 'session-date-proof',
      entitlement_active: true, billing_type: 'recurring',
      current_period_end: new Date(iso), amount_cents: 14900, currency: 'usd',
      package: { name: 'Monthly coaching' },
    };
    const db = { clientPurchase: { findFirst: jest.fn(async () => purchase) } };
    const checkout = { listDropsForBuyer: jest.fn(async () => ({ drops: [] })) };
    const module = await Test.createTestingModule({
      providers: [
        ThankYouService,
        { provide: PrismaService, useValue: db },
        { provide: CheckoutService, useValue: checkout },
      ],
    }).compile();
    try {
      const view = await module.get(ThankYouService).buildViewModel('session-date-proof');
      const html = renderThankYouPage(view);
      const match = html.match(/<span>Next charge<\/span><strong>([^<]+)<\/strong>/);
      expect(db.clientPurchase.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { stripe_checkout_session_id: 'session-date-proof' } }),
      );
      expect(checkout.listDropsForBuyer).toHaveBeenCalledWith('buyer-date-proof', 'purchase-date-proof');
      expect(buyerChargeDay(iso, 'short')).toBe(expected.replace(', 2026', ''));
      expect(match?.[1]).toBe(expected);
    } finally {
      await module.close();
    }
  });
});
