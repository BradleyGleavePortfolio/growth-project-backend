import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../src/prisma.service';
import { GRANT_SOURCE, InviteGrantService } from '../src/invite-grant/invite-grant.service';
import { COACHING_COACH, coachingCoachFor } from '../src/packages/coach-selling';
import { renderPayPage } from '../src/storefront/pay-page.html';
import type { PublicPackageData } from '../src/storefront/storefront.types';

// R75: the repo's typed test double (as in test/gc2-pay-done.spec.ts), in place of inline casts.
function stub<T>(value: unknown): T {
  return value as T;
}

// FR-1TO1 (agent 185) class-first tests: one table per class, over its whole path list.
const src = (file: string) => readFileSync(join(__dirname, '..', 'src', file), 'utf8');

describe('FR-1TO1 class A: every package read that sells or grants uses the one coaching rule', () => {
  it.each([
    ['web pay page display', 'storefront/storefront.service.ts', 'where: { share_token: token, coach: COACHING_COACH }'],
    ['web guest intent', 'storefront/guest-checkout.service.ts', 'where: { share_token: token, coach: COACHING_COACH }'],
    ['web checkout recovery', 'storefront/checkout-recovery.service.ts', 'where: { share_token: shareToken, coach: COACHING_COACH }'],
    ['in-app list', 'packages/packages.service.ts', 'coach: coachingCoachFor(buyerId),'],
    ['in-app detail, card and subscription checkout', 'packages/packages.service.ts', 'where: { id: packageId, coach: coachingCoachFor(buyerId) }'],
    ['in-app free claim', 'invite-grant/invite-grant.service.ts', 'where: { id: packageId, coach: coachingCoachFor(client.id) }'],
    ['every grant write (invite, free, prepaid, consent)', 'invite-grant/invite-grant.service.ts', 'where: { id: input.packageId, coach: coachingCoachFor(input.clientUserId) }'],
  ])('%s', (_path, file, read) => {
    expect(src(file)).toContain(read);
  });

  it('leaves no buy-side read on the older, wider SELLING_COACH rule', () => {
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts') && !p.endsWith('.spec.ts') && /\bSELLING_COACH\b/.test(readFileSync(p, 'utf8'))) hits.push(name);
      }
    };
    walk(join(__dirname, '..', 'src'));
    expect(hits).toEqual(['coach-selling.ts']);
    expect(COACHING_COACH).toMatchObject({ deletion_scheduled_at: null, role: { in: ['coach', 'owner'] } });
  });
});

describe('FR-1TO1 class B: the one entitlement writer refuses a coach who cannot coach the buyer', () => {
  it('is the only place this service writes an entitlement row', () => {
    expect(src('invite-grant/invite-grant.service.ts').match(/clientPurchase\.upsert\(/g)).toHaveLength(1);
  });

  const pkg = {
    id: 'package', coach_id: 'coach', currency: 'usd', billing_type: 'one_time',
    duration_periods: null, is_active: true, archived_at: null,
  };
  function fixture(blocked: boolean) {
    const upsert = jest.fn(async ({ create }: { create: Record<string, unknown> }) => ({
      id: 'purchase', status: create.status, entitlement_active: create.entitlement_active,
      stripe_checkout_session_id: create.stripe_checkout_session_id, grant_metadata: {},
    }));
    const findUnique = jest.fn(async ({ where }: { where: { coach?: unknown } }) => (
      blocked && where.coach ? null : pkg
    ));
    const db = { coachPackage: { findUnique }, clientPurchase: { upsert } };
    const grants = new InviteGrantService(
      stub<PrismaService>(db), stub<never>({ write: jest.fn(async () => undefined) }),
      undefined, undefined, stub<never>({ isGranted: jest.fn(async () => true) }),
    );
    return { grants, upsert, findUnique };
  }
  const rows = [
    ['invite free', GRANT_SOURCE.INVITE_FREE, true],
    ['invite prepaid', GRANT_SOURCE.INVITE_PREPAID, true],
    ['free package claim', GRANT_SOURCE.FREE_PACKAGE_CLAIM, true],
    ['pending consent row', GRANT_SOURCE.INVITE_FREE, false],
  ] as const;

  it.each(rows)('%s: reads the package through coachingCoachFor(buyer)', async (_l, source, active) => {
    const f = fixture(false);
    await f.grants.grant({ clientUserId: 'buyer', coachUserId: 'coach', packageId: pkg.id, source, metadata: {}, active });
    expect(f.findUnique).toHaveBeenCalledWith({ where: { id: pkg.id, coach: coachingCoachFor('buyer') } });
    expect(f.upsert).toHaveBeenCalledTimes(1);
  });

  it.each(rows)('%s: refused (404 PACKAGE_NOT_FOUND, no row) for a blocked or non-coaching seller', async (_l, source, active) => {
    const f = fixture(true);
    const out = f.grants.grant({ clientUserId: 'buyer', coachUserId: 'coach', packageId: pkg.id, source, metadata: {}, active });
    await expect(out).rejects.toBeInstanceOf(NotFoundException);
    await expect(out).rejects.toMatchObject({ response: { error: 'PACKAGE_NOT_FOUND' } });
    expect(f.upsert).not.toHaveBeenCalled();
  });
});

describe('FR-1TO1 class C: the web pay page names the coaching first on every package', () => {
  const base: PublicPackageData = {
    package_id: 'package', package_name: 'Coaching', description: null, price_cents: 4900,
    currency: 'usd', billing_cycle: 'one_time', trial_days: null, features: [],
    coach: { display_name: 'Coach Lee', bio: null, avatar_url: null, verified: true },
    stripe_publishable_key: 'test-public-value', share_link_enabled: true,
    due_today_cents: 4900, recurring: null,
  };
  const ctx = { token: 'A'.repeat(21), lp: null, onBehalfOf: 'test-account', nonce: 'n', returnUrl: 'https://example.test/done' };
  it.each([
    ['no description', null, 'Coach Lee', ['1:1 coaching with Coach Lee']],
    ['empty description', '', 'Coach Lee', ['1:1 coaching with Coach Lee']],
    ['blank lines only', ' \n  \n', 'Coach Lee', ['1:1 coaching with Coach Lee']],
    ['described package', 'Weekly call\n Training plan ', 'Coach Lee', ['1:1 coaching with Coach Lee', 'Weekly call', 'Training plan']],
    ['name needing escape', null, 'Lee & <Co>', ['1:1 coaching with Lee &amp; &lt;Co&gt;']],
  ])('%s', (_l, description, name, items) => {
    const html = renderPayPage({ ...base, description, coach: { ...base.coach, display_name: name } }, ctx);
    const list = `<h2>What's included</h2><ul class="inc">${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;
    expect(html).toContain(`<section id="inc0">${list}</section>`);
  });
});
