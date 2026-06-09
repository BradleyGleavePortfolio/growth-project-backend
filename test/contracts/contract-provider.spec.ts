import { createHmac } from 'crypto';
import { HelloSignProvider } from '../../src/contracts/providers/hellosign.provider';
import { DocuSignProvider } from '../../src/contracts/providers/docusign.provider';
import { NativeCanvasProvider } from '../../src/contracts/providers/native-canvas.provider';
import type { ProviderWebhookRequest } from '../../src/contracts/providers/signature-provider.interface';

/**
 * B5 hard gate #4 — provider abstraction + webhook signature verification.
 *
 * Covers the security-critical, environment-independent path: the HelloSign
 * HMAC verify/parse (no SDK, no network), plus the two future providers being
 * inert NotImplemented stubs that NEVER perform a real operation in v1.
 */

const API_KEY = 'hs-test-api-key-1234567890';

function hsEvent(eventType: string, sigReqId = 'req_abc'): ProviderWebhookRequest {
  const eventTime = '1700000000';
  const eventHash = createHmac('sha256', API_KEY)
    .update(`${eventTime}${eventType}`)
    .digest('hex');
  const payload = {
    event: {
      event_time: eventTime,
      event_type: eventType,
      event_hash: eventHash,
    },
    signature_request: { signature_request_id: sigReqId },
  };
  const raw = Buffer.from(JSON.stringify(payload), 'utf8');
  return { rawBody: raw, headers: { 'content-type': 'application/json' }, parsedBody: payload };
}

describe('HelloSignProvider — webhook signature verification (hard gate #4)', () => {
  let provider: HelloSignProvider;
  const prev = process.env.HELLOSIGN_API_KEY;

  beforeAll(() => {
    process.env.HELLOSIGN_API_KEY = API_KEY;
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.HELLOSIGN_API_KEY;
    else process.env.HELLOSIGN_API_KEY = prev;
  });
  beforeEach(() => {
    provider = new HelloSignProvider();
  });

  it('exposes a stable provider key', () => {
    expect(provider.providerKey).toBe('hellosign');
  });

  it('accepts a correctly-signed event (HMAC over event_time+event_type)', () => {
    expect(provider.verifyWebhook(hsEvent('signature_request_signed'))).toBe(true);
  });

  it('REJECTS a tampered event_hash', () => {
    const req = hsEvent('signature_request_signed');
    (req.parsedBody as any).event.event_hash = 'deadbeef'.repeat(8);
    expect(provider.verifyWebhook(req)).toBe(false);
  });

  it('REJECTS when the signed message is mutated after signing (event_type swap)', () => {
    const req = hsEvent('signature_request_signed');
    // Keep the original (valid) hash but change the type → message mismatch.
    (req.parsedBody as any).event.event_type = 'signature_request_declined';
    expect(provider.verifyWebhook(req)).toBe(false);
  });

  it('REJECTS when required fields are missing', () => {
    const req = hsEvent('signature_request_signed');
    delete (req.parsedBody as any).event.event_hash;
    expect(provider.verifyWebhook(req)).toBe(false);
  });

  it('REJECTS (does not throw) when the API key is unset', () => {
    delete process.env.HELLOSIGN_API_KEY;
    expect(provider.verifyWebhook(hsEvent('signature_request_signed'))).toBe(false);
    process.env.HELLOSIGN_API_KEY = API_KEY;
  });

  it('parses a verified event into provider request id + normalized event', () => {
    expect(provider.parseWebhookEvent(hsEvent('signature_request_viewed'))).toEqual({
      providerRequestId: 'req_abc',
      event: 'VIEWED',
    });
    expect(provider.parseWebhookEvent(hsEvent('signature_request_all_signed'))).toEqual({
      providerRequestId: 'req_abc',
      event: 'SIGNED',
    });
    expect(provider.parseWebhookEvent(hsEvent('signature_request_declined'))).toEqual({
      providerRequestId: 'req_abc',
      event: 'DECLINED',
    });
  });

  it('throws on an unmapped (non-state-advancing) event type', () => {
    expect(() => provider.parseWebhookEvent(hsEvent('callback_test'))).toThrow();
  });
});

describe('Future providers are inert NotImplemented stubs (v1 anti-scope)', () => {
  it('DocuSign throws on every operation (never advances state in v1)', () => {
    const d = new DocuSignProvider();
    expect(d.providerKey).toBe('docusign');
    expect(() =>
      d.createSignatureRequest({
        envelopeId: 'e',
        renderedHtml: '<p/>',
        client: { email: 'c@x.com', name: 'C' },
        coach: { email: 'k@x.com', name: 'K' },
        title: 't',
        expiresAt: new Date(),
      }),
    ).toThrow();
    // Stub belt-and-braces: even verification throws, so a misconfigured
    // flag-on deploy can NEVER advance state through these providers in v1.
    expect(() =>
      d.verifyWebhook({ rawBody: Buffer.from('{}'), headers: {} }),
    ).toThrow();
  });

  it('native-canvas throws on every operation including verification', () => {
    const n = new NativeCanvasProvider();
    expect(n.providerKey).toBe('native_canvas');
    expect(() => n.fetchSignedPdf('req')).toThrow();
    expect(() =>
      n.verifyWebhook({ rawBody: Buffer.from('{}'), headers: {} }),
    ).toThrow();
  });
});
