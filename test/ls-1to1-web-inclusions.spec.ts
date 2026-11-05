import { renderPayPage } from '../src/storefront/pay-page.html';
import type { PublicPackageData } from '../src/storefront/storefront.types';

describe('LS-1TO1: every web package includes its named coach', () => {
  it.each([null, 'Weekly call\nTraining plan'])(
    'puts named coaching first under included even with description %s',
    (description) => {
      const pkg: PublicPackageData = {
        package_id: 'package',
        package_name: 'Coaching',
        description,
        price_cents: 4900,
        currency: 'usd',
        billing_cycle: 'one_time',
        trial_days: null,
        features: [],
        coach: { display_name: 'Coach Lee', bio: null, avatar_url: null, verified: true },
        stripe_publishable_key: 'test-public-value',
        share_link_enabled: true,
        due_today_cents: 4900,
        recurring: null,
      };
      const html = renderPayPage(pkg, {
        token: 'A'.repeat(21),
        lp: null,
        onBehalfOf: 'test-account',
        nonce: 'test-nonce',
        returnUrl: 'https://example.test/done',
      });
      expect(html).toContain(
        '<h2>What\'s included</h2><ul class="inc"><li>1:1 coaching with Coach Lee</li>',
      );
    },
  );
});
