import { NotFoundException } from '@nestjs/common';
import { ThankYouService } from '../src/storefront/thank-you.service';
import { renderThankYouPage } from '../src/storefront/thank-you.html';

// PR-15A A3 — SSR thank-you page.
//
// Verifies the brief invariants:
//   - drops (delivered + upcoming) surface on the page
//   - receipt summary renders amount + package
//   - recurring purchase renders next-charge
//   - unknown session id → 404
//   - not-yet-entitled purchase → 404 (no misleading empty page)
//   - empty drop list still renders a calm "your coach is finalising"
//     message — no broken state
//   - reuses listDropsForBuyer buyer-scoped to the just-converted purchase
//   - all buyer/coach strings escape HTML

const PURCHASE = {
  id: 'pur_1',
  stripe_checkout_session_id: 'cs_test_abc',
  client_user_id: 'buyer_1',
  package_id: 'pkg_1',
  amount_cents: 9900,
  currency: 'usd',
  billing_type: 'one_time',
  entitlement_active: true,
  current_period_end: null,
  package: { name: 'Pro Strength 12-Week' },
};

function makePrisma(state: { purchases: any[] }) {
  return {
    clientPurchase: {
      findFirst: jest.fn(async ({ where }: any) =>
        state.purchases.find(
          (p) => p.stripe_checkout_session_id === where.stripe_checkout_session_id,
        ) ?? null,
      ),
    },
  };
}

describe('ThankYouService (PR-15A A3)', () => {
  it('renders unlocked + upcoming drops and a receipt summary', async () => {
    const prisma = makePrisma({ purchases: [PURCHASE] });
    const checkout = {
      listDropsForBuyer: jest.fn(async (_buyerId: string, _purchaseId: string) => ({
        drops: [
          {
            id: 'd_fired',
            asset_type: 'workout_program',
            asset_id: 'a1',
            asset_revision_id: null,
            cadence_kind: 'immediate',
            display_title: 'Week 1: Foundation',
            display_caption: null,
            fire_at: new Date('2026-01-10T00:00:00Z'),
            fired_at: new Date('2026-01-10T00:00:00Z'),
            status: 'fired',
            materialised_ref: 'assignment-1',
          },
          {
            id: 'd_pending',
            asset_type: 'meal_plan',
            asset_id: 'a2',
            asset_revision_id: null,
            cadence_kind: 'relative_to_purchase',
            display_title: 'Day 7 reset meal',
            display_caption: null,
            fire_at: new Date('2026-01-22T00:00:00Z'),
            fired_at: null,
            status: 'pending',
            materialised_ref: null,
          },
        ],
      })),
    };
    const svc = new ThankYouService(prisma as never, checkout as never);
    const vm = await svc.buildViewModel('cs_test_abc');
    expect(vm.packageName).toBe('Pro Strength 12-Week');
    expect(vm.amountFormatted).toBe('$99.00');
    expect(vm.isRecurring).toBe(false);
    expect(vm.unlocked.map((d) => d.id)).toEqual(['d_fired']);
    expect(vm.upcoming.map((d) => d.id)).toEqual(['d_pending']);

    const html = renderThankYouPage(vm);
    expect(html).toMatch(/Pro Strength 12-Week/);
    expect(html).toMatch(/\$99\.00/);
    expect(html).toMatch(/Week 1: Foundation/);
    expect(html).toMatch(/Day 7 reset meal/);
    expect(html).toMatch(/Unlocked now/);
    expect(html).toMatch(/Coming up/);

    // The service called listDropsForBuyer buyer-scoped to the
    // just-converted purchase's owner — proves A3's reuse contract.
    expect(checkout.listDropsForBuyer).toHaveBeenCalledWith('buyer_1', 'pur_1');
  });

  it('recurring purchase renders next-charge', async () => {
    const recurring = {
      ...PURCHASE,
      billing_type: 'recurring',
      current_period_end: new Date('2026-02-15T00:00:00Z'),
    };
    const prisma = makePrisma({ purchases: [recurring] });
    const checkout = {
      listDropsForBuyer: jest.fn(async () => ({ drops: [] })),
    };
    const svc = new ThankYouService(prisma as never, checkout as never);
    const vm = await svc.buildViewModel('cs_test_abc');
    expect(vm.isRecurring).toBe(true);
    expect(vm.nextChargeAt).toEqual(new Date('2026-02-15T00:00:00Z'));
    const html = renderThankYouPage(vm);
    expect(html).toMatch(/Next charge/);
    expect(html).toMatch(/Feb 14|Feb 15/); // tz-dependent on the test runner
  });

  it('only-future drops still renders the upcoming schedule (no broken state)', async () => {
    const prisma = makePrisma({ purchases: [PURCHASE] });
    const checkout = {
      listDropsForBuyer: jest.fn(async () => ({
        drops: [
          {
            id: 'd_pending',
            asset_type: 'workout_program',
            asset_id: 'a1',
            asset_revision_id: null,
            cadence_kind: 'fixed_calendar',
            display_title: 'Week 2',
            display_caption: null,
            fire_at: new Date('2026-02-01T00:00:00Z'),
            fired_at: null,
            status: 'pending',
            materialised_ref: null,
          },
        ],
      })),
    };
    const svc = new ThankYouService(prisma as never, checkout as never);
    const vm = await svc.buildViewModel('cs_test_abc');
    expect(vm.unlocked).toEqual([]);
    expect(vm.upcoming.length).toBe(1);
    const html = renderThankYouPage(vm);
    expect(html).toMatch(/Coming up/);
    expect(html).not.toMatch(/Unlocked now/);
  });

  it('unknown session id returns 404', async () => {
    const prisma = makePrisma({ purchases: [] });
    const checkout = { listDropsForBuyer: jest.fn() };
    const svc = new ThankYouService(prisma as never, checkout as never);
    await expect(svc.buildViewModel('cs_does_not_exist')).rejects.toThrow(NotFoundException);
  });

  it('not-yet-entitled purchase returns 404', async () => {
    const prisma = makePrisma({
      purchases: [{ ...PURCHASE, entitlement_active: false }],
    });
    const checkout = { listDropsForBuyer: jest.fn() };
    const svc = new ThankYouService(prisma as never, checkout as never);
    await expect(svc.buildViewModel('cs_test_abc')).rejects.toThrow(NotFoundException);
  });

  it('escapes HTML in package + drop strings to prevent XSS', async () => {
    const prisma = makePrisma({
      purchases: [
        {
          ...PURCHASE,
          package: { name: '<script>alert(1)</script>' },
        },
      ],
    });
    const checkout = {
      listDropsForBuyer: jest.fn(async () => ({
        drops: [
          {
            id: 'd1',
            asset_type: 'pdf',
            asset_id: 'a1',
            asset_revision_id: null,
            cadence_kind: 'immediate',
            display_title: '"><img onerror=alert(1)>',
            display_caption: null,
            fire_at: new Date(),
            fired_at: new Date(),
            status: 'fired',
            materialised_ref: null,
          },
        ],
      })),
    };
    const svc = new ThankYouService(prisma as never, checkout as never);
    const vm = await svc.buildViewModel('cs_test_abc');
    const html = renderThankYouPage(vm);
    expect(html).not.toMatch(/<script>alert/);
    expect(html).toMatch(/&lt;script&gt;/);
    expect(html).toMatch(/&quot;&gt;&lt;img/);
  });

  it('empty drop list shows calm "finalising" message', async () => {
    const prisma = makePrisma({ purchases: [PURCHASE] });
    const checkout = {
      listDropsForBuyer: jest.fn(async () => ({ drops: [] })),
    };
    const svc = new ThankYouService(prisma as never, checkout as never);
    const vm = await svc.buildViewModel('cs_test_abc');
    const html = renderThankYouPage(vm);
    expect(html).toMatch(/finalising/);
  });
});
