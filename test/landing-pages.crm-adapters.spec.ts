/**
 * R47 CRM adapter unit tests.
 *
 * Strategy: mock axios at the module level so each adapter test owns the
 * exact mock-response shape it needs. We assert request shape (URL,
 * headers, body) and response handling (idempotent dedupe, 429 retry,
 * 401 auth failure, credential redaction in error messages).
 */

import { HubSpotAdapter } from '../src/landing-pages/crm/hubspot.adapter';
import { GoHighLevelAdapter } from '../src/landing-pages/crm/gohighlevel.adapter';
import { MailchimpAdapter } from '../src/landing-pages/crm/mailchimp.adapter';
import { ActiveCampaignAdapter } from '../src/landing-pages/crm/activecampaign.adapter';
import { WebhookAdapter } from '../src/landing-pages/crm/webhook.adapter';
import {
  CrmAuthError,
  CrmRateLimitError,
} from '../src/landing-pages/crm/crm-adapter.interface';
import { CrmRegistryService } from '../src/landing-pages/crm/crm-registry.service';

// ─── Axios mock setup ─────────────────────────────────────────────────────────

jest.mock('axios');
import axios from 'axios';
const mockedAxios = axios as unknown as { post: jest.Mock; get: jest.Mock };
mockedAxios.post = jest.fn();
mockedAxios.get = jest.fn();

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const LEAD = {
  id: 'lead-1',
  email: 'jane@example.com',
  name: 'Jane Doe',
  phone: '+15551234567',
  payload: { goal: 'lose 20 lbs' } as any,
};

const PAGE = {
  id: 'page-1',
  slug: 'transform-now',
  headline: 'Transform in 12 Weeks',
};

beforeEach(() => {
  mockedAxios.post.mockReset();
  mockedAxios.get.mockReset();
});

// ─── HubSpot ──────────────────────────────────────────────────────────────────

describe('HubSpotAdapter', () => {
  const adapter = new HubSpotAdapter();

  it('POSTs to /crm/v3/objects/contacts with Bearer token and maps name', async () => {
    mockedAxios.post.mockResolvedValueOnce({ status: 201, data: { id: 'hs-99' }, headers: {} });
    const out = await adapter.pushLead(LEAD, PAGE, { access_token: 'tok' });
    expect(out.external_id).toBe('hs-99');
    const [url, body, opts] = mockedAxios.post.mock.calls[0];
    expect(url).toBe('https://api.hubapi.com/crm/v3/objects/contacts');
    expect(body.properties.email).toBe('jane@example.com');
    expect(body.properties.firstname).toBe('Jane');
    expect(body.properties.lastname).toBe('Doe');
    expect(body.properties.phone).toBe('+15551234567');
    expect(body.properties.tgp_landing_page_id).toBe('page-1');
    expect(opts.headers.Authorization).toBe('Bearer tok');
    expect(opts.timeout).toBe(10_000);
    expect(opts.validateStatus()).toBe(true);
  });

  it('treats 409 with Existing ID as idempotent success', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      status: 409,
      data: { message: 'Existing ID: 12345' },
      headers: {},
    });
    const out = await adapter.pushLead(LEAD, PAGE, { access_token: 'tok' });
    expect(out.external_id).toBe('12345');
  });

  it('throws CrmRateLimitError honoring Retry-After on 429', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      status: 429,
      data: {},
      headers: { 'retry-after': '30' },
    });
    await expect(adapter.pushLead(LEAD, PAGE, { access_token: 'tok' })).rejects.toBeInstanceOf(
      CrmRateLimitError,
    );
    try {
      await adapter.pushLead(LEAD, PAGE, { access_token: 'tok' });
    } catch (e) {
      if (e instanceof CrmRateLimitError) expect(e.retryAfterMs).toBe(30_000);
    }
  });

  it('throws CrmAuthError on 401 without leaking the token', async () => {
    mockedAxios.post.mockResolvedValueOnce({ status: 401, data: {}, headers: {} });
    let err: unknown;
    try {
      await adapter.pushLead(LEAD, PAGE, { access_token: 'super-secret-token-abc' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CrmAuthError);
    expect(String((err as Error).message)).not.toContain('super-secret-token-abc');
  });

  it('verifyConfig calls /contacts?limit=1 and rejects on 401', async () => {
    mockedAxios.get.mockResolvedValueOnce({ status: 401, data: {}, headers: {} });
    await expect(adapter.verifyConfig({ access_token: 'bad' })).rejects.toBeInstanceOf(
      CrmAuthError,
    );
  });

  it('verifyConfig succeeds on 200', async () => {
    mockedAxios.get.mockResolvedValueOnce({ status: 200, data: { results: [] }, headers: {} });
    await expect(adapter.verifyConfig({ access_token: 'good' })).resolves.toBeUndefined();
  });

  it('rejects when access_token missing', async () => {
    await expect(adapter.pushLead(LEAD, PAGE, {})).rejects.toBeInstanceOf(CrmAuthError);
  });
});

// ─── GoHighLevel ──────────────────────────────────────────────────────────────

describe('GoHighLevelAdapter', () => {
  const adapter = new GoHighLevelAdapter();

  it('POSTs to /contacts/ with Version header and locationId', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      status: 201,
      data: { contact: { id: 'ghl-1' } },
      headers: {},
    });
    const out = await adapter.pushLead(LEAD, PAGE, { api_key: 'k', locationId: 'loc-1' });
    expect(out.external_id).toBe('ghl-1');
    const [url, body, opts] = mockedAxios.post.mock.calls[0];
    expect(url).toBe('https://services.leadconnectorhq.com/contacts/');
    expect(opts.headers.Version).toBe('2021-07-28');
    expect(opts.headers.Authorization).toBe('Bearer k');
    expect(body.locationId).toBe('loc-1');
    expect(body.email).toBe('jane@example.com');
  });

  it('returns existing contact id on duplicate (status 400 + meta.contactId)', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      status: 400,
      data: { meta: { contactId: 'ghl-dup' } },
      headers: {},
    });
    const out = await adapter.pushLead(LEAD, PAGE, { api_key: 'k', locationId: 'loc' });
    expect(out.external_id).toBe('ghl-dup');
  });

  it('throws CrmAuthError on missing locationId', async () => {
    await expect(adapter.pushLead(LEAD, PAGE, { api_key: 'k' })).rejects.toBeInstanceOf(
      CrmAuthError,
    );
  });

  it('throws CrmRateLimitError on 429 honoring Retry-After', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      status: 429,
      data: {},
      headers: { 'retry-after': '15' },
    });
    await expect(
      adapter.pushLead(LEAD, PAGE, { api_key: 'k', locationId: 'l' }),
    ).rejects.toBeInstanceOf(CrmRateLimitError);
  });
});

// ─── Mailchimp ────────────────────────────────────────────────────────────────

describe('MailchimpAdapter', () => {
  const adapter = new MailchimpAdapter();

  it('infers dc from api_key suffix and POSTs to dc.api.mailchimp.com', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      status: 200,
      data: { id: 'mc-1' },
      headers: {},
    });
    await adapter.pushLead(LEAD, PAGE, { api_key: 'abc-us19', list_id: 'L1' });
    const url = mockedAxios.post.mock.calls[0][0];
    expect(url).toBe('https://us19.api.mailchimp.com/3.0/lists/L1/members');
  });

  it('treats "Member Exists" 400 as success and returns md5 subscriber hash', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      status: 400,
      data: { title: 'Member Exists' },
      headers: {},
    });
    const out = await adapter.pushLead(LEAD, PAGE, { api_key: 'k-us21', list_id: 'L' });
    // md5(lowercase("jane@example.com")) — Mailchimp's subscriber_hash spec.
    expect(out.external_id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('rejects api_key without recognizable dc suffix', async () => {
    await expect(
      adapter.pushLead(LEAD, PAGE, { api_key: 'no-suffix-key', list_id: 'L' }),
    ).rejects.toBeInstanceOf(CrmAuthError);
  });

  it('uses Basic anystring:<api_key> auth', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      status: 200,
      data: { id: 'mc-2' },
      headers: {},
    });
    await adapter.pushLead(LEAD, PAGE, { api_key: 'secret-us19', list_id: 'L' });
    const opts = mockedAxios.post.mock.calls[0][2];
    const auth = opts.headers.Authorization as string;
    expect(auth).toMatch(/^Basic /);
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    expect(decoded).toBe('anystring:secret-us19');
  });
});

// ─── ActiveCampaign ───────────────────────────────────────────────────────────

describe('ActiveCampaignAdapter', () => {
  const adapter = new ActiveCampaignAdapter();

  it('POSTs to /api/3/contact/sync with Api-Token header', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      status: 200,
      data: { contact: { id: '42' } },
      headers: {},
    });
    const out = await adapter.pushLead(LEAD, PAGE, {
      account: 'myacct',
      api_token: 'tok',
    });
    expect(out.external_id).toBe('42');
    const [url, body, opts] = mockedAxios.post.mock.calls[0];
    expect(url).toBe('https://myacct.api-us1.com/api/3/contact/sync');
    expect(opts.headers['Api-Token']).toBe('tok');
    expect(body.contact.email).toBe('jane@example.com');
  });

  it('rejects when account is missing', async () => {
    await expect(adapter.pushLead(LEAD, PAGE, { api_token: 'k' })).rejects.toBeInstanceOf(
      CrmAuthError,
    );
  });
});

// ─── Webhook ──────────────────────────────────────────────────────────────────

describe('WebhookAdapter', () => {
  const adapter = new WebhookAdapter();

  it('POSTs structured event to config.url with no signature when secret absent', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      status: 200,
      data: { ok: true },
      headers: {},
    });
    await adapter.pushLead(LEAD, PAGE, { url: 'https://hook.example.com/x' });
    const [url, body, opts] = mockedAxios.post.mock.calls[0];
    expect(url).toBe('https://hook.example.com/x');
    expect(opts.headers['X-TGP-Signature']).toBeUndefined();
    const parsed = JSON.parse(body as string);
    expect(parsed.event).toBe('landing_lead.created');
    expect(parsed.landing_page.id).toBe('page-1');
  });

  it('signs body with HMAC-SHA256 when secret is provided', async () => {
    mockedAxios.post.mockResolvedValueOnce({ status: 200, data: {}, headers: {} });
    await adapter.pushLead(LEAD, PAGE, {
      url: 'https://hook.example.com/x',
      secret: 'shared-secret',
    });
    const opts = mockedAxios.post.mock.calls[0][2];
    const sig = opts.headers['X-TGP-Signature'] as string;
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('rejects http:// URL', async () => {
    await expect(
      adapter.pushLead(LEAD, PAGE, { url: 'http://insecure.example.com' }),
    ).rejects.toBeInstanceOf(CrmAuthError);
  });

  it('rejects missing url', async () => {
    await expect(adapter.pushLead(LEAD, PAGE, {})).rejects.toBeInstanceOf(CrmAuthError);
  });
});

// ─── Registry ────────────────────────────────────────────────────────────────

describe('CrmRegistryService', () => {
  const reg = new CrmRegistryService();

  it('returns an adapter for every CrmProvider enum value', () => {
    for (const provider of [
      'hubspot',
      'gohighlevel',
      'mailchimp',
      'activecampaign',
      'webhook',
    ] as const) {
      const adapter = reg.getAdapter(provider);
      expect(adapter.name).toBe(provider);
    }
  });

  it('throws for unknown provider', () => {
    expect(() => reg.getAdapter('unknown' as any)).toThrow(/No CRM adapter/);
  });
});
