/**
 * R47 lead-sync processor + CRM service tests.
 *
 * Covers:
 *   - Multi-replica SKIP LOCKED claim primitive (Audit #6 P0-6).
 *   - Persistent attempts / next_eligible_at retry state (P0-6, P1-8).
 *   - Per-coach token bucket rate limit (P1-7).
 *   - Fan-out: a single pending lead pushes to N enabled integrations in parallel.
 *   - Partial failure: one provider fails, another succeeds → lead returns
 *     to 'pending' with backoff persisted on the row.
 *   - All-success transition to 'synced' with synced_to + external_ids populated.
 *   - No-integration coach: lead transitions to 'skipped' WITHOUT writing
 *     crm_synced_at (Audit #6 P1-9 numbering).
 *   - 429 honored via provider cooldown — no fresh push that tick.
 *   - CoachCrmService.upsert encrypts via KmsService + never returns config bytes.
 *   - testPush surfaces errors as 400 to the coach.
 */

import { LeadSyncProcessor } from '../src/landing-pages/crm/lead-sync.processor';
import { CoachCrmService } from '../src/landing-pages/crm/crm.service';
import { KmsService } from '../src/common/kms/kms.service';
import {
  CrmRateLimitError,
} from '../src/landing-pages/crm/crm-adapter.interface';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makePrismaStub() {
  const leads: any[] = [];
  const integrations: any[] = [];
  const pages: any[] = [];

  // Track $queryRawUnsafe SQL fragments so tests can assert FOR UPDATE / SKIP LOCKED.
  const rawSqls: string[] = [];

  return {
    _leads: leads,
    _integrations: integrations,
    _pages: pages,
    _rawSqls: rawSqls,
    /**
     * Stub Prisma's `$queryRawUnsafe`. The processor issues a single
     * UPDATE ... RETURNING * for the claim — we model that by filtering
     * `leads` on (status='pending' AND eligible), flipping each matched
     * row to 'syncing' in place, then returning shallow copies that
     * mimic Postgres's RETURNING.
     */
    $queryRawUnsafe: jest.fn(async (sql: string, batchSize: number) => {
      rawSqls.push(sql);
      const now = Date.now();
      const candidates = leads
        .filter((l) => l.crm_sync_status === 'pending')
        .filter(
          (l) =>
            l.next_eligible_at == null || +new Date(l.next_eligible_at) <= now,
        )
        .sort((a, b) => +a.created_at - +b.created_at)
        .slice(0, batchSize);
      const out: any[] = [];
      for (const lead of candidates) {
        lead.crm_sync_status = 'syncing';
        out.push({ ...lead });
      }
      return out;
    }),
    coachLandingLead: {
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
          attempts: 0,
          next_eligible_at: null,
          ...data,
          created_at: new Date(),
        };
        leads.push(row);
        return row;
      }),
    },
    coachLandingPage: {
      findMany: jest.fn(async ({ where }: any) => {
        const ids: string[] = where?.id?.in ?? [];
        return pages.filter((p) => ids.includes(p.id));
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
      upsert: jest.fn(async ({ where, update, create }: any) => {
        // where: { coach_id_provider: { coach_id, provider } }
        const k = where.coach_id_provider;
        const idx = integrations.findIndex(
          (i) => i.coach_id === k.coach_id && i.provider === k.provider,
        );
        if (idx >= 0) {
          Object.assign(integrations[idx], update);
          return integrations[idx];
        }
        const row = {
          id: `int-${integrations.length + 1}`,
          enabled: true,
          last_synced_at: null,
          last_error: null,
          created_at: new Date(),
          ...create,
        };
        integrations.push(row);
        return row;
      }),
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

function seedPage(prisma: ReturnType<typeof makePrismaStub>, page: any) {
  prisma._pages.push(page);
}

// ─── LeadSyncProcessor: claim + fan-out + retries ─────────────────────────────

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

  it('uses FOR UPDATE SKIP LOCKED in its claim SQL (multi-replica safety)', async () => {
    await processor.runOnce();
    const all = prisma._rawSqls.join('\n');
    expect(all).toMatch(/FOR\s+UPDATE\s+SKIP\s+LOCKED/i);
    expect(all).toMatch(/SET\s+crm_sync_status\s*=\s*'syncing'/i);
  });

  it('marks a lead "skipped" without writing crm_synced_at when coach has zero integrations (P1-9)', async () => {
    seedPage(prisma, { id: 'p1', slug: 'pg', headline: 'H', coach_id: 'coach-1' });
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
      attempts: 0,
      next_eligible_at: null,
      created_at: new Date(),
    });
    await processor.runOnce();
    const lead = prisma._leads[0];
    expect(lead.crm_sync_status).toBe('skipped');
    expect(lead.crm_synced_at ?? null).toBeNull();
  });

  it('fan-outs to multiple integrations and marks "synced" on full success', async () => {
    seedPage(prisma, { id: 'p1', slug: 'pg', headline: 'H', coach_id: 'coach-1' });
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
      },
      {
        id: 'int-mc',
        coach_id: 'coach-1',
        provider: 'mailchimp',
        enabled: true,
        credentials_encrypted: 'PLAINTEXT:{"api_key":"x-us19","list_id":"L"}',
        field_mapping: {},
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
      attempts: 0,
      next_eligible_at: null,
      created_at: new Date(),
    });
    const processed = await processor.runOnce();
    expect(processed).toBe(1);
    const lead = prisma._leads[0];
    expect(lead.crm_sync_status).toBe('synced');
    expect(new Set(lead.synced_to)).toEqual(new Set(['hubspot', 'mailchimp']));
    expect(lead.external_ids).toEqual({ hubspot: 'hs-1', mailchimp: 'mc-1' });
  });

  it('persists attempts++ and next_eligible_at on partial failure (P0-6)', async () => {
    seedPage(prisma, { id: 'p1', slug: 'pg', headline: 'H', coach_id: 'c1' });
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
      attempts: 0,
      next_eligible_at: null,
      created_at: new Date(Date.now() - 60_000),
    });

    // Tick 1: HS succeeds, MC fails — row returns to pending with
    // attempts=1 and next_eligible_at set ~60s in the future.
    await processor.runOnce();
    let lead = prisma._leads[0];
    expect(lead.crm_sync_status).toBe('pending');
    expect(lead.attempts).toBe(1);
    expect(lead.next_eligible_at).toBeInstanceOf(Date);
    expect(+lead.next_eligible_at).toBeGreaterThan(Date.now());
    expect(lead.synced_to).toEqual(['hubspot']);
    expect(lead.external_ids.hubspot).toBe('hs-ok');
    expect(hsPush).toHaveBeenCalledTimes(1);
    expect(mcPush).toHaveBeenCalledTimes(1);

    // Tick 2 immediately: row is still in cooldown, claim returns nothing.
    await processor.runOnce();
    expect(mcPush).toHaveBeenCalledTimes(1);

    // Force the row past its backoff and let MC succeed on retry.
    prisma._leads[0].next_eligible_at = new Date(Date.now() - 1_000);
    mcPush.mockResolvedValueOnce({ external_id: 'mc-ok' });
    await processor.runOnce();
    lead = prisma._leads[0];
    expect(lead.crm_sync_status).toBe('synced');
    expect(new Set(lead.synced_to)).toEqual(new Set(['hubspot', 'mailchimp']));
    expect(hsPush).toHaveBeenCalledTimes(1);
    expect(mcPush).toHaveBeenCalledTimes(2);
  });

  it('respects provider cooldown after CrmRateLimitError', async () => {
    seedPage(prisma, { id: 'p1', slug: 'pg', headline: 'H', coach_id: 'c1' });
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
      attempts: 0,
      next_eligible_at: null,
      created_at: new Date(),
    });

    await processor.runOnce();
    expect(push).toHaveBeenCalledTimes(1);
    const cooldown = (processor as any).providerCooldownUntil.get('hubspot');
    expect(cooldown).toBeGreaterThan(Date.now() + 25_000);

    // Force eligibility forward; the provider is still cooling down.
    prisma._leads[0].next_eligible_at = new Date(Date.now() - 1_000);
    await processor.runOnce();
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('two replicas claiming concurrently see disjoint leads (SKIP LOCKED contract)', async () => {
    // We simulate the database-level guarantee: when both workers race,
    // only one of them gets each row because the claim is an UPDATE
    // that atomically flips status away from 'pending'. The other
    // worker's filter sees zero pending rows the moment the first
    // worker's UPDATE returns.
    seedPage(prisma, { id: 'p1', slug: 'pg', headline: 'H', coach_id: 'c1' });
    seedPage(prisma, { id: 'p2', slug: 'pg2', headline: 'H', coach_id: 'c2' });
    registry.set('hubspot', {
      pushLead: jest.fn().mockResolvedValue({ external_id: 'x' }),
      verifyConfig: jest.fn(),
    });
    prisma._integrations.push({
      id: 'int-1',
      coach_id: 'c1',
      provider: 'hubspot',
      enabled: true,
      credentials_encrypted: 'PLAINTEXT:{"access_token":"t"}',
      field_mapping: {},
    });
    prisma._integrations.push({
      id: 'int-2',
      coach_id: 'c2',
      provider: 'hubspot',
      enabled: true,
      credentials_encrypted: 'PLAINTEXT:{"access_token":"t"}',
      field_mapping: {},
    });
    for (const [i, coach] of [
      [1, 'c1'],
      [2, 'c2'],
    ] as const) {
      prisma._leads.push({
        id: `lead-${i}`,
        page_id: coach === 'c1' ? 'p1' : 'p2',
        coach_id: coach,
        email: `${coach}@x.com`,
        name: null,
        phone: null,
        payload: {},
        crm_sync_status: 'pending',
        synced_to: [],
        external_ids: {},
        attempts: 0,
        next_eligible_at: null,
        created_at: new Date(),
      });
    }
    const a = new LeadSyncProcessor(prisma as any, registry as any, crmService);
    const b = new LeadSyncProcessor(prisma as any, registry as any, crmService);
    await Promise.all([a.runOnce(), b.runOnce()]);
    // Both leads should be 'synced'; no double-processing because the
    // first worker's UPDATE flipped them out of 'pending' before the
    // second worker's claim could see them.
    expect(prisma._leads.every((l) => l.crm_sync_status === 'synced')).toBe(true);
  });

  it('per-coach token bucket defers when bucket is empty (P1-7)', async () => {
    seedPage(prisma, { id: 'p1', slug: 'pg', headline: 'H', coach_id: 'c1' });
    registry.set('hubspot', {
      pushLead: jest.fn().mockResolvedValue({ external_id: 'hs' }),
      verifyConfig: jest.fn(),
    });
    prisma._integrations.push({
      id: 'int-hs',
      coach_id: 'c1',
      provider: 'hubspot',
      enabled: true,
      credentials_encrypted: 'PLAINTEXT:{"access_token":"t"}',
      field_mapping: {},
    });
    prisma._leads.push({
      id: 'lead-x',
      page_id: 'p1',
      coach_id: 'c1',
      email: 'x@y.com',
      name: null,
      phone: null,
      payload: {},
      crm_sync_status: 'pending',
      synced_to: [],
      external_ids: {},
      attempts: 0,
      next_eligible_at: null,
      created_at: new Date(),
    });
    // Hand-drain the coach's bucket so the next call must defer.
    (processor as any).coachBuckets.set('c1', {
      tokens: 0,
      updatedAtMs: Date.now(),
    });
    await processor.runOnce();
    const lead = prisma._leads[0];
    expect(lead.crm_sync_status).toBe('pending');
    expect(lead.attempts).toBe(1);
    expect(lead.crm_error).toMatch(/rate-limited/);
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
    expect(row.credentials_encrypted).toContain('PLAINTEXT:');
    expect(row.credentials_encrypted).toContain('access_token');
  });

  it('upsert uses (coach_id, provider) compound unique to dedupe re-saves (P1-8)', async () => {
    registry.set('hubspot', {
      verifyConfig: jest.fn().mockResolvedValue(undefined),
      pushLead: jest.fn(),
    });
    await svc.upsert('coach-1', 'hubspot', { access_token: 'first' });
    await svc.upsert('coach-1', 'hubspot', { access_token: 'second' });
    expect(prisma._integrations).toHaveLength(1);
    expect(prisma._integrations[0].credentials_encrypted).toContain('second');
    // Prisma upsert was called twice but only ever creates one row.
    expect(prisma.coachCrmIntegration.upsert).toHaveBeenCalledTimes(2);
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
    expect(prisma._integrations[0].last_error).not.toContain('leaked-token');
  });
});
