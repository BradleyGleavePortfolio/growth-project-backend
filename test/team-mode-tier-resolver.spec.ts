// test/team-mode-tier-resolver.spec.ts
//
// ADR-0001 §10 Q1+Q6: tier resolver covers price-id -> tier label
// mapping plus the "unknown" deny-by-default branch.

import 'reflect-metadata';
import { TeamModeTierResolverService } from '../src/team-mode/tier-resolver.service';

const ORIGINAL_ENV = { ...process.env };

function makePrisma(stripe_price_id: string | null, stripe_subscription_id: string | null = 'sub_X') {
  return {
    coachSubscription: {
      findUnique: jest.fn(async () =>
        stripe_price_id === null && stripe_subscription_id === null
          ? null
          : { stripe_price_id, stripe_subscription_id },
      ),
    },
  } as unknown as ConstructorParameters<typeof TeamModeTierResolverService>[0];
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('TeamModeTierResolverService.priceIdToTier', () => {
  beforeEach(() => {
    process.env.STRIPE_PRICE_GROWTH = 'price_growth_1';
    process.env.STRIPE_PRICE_PRO = 'price_pro_1';
    process.env.STRIPE_PRICE_ENTERPRISE = 'price_ent_1';
  });

  it('maps the configured Growth price id to "growth"', () => {
    const svc = new TeamModeTierResolverService(makePrisma(null));
    expect(svc.priceIdToTier('price_growth_1')).toBe('growth');
  });

  it('maps the configured Pro price id to "pro"', () => {
    const svc = new TeamModeTierResolverService(makePrisma(null));
    expect(svc.priceIdToTier('price_pro_1')).toBe('pro');
  });

  it('maps the configured Enterprise price id to "enterprise"', () => {
    const svc = new TeamModeTierResolverService(makePrisma(null));
    expect(svc.priceIdToTier('price_ent_1')).toBe('enterprise');
  });

  it('returns "unknown" for an unrecognised price id', () => {
    const svc = new TeamModeTierResolverService(makePrisma(null));
    expect(svc.priceIdToTier('price_legacy_flat_300')).toBe('unknown');
  });
});

describe('TeamModeTierResolverService.resolveTier', () => {
  beforeEach(() => {
    process.env.STRIPE_PRICE_GROWTH = 'price_growth_1';
    process.env.STRIPE_PRICE_PRO = 'price_pro_1';
    process.env.STRIPE_PRICE_ENTERPRISE = 'price_ent_1';
  });

  it('returns "unknown" when there is no CoachSubscription row', async () => {
    const svc = new TeamModeTierResolverService(makePrisma(null, null));
    const r = await svc.resolveTier('coach-1');
    expect(r.tier).toBe('unknown');
    expect(r.stripe_subscription_id).toBeNull();
    expect(r.stripe_price_id).toBeNull();
  });

  it('returns "pro" when the row carries the Pro price id', async () => {
    const svc = new TeamModeTierResolverService(makePrisma('price_pro_1'));
    const r = await svc.resolveTier('coach-1');
    expect(r.tier).toBe('pro');
    expect(r.stripe_price_id).toBe('price_pro_1');
  });

  it('returns "enterprise" when the row carries the Enterprise price id', async () => {
    const svc = new TeamModeTierResolverService(makePrisma('price_ent_1'));
    const r = await svc.resolveTier('coach-1');
    expect(r.tier).toBe('enterprise');
  });

  it('returns "growth" when the row carries the Growth price id', async () => {
    const svc = new TeamModeTierResolverService(makePrisma('price_growth_1'));
    const r = await svc.resolveTier('coach-1');
    expect(r.tier).toBe('growth');
  });
});

// Pre-TestFlight smoke: catches operator misconfiguration of the tier
// price env vars (typo, blank value, same id pasted into two tiers).
// Audit ref: /audits/00_MASTER_REPORT.md line 194 (Payment P0).
describe('TeamModeTierResolverService.configuredTiers', () => {
  it('reports every tier as missing when env is empty', () => {
    delete process.env.STRIPE_PRICE_GROWTH;
    delete process.env.STRIPE_PRICE_PRO;
    delete process.env.STRIPE_PRICE_ENTERPRISE;
    const svc = new TeamModeTierResolverService(makePrisma(null));
    const c = svc.configuredTiers();
    expect(c.missing.sort()).toEqual(['enterprise', 'growth', 'pro']);
    expect(c.growth).toBeNull();
    expect(c.pro).toBeNull();
    expect(c.enterprise).toBeNull();
    expect(c.duplicates).toEqual([]);
  });

  it('returns the configured price ids and zero duplicates when all three tiers are wired', () => {
    process.env.STRIPE_PRICE_GROWTH = 'price_growth_1';
    process.env.STRIPE_PRICE_PRO = 'price_pro_1';
    process.env.STRIPE_PRICE_ENTERPRISE = 'price_ent_1';
    const svc = new TeamModeTierResolverService(makePrisma(null));
    const c = svc.configuredTiers();
    expect(c).toMatchObject({
      growth: 'price_growth_1',
      pro: 'price_pro_1',
      enterprise: 'price_ent_1',
      missing: [],
      duplicates: [],
    });
  });

  it('flags duplicates when an operator pastes the same price into two tiers', () => {
    process.env.STRIPE_PRICE_GROWTH = 'price_same';
    process.env.STRIPE_PRICE_PRO = 'price_same';
    process.env.STRIPE_PRICE_ENTERPRISE = 'price_ent_1';
    const svc = new TeamModeTierResolverService(makePrisma(null));
    const c = svc.configuredTiers();
    expect(c.duplicates).toEqual([['growth', 'pro']]);
    expect(c.missing).toEqual([]);
  });

  it('round-trips: every configured price id resolves to the right tier label', () => {
    process.env.STRIPE_PRICE_GROWTH = 'price_growth_1';
    process.env.STRIPE_PRICE_PRO = 'price_pro_1';
    process.env.STRIPE_PRICE_ENTERPRISE = 'price_ent_1';
    const svc = new TeamModeTierResolverService(makePrisma(null));
    const c = svc.configuredTiers();
    expect(svc.priceIdToTier(c.growth!)).toBe('growth');
    expect(svc.priceIdToTier(c.pro!)).toBe('pro');
    expect(svc.priceIdToTier(c.enterprise!)).toBe('enterprise');
  });
});
