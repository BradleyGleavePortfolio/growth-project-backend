import { UnauthorizedException } from '@nestjs/common';
import { HelloSignWebhookController } from '../../src/contracts/webhooks/hellosign-webhook.controller';
import type { SignatureProvider } from '../../src/contracts/providers/signature-provider.interface';

/**
 * B5 hard gate #4 — webhook controller: signature verification (401 on fail)
 * and the FEATURE_CONTRACTS_ENABLED=OFF invariant (200-ack, NO state mutation).
 */

function reqWith(body: any, contentType = 'application/json'): any {
  const raw = Buffer.from(JSON.stringify(body), 'utf8');
  return {
    rawBody: raw,
    headers: { 'content-type': contentType, 'user-agent': 'jest' },
    ip: '203.0.113.7',
    socket: { remoteAddress: '203.0.113.7' },
  };
}

const EVENT_BODY = {
  event: { event_time: '1700000000', event_type: 'signature_request_all_signed', event_hash: 'hash' },
  signature_request: { signature_request_id: 'req_1' },
};

function build(opts: { verify: boolean }) {
  const provider: SignatureProvider = {
    providerKey: 'fake',
    createSignatureRequest: jest.fn(),
    fetchSignedPdf: jest.fn(async () => ({ pdfBuffer: Buffer.from('pdf') })),
    verifyWebhook: jest.fn(() => opts.verify),
    parseWebhookEvent: jest.fn(() => ({ providerRequestId: 'req_1', event: 'SIGNED' as const })),
    refreshEmbedUrl: jest.fn(),
  };
  const envelopes: any = {
    applyProviderEvent: jest.fn(async () => ({
      applied: true,
      envelope: { id: 'env_1' },
      downstream: 'allow_checkout',
    })),
    setSignedPdfUrl: jest.fn(),
  };
  const pdfStore: any = { store: jest.fn(async () => 'local://env_1.pdf') };
  const ctrl = new HelloSignWebhookController(envelopes, pdfStore, provider);
  return { ctrl, provider, envelopes, pdfStore };
}

describe('HelloSignWebhookController', () => {
  const prev = process.env.FEATURE_CONTRACTS_ENABLED;
  afterAll(() => {
    if (prev === undefined) delete process.env.FEATURE_CONTRACTS_ENABLED;
    else process.env.FEATURE_CONTRACTS_ENABLED = prev;
  });
  beforeEach(() => jest.clearAllMocks());

  it('rejects an UNVERIFIED webhook with 401 and never advances state', async () => {
    process.env.FEATURE_CONTRACTS_ENABLED = 'true';
    const { ctrl, envelopes } = build({ verify: false });
    await expect(ctrl.handle(reqWith(EVENT_BODY))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(envelopes.applyProviderEvent).not.toHaveBeenCalled();
  });

  it('rejects with 401 when rawBody is missing (misconfigured middleware)', async () => {
    process.env.FEATURE_CONTRACTS_ENABLED = 'true';
    const { ctrl } = build({ verify: true });
    const bad: any = { headers: {} };
    await expect(ctrl.handle(bad)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('verified + flag ON → applies the event and 200-acks with the required body', async () => {
    process.env.FEATURE_CONTRACTS_ENABLED = 'true';
    const { ctrl, envelopes, pdfStore } = build({ verify: true });
    const ack = await ctrl.handle(reqWith(EVENT_BODY));
    expect(ack).toContain('Hello API Event Received');
    expect(envelopes.applyProviderEvent).toHaveBeenCalledWith(
      'req_1',
      'SIGNED',
      expect.objectContaining({ ip: '203.0.113.7' }),
    );
    // On SIGNED it captures + stores the signed PDF.
    expect(pdfStore.store).toHaveBeenCalledTimes(1);
    expect(envelopes.setSignedPdfUrl).toHaveBeenCalledWith('env_1', 'local://env_1.pdf');
  });

  it('verified but flag OFF → 200-acks WITHOUT mutating state (invariant)', async () => {
    process.env.FEATURE_CONTRACTS_ENABLED = 'false';
    const { ctrl, envelopes, provider } = build({ verify: true });
    const ack = await ctrl.handle(reqWith(EVENT_BODY));
    expect(ack).toContain('Hello API Event Received');
    expect(provider.verifyWebhook).toHaveBeenCalledTimes(1); // still verifies
    expect(envelopes.applyProviderEvent).not.toHaveBeenCalled(); // but never mutates
  });
});
