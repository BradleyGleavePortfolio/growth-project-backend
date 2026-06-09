import { ServiceUnavailableException } from '@nestjs/common';
import { ContractEnvelopeService } from '../../src/contracts/contract-envelope.service';
import type {
  ProviderEventKind,
  SignatureProvider,
} from '../../src/contracts/providers/signature-provider.interface';

/**
 * B5 hard gate #4 — envelope state machine (all transitions) + idempotency +
 * FEATURE_CONTRACTS_ENABLED=OFF invariant (create + transition).
 *
 * No DB: a tiny in-memory fake stands in for PrismaService so the state
 * machine is exercised in pure-unit isolation. NODE_ENV=test makes
 * isContractsEnabled() default ON; we flip the explicit env flag to prove the
 * OFF invariant.
 */

interface Row {
  id: string;
  template_id: string;
  template_version: number;
  client_id: string;
  coach_id: string;
  status: string;
  expires_at: Date;
  hellosign_request_id: string | null;
  signed_at: Date | null;
  signed_pdf_url: string | null;
  ip: string | null;
  user_agent: string | null;
  purchase_id: string | null;
  created_at: Date;
}

class FakePrisma {
  envelopes = new Map<string, Row>();
  audits: any[] = [];
  templates = new Map<string, any>();
  private seq = 0;

  contractEnvelope = {
    create: async ({ data }: any) => {
      const id = `env_${++this.seq}`;
      const row: Row = {
        id,
        template_id: data.template_id,
        template_version: data.template_version,
        client_id: data.client_id,
        coach_id: data.coach_id,
        status: data.status,
        expires_at: data.expires_at,
        hellosign_request_id: data.hellosign_request_id ?? null,
        signed_at: null,
        signed_pdf_url: null,
        ip: null,
        user_agent: null,
        purchase_id: null,
        created_at: new Date(),
      };
      this.envelopes.set(id, row);
      return { ...row };
    },
    update: async ({ where, data }: any) => {
      const row = this.envelopes.get(where.id)!;
      Object.assign(row, data);
      return { ...row };
    },
    findUnique: async ({ where }: any) => {
      const r = this.envelopes.get(where.id);
      return r ? { ...r } : null;
    },
    findFirst: async ({ where }: any) => {
      for (const r of this.envelopes.values()) {
        if (where.hellosign_request_id && r.hellosign_request_id === where.hellosign_request_id) {
          return { ...r };
        }
      }
      return null;
    },
    findMany: async () => [...this.envelopes.values()].map((r) => ({ ...r })),
  };

  contractTemplate = {
    findUnique: async ({ where }: any) => this.templates.get(where.id) ?? null,
  };

  contractAuditEvent = {
    create: async ({ data }: any) => {
      this.audits.push(data);
      return data;
    },
  };
}

function makeProvider(): SignatureProvider {
  return {
    providerKey: 'fake',
    createSignatureRequest: jest.fn(async () => ({
      providerRequestId: 'req_1',
      embedUrl: 'https://embed/1',
    })),
    fetchSignedPdf: jest.fn(async () => ({ pdfBuffer: Buffer.from('pdf') })),
    verifyWebhook: jest.fn(() => true),
    parseWebhookEvent: jest.fn(() => ({ providerRequestId: 'req_1', event: 'SIGNED' as const })),
    refreshEmbedUrl: jest.fn(async () => ({ embedUrl: 'https://embed/refresh' })),
  };
}

const telemetry: any = {
  envelopeCreated: jest.fn(),
  envelopeViewed: jest.fn(),
  envelopeSigned: jest.fn(),
  envelopeDeclined: jest.fn(),
  envelopeExpired: jest.fn(),
  checkoutBlocked: jest.fn(),
  checkoutGateCleared: jest.fn(),
};

const PLATFORM_TPL = {
  id: 'tpl_platform',
  is_platform: true,
  version: 1,
  requires_signature: true,
  body_markdown:
    '# Waiver\n{{client.first_name}} {{client.last_name}} {{client.email}}\n{{client.signature_block}}\n{{coach.signature_block}}',
};

function buildService(prisma: FakePrisma, provider = makeProvider()) {
  const templates: any = {
    getByIdUnscoped: async (id: string) => prisma.templates.get(id),
  };
  const svc = new ContractEnvelopeService(prisma as any, templates, telemetry, provider);
  return { svc, provider };
}

function freshClientMerge() {
  return {
    'client.first_name': 'Ada',
    'client.last_name': 'Lovelace',
    'client.email': 'ada@x.com',
    today: '2026-06-09',
  } as any;
}

describe('ContractEnvelopeService — create + state machine', () => {
  const prevFlag = process.env.FEATURE_CONTRACTS_ENABLED;
  let prisma: FakePrisma;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.FEATURE_CONTRACTS_ENABLED = 'true';
    prisma = new FakePrisma();
    prisma.templates.set(PLATFORM_TPL.id, { ...PLATFORM_TPL });
  });
  afterAll(() => {
    if (prevFlag === undefined) delete process.env.FEATURE_CONTRACTS_ENABLED;
    else process.env.FEATURE_CONTRACTS_ENABLED = prevFlag;
  });

  async function createSent() {
    const { svc, provider } = buildService(prisma);
    const { envelope, embedUrl } = await svc.createEnvelope({
      templateId: PLATFORM_TPL.id,
      clientId: 'cli_1',
      coachId: 'sys_coach',
      layer: 'platform_waiver',
      mergeData: freshClientMerge(),
      title: 'Waiver',
      client: { email: 'ada@x.com', name: 'Ada Lovelace' },
      coach: { email: 'sys@tgp.com', name: 'Growth Project' },
    });
    return { svc, provider, envelope, embedUrl };
  }

  it('create persists DRAFT then moves to SENT with provider request id + embed url', async () => {
    const { envelope, embedUrl, provider } = await createSent();
    expect(envelope.status).toBe('SENT');
    expect(envelope.hellosign_request_id).toBe('req_1');
    expect(embedUrl).toBe('https://embed/1');
    expect(provider.createSignatureRequest).toHaveBeenCalledTimes(1);
    expect(telemetry.envelopeCreated).toHaveBeenCalledTimes(1);
  });

  it('rejects create when merge fields are unresolved (legal-doc defect guard)', async () => {
    const { svc } = buildService(prisma);
    await expect(
      svc.createEnvelope({
        templateId: PLATFORM_TPL.id,
        clientId: 'cli_1',
        coachId: 'sys_coach',
        layer: 'platform_waiver',
        // Missing client.* tokens → unresolved.
        mergeData: { today: '2026-06-09' } as any,
        title: 'Waiver',
        client: { email: 'ada@x.com', name: 'Ada Lovelace' },
        coach: { email: 'sys@tgp.com', name: 'Growth Project' },
      }),
    ).rejects.toThrow(/merge field/i);
  });

  it('SENT → VIEWED → SIGNED, with allow_checkout downstream on SIGNED', async () => {
    const { svc } = await createSent();
    const viewed = await svc.applyProviderEvent('req_1', 'VIEWED', {});
    expect(viewed).toMatchObject({ applied: true, downstream: 'none' });

    const signed = await svc.applyProviderEvent('req_1', 'SIGNED', {});
    expect(signed).toMatchObject({ applied: true, downstream: 'allow_checkout' });
    expect((signed as any).envelope.status).toBe('SIGNED');
    expect((signed as any).envelope.signed_at).toBeTruthy();
  });

  it('SENT → DECLINED yields void_purchase downstream', async () => {
    const { svc } = await createSent();
    const declined = await svc.applyProviderEvent('req_1', 'DECLINED', {});
    expect(declined).toMatchObject({ applied: true, downstream: 'void_purchase' });
  });

  it('is idempotent: a replayed SIGNED on an already-SIGNED envelope is a no-op', async () => {
    const { svc } = await createSent();
    await svc.applyProviderEvent('req_1', 'SIGNED', {});
    const replay = await svc.applyProviderEvent('req_1', 'SIGNED', {});
    expect(replay).toEqual({ applied: false, reason: 'terminal_noop' });
  });

  it('never resurrects a terminal envelope (SIGNED after DECLINED is refused)', async () => {
    const { svc } = await createSent();
    await svc.applyProviderEvent('req_1', 'DECLINED', {});
    const illegal = await svc.applyProviderEvent('req_1', 'SIGNED', {});
    expect(illegal).toEqual({ applied: false, reason: 'terminal_noop' });
    const row = [...prisma.envelopes.values()][0];
    expect(row.status).toBe('DECLINED');
  });

  it('returns not_found for an unknown provider request id', async () => {
    const { svc } = buildService(prisma);
    const res = await svc.applyProviderEvent('does_not_exist', 'SIGNED', {});
    expect(res).toEqual({ applied: false, reason: 'not_found' });
  });

  it('expireDue transitions only SENT/VIEWED past expiry to EXPIRED', async () => {
    const { svc } = await createSent();
    // Force the only envelope to be past expiry.
    [...prisma.envelopes.values()][0].expires_at = new Date(Date.now() - 1000);
    const n = await svc.expireDue(new Date());
    expect(n).toBe(1);
    expect([...prisma.envelopes.values()][0].status).toBe('EXPIRED');
  });
});

describe('FEATURE_CONTRACTS_ENABLED=OFF invariant (server-side, code-level)', () => {
  const prevFlag = process.env.FEATURE_CONTRACTS_ENABLED;
  let prisma: FakePrisma;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.FEATURE_CONTRACTS_ENABLED = 'false';
    prisma = new FakePrisma();
    prisma.templates.set(PLATFORM_TPL.id, { ...PLATFORM_TPL });
  });
  afterAll(() => {
    if (prevFlag === undefined) delete process.env.FEATURE_CONTRACTS_ENABLED;
    else process.env.FEATURE_CONTRACTS_ENABLED = prevFlag;
  });

  it('createEnvelope THROWS ServiceUnavailable when the flag is OFF (no envelope ever sent)', async () => {
    const { svc, provider } = buildService(prisma);
    await expect(
      svc.createEnvelope({
        templateId: PLATFORM_TPL.id,
        clientId: 'cli_1',
        coachId: 'sys_coach',
        layer: 'platform_waiver',
        mergeData: freshClientMerge(),
        title: 'Waiver',
        client: { email: 'ada@x.com', name: 'Ada Lovelace' },
        coach: { email: 'sys@tgp.com', name: 'Growth Project' },
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(provider.createSignatureRequest).not.toHaveBeenCalled();
    expect(prisma.envelopes.size).toBe(0);
  });

  it('applyProviderEvent refuses to mutate state when the flag is OFF', async () => {
    // Seed a SENT envelope directly (simulating one created while ON).
    prisma.envelopes.set('env_x', {
      id: 'env_x',
      template_id: PLATFORM_TPL.id,
      template_version: 1,
      client_id: 'cli_1',
      coach_id: 'sys_coach',
      status: 'SENT',
      expires_at: new Date(Date.now() + 1e9),
      hellosign_request_id: 'req_1',
      signed_at: null,
      signed_pdf_url: null,
      ip: null,
      user_agent: null,
      purchase_id: null,
      created_at: new Date(),
    });
    const { svc } = buildService(prisma);
    const res = await svc.applyProviderEvent('req_1', 'SIGNED', {});
    expect(res).toEqual({ applied: false, reason: 'disabled' });
    expect(prisma.envelopes.get('env_x')!.status).toBe('SENT');
    expect(prisma.audits.length).toBe(0);
  });
});
