/**
 * R47 lead-sync processor + CRM service tests.
 *
 * Covers:
 *   - Fan-out: a single pending lead pushes to N enabled integrations in parallel.
 *   - Partial failure: one provider fails, another succeeds → lead stays
 *     pending so the next tick retries only the failed one.
 *   - All-success transition to 'synced' with synced_to + external_ids populated.
 *   - No-integration coach: lead transitions to 'skipped'.
 *   - 429 honored via provider cooldown — no fresh push that tick.
 *   - CoachCrmService.upsert encrypts via KmsService + never returns config bytes.
 *   - testPush surfaces errors as 400 to the coach.
 */

import { LeadSyncProcessor } from '../src/landing-pages/crm/lead-sync.processor';
import { CoachCrmService } from '../src/landing-pages/crm/crm.service';
import { CrmRegistryService } from '../src/landing-pages/crm/crm-registry.service';
import { KmsService } from '../src/common/kms/kms.service';
import {
  CrmRateLimitError,
} from '../src/landing-pages/crm/crm-adapter.interface';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makePrismaStub() {
  const leads: any[] = [];
  const integrations: any[] = [];
  return {
    _leads: leads,
    _integrations: integrations,
    coachLandingLead: {
      findMany: jest.fn(async ({ where, take, orderBy, include }: any) => {
        let out = leads.filter((l) => l.crm_sync_status === where.crm_sync_status);
        if (orderBy?.created_at === 'asc') {
          out = [...out].sort((a, b) => +a.created_at - +b.created_at);
        }
        if (take) out = out.slice(0, take);
        // Eager-load page (the integration test pre-attaches `page` on the lead row).
        return out;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const idx = leads.findIndex((l) => l.id === where.id);
        if (idx === -1) throw new Error('lead not found');
        Object.assign(leads[idx], data);
        return leads[idx];
      }),
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: `lead-${leads.length + 1}`,
          synced_to: [],
          external_ids: {},
          ...data,
          created_at: new Date(),
        };
        leads.push(row);
        return row;
      }),
    },
    coachCrmIntegration: {
      findMany: jest.fn(async ({ where }: any) =>
        integrations.filter(
          (i) =>
            (where.coach_id === undefined || i.coach_id === where.coach_id) &&
            (where.enabled === undefined || i.enabled === where.enabled),
        ),
      ),
      findFirst: jest.fn(async ({ where }: any) =>
        integrations.find((i) =>
          Object.entries(where).every(([k, v]) => i[k] === v),
        ) ?? null,
      ),
      update: jest.fn(async ({ where, data }: any) => {
        const idx = integrations.findIndex((i) => i.id === where.id);
        if (idx === -1) throw new Error('integration not found');
        Object.assign(integrations[idx], data);
        return integrations[idx];
      }),
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: `int-${integrations.length + 1}`,
          enabled: true,
          last_synced_at: null,
          last_error: null,
          created_at: new Date(),
          ...data,
        };
        integrations.push(row);
        return row;
      }),
      delete: jest.fn(async ({ where }: any) => {
        const idx = integrations.findIndex((i) => i.id === where.id);
        if (idx !== -1) integrations.splice(idx, 1);
        return {};
      }),
    },
  };
}

function makeRegistryStub() {
  const adapters = new Map<string, any>();
  return {
    set(name: string, impl: any) {
      adapters.set(name, { name, ...impl });
    },
    getAdapter: jest.fn((name: string) => {
      const a = adapters.get(name);
      if (!a) throw new Error(`adapter '${name}' not registered`);
      return a;
    }),
    _adapters: adapters,
  };
}

// ─── LeadSyncProcessor: fan-out + retries ─────────────────────────────────────

describe('LeadSyncProcessor', () => {
  let prisma: ReturnType<typeof makePrismaStub>;
  let registry: ReturnType<typeof makeRegistryStub>;
  let crmService: CoachCrmService;
  let processor: LeadSyncProcessor;

  beforeEach(() => {
    prisma = makePrismaStub();
    registry = makeRegistryStub();
    const kms = new KmsService();
    crmService = new CoachCrmService(prisma as any, kms, registry as any);
    processor = new LeadSyncProcessor(prisma as any, registry as any, crmService);
  });

  it('marks a lead "skipped" when coach has zero enabled integrations', async () => {
    prisma._leads.push({
      id: 'lead-1',
      page_id: 'p1',
      coach_id: 'coach-1',
      email: 'a@b.com',
      name: null,
      phone: null,
      payload: {},
      crm_sync_status: 'pending',
      synced_to: [],
      external_ids: {},
      created_at: new Date(),
      page: { id: 'p1', slug: 'pg', headline: 'H', coach_id: 'coach-1' },
    });
    await processor.runOnce();
    expect(prisma._leads[0].crm_sync_status).toBe('skipped');
  });

  it('fan-outs to multiple integrations in parallel and marks "synced" on full success', async () => {
    registry.set('hubspot', {
      pushLead: jest.fn().mockResolvedValue({ external_id: 'hs-1' }),
      verifyConfig: jest.fn().mockResolvedValue(undefined),
    });
    registry.set('mailchimp', {
      pushLead: jest.fn().mockResolvedValue({ external_id: 'mc-1' }),
      verifyConfig: jest.fn().mockResolvedValue(undefined),
    });
    prisma._integrations.push(
      {
        id: 'int-hs',
        coach_id: 'coach-1',
        provider: 'hubspot',
        enabled: true,
        credentials_encrypted: 'PLAINTEXT:{"access_token":"t"}',
        field_mapping: {},
        last_synced_at: null,
        last_error: null,
        created_at: new Date(),
      },
      {
        id: 'int-mc',
        coach_id: 'coach-1',
        provider: 'mailchimp',
        enabled: true,
        credentials_encrypted: 'PLAINTEXT:{"api_key":"x-us19","list_id":"L"}',
        field_mapping: {},
        last_synced_at: null,
        last_error: null,
        created_at: new Date(),
      },
    );
    prisma._leads.push({
      id: 'lead-1',
      page_id: 'p1',
      coach_id: 'coach-1',
      email: 'a@b.com',
      name: 'Jane',
      phone: null,
      payload: {},
      crm_sync_status: 'pending',
      synced_to: [],
      external_ids: {},
      created_at: new Date(),
      page: { id: 'p1', slug: 'pg', headline: 'H', coach_id: 'coach-1' },
    });
    const processed = await processor.runOnce();
    expect(processed).toBe(1);
    const lead = prisma._leads[0];
    expect(lead.crm_sync_status).toBe('synced');
    expect(new Set(lead.synced_to)).toEqual(new Set(['hubspot', 'mailchimp']));
    expect(lead.external_ids).toEqual({ hubspot: 'hs-1', mailchimp: 'mc-1' });
  });

  it('keeps lead pending on partial failure and only retries the failed provider', async () => {
    const hsPush = jest.fn().mockResolvedValue({ external_id: 'hs-ok' });
    const mcPush = jest.fn().mockRejectedValue(new Error('mc down'));
    registry.set('hubspot', { pushLead: hsPush, verifyConfig: jest.fn() });
    registry.set('mailchimp', { pushLead: mcPush, verifyConfig: jest.fn() });
    prisma._integrations.push(
      {
        id: 'int-hs',
        coach_id: 'c1',
        provider: 'hubspot',
        enabled: true,
        credentials_encrypted: 'PLAINTEXT:{"access_token":"t"}',
        field_mapping: {},
      },
      {
        id: 'int-mc',
        coach_id: 'c1',
        provider: 'mailchimp',
        enabled: true,
        credentials_encrypted: 'PLAINTEXT:{"api_key":"x-us19","list_id":"L"}',
        field_mapping: {},
      },
    );
    prisma._leads.push({
      id: 'lead-1',
      page_id: 'p1',
      coach_id: 'c1',
      email: 'a@b.com',
      name: null,
      phone: null,
      payload: {},
      crm_sync_status: 'pending',
      synced_to: [],
      external_ids: {},
      created_at: new Date(Date.now() - 60_000),
      page: { id: 'p1', slug: 'pg', headline: 'H', coach_id: 'c1' },
    });

    // First tick: HS succeeds, MC fails — stays pending.
    await processor.runOnce();
    let lead = prisma._leads[0];
    expect(lead.crm_sync_status).toBe('pending');
    expect(lead.synced_to).toEqual(['hubspot']);
    expect(lead.external_ids.hubspot).toBe('hs-ok');
    expect(hsPush).toHaveBeenCalledTimes(1);
    expect(mcPush).toHaveBeenCalledTimes(1);
    // The integration row should record the error.
    const intMc = prisma._integrations.find((i) => i.provider === 'mailchimp');
    expect(intMc.last_error).toContain('mc down');

    // Move past the backoff and let MC succeed on retry. The backoff for
    // the second attempt is 5 min; the processor uses the in-memory map
    // which we override by clearing it via the constructor's seam (the
    // map is private). Cheat: directly invoke runOnce() bypassing the
    // backoff guard by manually clearing the nextEligibleAt entry.
    (processor as any).nextEligibleAt.clear();
    mcPush.mockResolvedValueOnce({ external_id: 'mc-ok' });
    await processor.runOnce();
    lead = prisma._leads[0];
    expect(lead.crm_sync_status).toBe('synced');
    expect(new Set(lead.synced_to)).toEqual(new Set(['hubspot', 'mailchimp']));
    // HubSpot must NOT have been called again — already in synced_to.
    expect(hsPush).toHaveBeenCalledTimes(1);
    expect(mcPush).toHaveBeenCalledTimes(2);
  });

  it('respects provider cooldown after CrmRateLimitError', async () => {
    const push = jest.fn().mockRejectedValueOnce(new CrmRateLimitError(30_000, 'hubspot'));
    registry.set('hubspot', { pushLead: push, verifyConfig: jest.fn() });
    prisma._integrations.push({
      id: 'int-hs',
      coach_id: 'c1',
      provider: 'hubspot',
      enabled: true,
      credentials_encrypted: 'PLAINTEXT:{"access_token":"t"}',
      field_mapping: {},
    });
    prisma._leads.push({
      id: 'lead-1',
      page_id: 'p1',
      coach_id: 'c1',
      email: 'a@b.com',
      name: null,
      phone: null,
      payload: {},
      crm_sync_status: 'pending',
      synced_to: [],
      external_ids: {},
      created_at: new Date(),
      page: { id: 'p1', slug: 'pg', headline: 'H', coach_id: 'c1' },
    });

    await processor.runOnce();
    expect(push).toHaveBeenCalledTimes(1);
    // The processor stores a cooldown until ~now + 30s.
    const cooldown = (processor as any).providerCooldownUntil.get('hubspot');
    expect(cooldown).toBeGreaterThan(Date.now() + 25_000);

    // Force the lead back to eligibility — push should NOT be called again
    // because the provider is still cooling down.
    (processor as any).nextEligibleAt.clear();
    await processor.runOnce();
    expect(push).toHaveBeenCalledTimes(1);
  });
});

// ─── CoachCrmService: upsert / list / remove / test ──────────────────────────

describe('CoachCrmService', () => {
  let prisma: ReturnType<typeof makePrismaStub>;
  let registry: ReturnType<typeof makeRegistryStub>;
  let svc: CoachCrmService;
  let kms: KmsService;

  beforeEach(() => {
    prisma = makePrismaStub();
    registry = makeRegistryStub();
    kms = new KmsService();
    svc = new CoachCrmService(prisma as any, kms, registry as any);
  });

  it('upsert encrypts config via KmsService and never returns it', async () => {
    registry.set('hubspot', {
      verifyConfig: jest.fn().mockResolvedValue(undefined),
      pushLead: jest.fn(),
    });
    const summary = await svc.upsert('coach-1', 'hubspot', { access_token: 'tok' });
    expect(summary).not.toHaveProperty('credentials_encrypted');
    expect(summary).not.toHaveProperty('config');
    expect(summary.provider).toBe('hubspot');
    expect(prisma._integrations).toHaveLength(1);
    const row = prisma._integrations[0];
    // KMS without a key produces PLAINTEXT: prefix — verify the access
    // token is wrapped in the envelope rather than stored bare.
    expect(row.credentials_encrypted).toContain('PLAINTEXT:');
    expect(row.credentials_encrypted).toContain('access_token');
  });

  it('upsert rejects bad credentials with BadRequestException', async () => {
    registry.set('hubspot', {
      verifyConfig: jest.fn().mockRejectedValue(new Error('401')),
      pushLead: jest.fn(),
    });
    await expect(svc.upsert('coach-1', 'hubspot', { access_token: 'bad' })).rejects.toThrow();
  });

  it('list never returns credentials_encrypted', async () => {
    prisma._integrations.push({
      id: 'i1',
      coach_id: 'coach-1',
      provider: 'hubspot',
      enabled: true,
      credentials_encrypted: 'PLAINTEXT:{"access_token":"super-secret"}',
      field_mapping: {},
      last_synced_at: null,
      last_error: null,
      created_at: new Date(),
    });
    const out = await svc.list('coach-1');
    expect(out).toHaveLength(1);
    expect(JSON.stringify(out)).not.toContain('super-secret');
    expect(JSON.stringify(out)).not.toContain('credentials_encrypted');
  });

  it('remove deletes the row and 404s when not found', async () => {
    await expect(svc.remove('coach-1', 'hubspot')).rejects.toThrow();
    prisma._integrations.push({
      id: 'i1',
      coach_id: 'coach-1',
      provider: 'hubspot',
      enabled: true,
      credentials_encrypted: 'PLAINTEXT:{}',
      field_mapping: {},
    });
    await svc.remove('coach-1', 'hubspot');
    expect(prisma._integrations).toHaveLength(0);
  });

  it('testPush surfaces provider errors as BadRequest with redacted message', async () => {
    registry.set('hubspot', {
      pushLead: jest.fn().mockRejectedValue(new Error('hubspot rejected; access_token=leaked-token')),
      verifyConfig: jest.fn(),
    });
    prisma._integrations.push({
      id: 'i1',
      coach_id: 'c1',
      provider: 'hubspot',
      enabled: true,
      credentials_encrypted: 'PLAINTEXT:{"access_token":"x"}',
      field_mapping: {},
    });
    await expect(svc.testPush('c1', 'hubspot')).rejects.toMatchObject({
      response: { error: 'CRM_TEST_FAILED' },
    });
    // The row's last_error should be the redacted version — not the raw token.
    expect(prisma._integrations[0].last_error).not.toContain('leaked-token');
  });
});
