import { CheckoutContractGate } from '../../src/contracts/checkout-contract-gate.service';

/**
 * B5 hard gate #4 — two-layer checkout gate.
 *
 * Proves the ordering invariant: Layer 1 (Platform Waiver) is enforced BEFORE
 * Layer 2 (Coach Service Agreement), and BOTH must be SIGNED before the gate
 * returns ok:true (the seam the checkout service consults before any Stripe
 * call). Also proves the OFF no-op and the re-signed-waiver idempotency path.
 */

const PLATFORM_WAIVER = { id: 'tpl_platform', version: 1, name: 'Platform Liability Waiver', coach_id: 'sys_coach' };

function pkg(over: Partial<any> = {}): any {
  return {
    id: 'pkg_1',
    name: 'Coaching',
    amount_cents: 50000,
    currency: 'usd',
    interval: null,
    requires_contract: false,
    contract_template_id: null,
    ...over,
  };
}

const args = (over: Partial<any> = {}) => ({
  clientId: 'cli_1',
  client: { email: 'ada@x.com', name: 'Ada Lovelace' },
  pkg: pkg(),
  coach: { id: 'coach_1', email: 'k@x.com', name: 'Coach K' },
  ...over,
});

function build(overrides: { templates?: any; envelopes?: any } = {}) {
  const prisma: any = {
    user: { findUnique: jest.fn(async () => ({ email: 'sys@tgp.com', name: 'Growth Project' })) },
  };
  const telemetry: any = { checkoutBlocked: jest.fn(), checkoutGateCleared: jest.fn() };
  const templates: any = {
    getActivePlatformWaiver: jest.fn(async () => ({ ...PLATFORM_WAIVER })),
    getByIdUnscoped: jest.fn(async (id: string) => ({ id, version: 1, name: 'Standard Coaching' })),
    ...overrides.templates,
  };
  const envelopes: any = {
    hasSignedAnyPlatformWaiver: jest.fn(async () => false),
    findOpenPlatformWaiver: jest.fn(async () => null),
    findOpenCoachEnvelope: jest.fn(async () => null),
    hasSignedCoachEnvelope: jest.fn(async () => null),
    getEnvelopeViewForClient: jest.fn(async (id: string) => ({ envelope: { id }, embedUrl: 'https://embed' })),
    createEnvelope: jest.fn(async ({ layer }: any) => ({
      envelope: { id: `env_${layer}`, status: 'SENT' },
      embedUrl: 'https://embed/new',
    })),
    ...overrides.envelopes,
  };
  const gate = new CheckoutContractGate(prisma, envelopes, templates, telemetry);
  return { gate, templates, envelopes, telemetry };
}

describe('CheckoutContractGate — flag posture', () => {
  const prev = process.env.FEATURE_CONTRACTS_ENABLED;
  afterAll(() => {
    if (prev === undefined) delete process.env.FEATURE_CONTRACTS_ENABLED;
    else process.env.FEATURE_CONTRACTS_ENABLED = prev;
  });

  it('is a pure no-op when FEATURE_CONTRACTS_ENABLED is OFF', async () => {
    process.env.FEATURE_CONTRACTS_ENABLED = 'false';
    const { gate, envelopes } = build();
    const res = await gate.evaluate(args({ pkg: pkg({ requires_contract: true, contract_template_id: 'tpl_x' }) }));
    expect(res).toEqual({ ok: true, reason: 'contracts_disabled' });
    expect(envelopes.createEnvelope).not.toHaveBeenCalled();
  });
});

describe('CheckoutContractGate — two-layer ordering (flag ON)', () => {
  const prev = process.env.FEATURE_CONTRACTS_ENABLED;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.FEATURE_CONTRACTS_ENABLED = 'true';
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.FEATURE_CONTRACTS_ENABLED;
    else process.env.FEATURE_CONTRACTS_ENABLED = prev;
  });

  it('Layer 1 first: blocks on the platform waiver before ever looking at the coach contract', async () => {
    const { gate, envelopes } = build();
    const res = await gate.evaluate(
      args({ pkg: pkg({ requires_contract: true, contract_template_id: 'tpl_coach' }) }),
    );
    expect(res).toMatchObject({ ok: false, layer: 'platform_waiver' });
    // Coach contract must NOT have been evaluated yet.
    expect(envelopes.hasSignedCoachEnvelope).not.toHaveBeenCalled();
    expect(envelopes.createEnvelope).toHaveBeenCalledTimes(1);
    expect(envelopes.createEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({ layer: 'platform_waiver' }),
    );
  });

  it('platform signed + no coach contract required → ok (no_contract_required)', async () => {
    const { gate, envelopes } = build({
      envelopes: { hasSignedAnyPlatformWaiver: jest.fn(async () => true) },
    });
    const res = await gate.evaluate(args());
    expect(res).toEqual({ ok: true, reason: 'no_contract_required' });
    expect(envelopes.createEnvelope).not.toHaveBeenCalled();
  });

  it('platform signed but coach contract required + unsigned → blocks on coach layer', async () => {
    const { gate } = build({
      envelopes: { hasSignedAnyPlatformWaiver: jest.fn(async () => true) },
    });
    const res = await gate.evaluate(
      args({ pkg: pkg({ requires_contract: true, contract_template_id: 'tpl_coach' }) }),
    );
    expect(res).toMatchObject({ ok: false, layer: 'coach_service', envelopeId: 'env_coach_service' });
  });

  it('both layers signed → ok (all_signed) carrying the coach envelope id for purchase linkage', async () => {
    const { gate } = build({
      envelopes: {
        hasSignedAnyPlatformWaiver: jest.fn(async () => true),
        hasSignedCoachEnvelope: jest.fn(async () => ({ id: 'env_signed_coach' })),
      },
    });
    const res = await gate.evaluate(
      args({ pkg: pkg({ requires_contract: true, contract_template_id: 'tpl_coach' }) }),
    );
    expect(res).toEqual({ ok: true, reason: 'all_signed', coachEnvelopeId: 'env_signed_coach' });
  });

  it('idempotency: an already-SIGNED platform waiver is never re-sent on a later purchase', async () => {
    const { gate, envelopes } = build({
      envelopes: { hasSignedAnyPlatformWaiver: jest.fn(async () => true) },
    });
    await gate.evaluate(args());
    expect(envelopes.findOpenPlatformWaiver).not.toHaveBeenCalled();
    expect(envelopes.createEnvelope).not.toHaveBeenCalled();
  });

  it('reuses an in-flight platform waiver rather than spawning a duplicate', async () => {
    const { gate, envelopes } = build({
      envelopes: {
        hasSignedAnyPlatformWaiver: jest.fn(async () => false),
        findOpenPlatformWaiver: jest.fn(async () => ({ id: 'env_open', status: 'SENT' })),
      },
    });
    const res = await gate.evaluate(args());
    expect(res).toMatchObject({ ok: false, layer: 'platform_waiver', envelopeId: 'env_open' });
    expect(envelopes.createEnvelope).not.toHaveBeenCalled();
  });
});
