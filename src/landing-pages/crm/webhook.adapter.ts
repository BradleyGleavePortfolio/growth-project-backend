/**
 * Generic outgoing-webhook adapter.
 *
 * Posts a structured JSON event to a coach-supplied URL — covers Zapier,
 * Make.com, n8n, and any custom HTTP receiver.  Optional HMAC-SHA256
 * signature in `X-TGP-Signature` lets the receiver verify provenance:
 *
 *     X-TGP-Signature: sha256=<lowercase-hex(hmac_sha256(secret, body))>
 *
 * The receiver should compare with `crypto.timingSafeEqual`.
 *
 * Required config: url        (https URL, validated by verifyConfig)
 * Optional config: secret     (when present, signs the body)
 */

import axios from 'axios';
import { createHmac } from 'crypto';
import {
  CrmAdapter,
  CrmAuthError,
  CrmConfig,
  CrmPushResult,
  CrmRateLimitError,
  LandingPageContext,
  LeadInput,
} from './crm-adapter.interface';
import { safeErrorMessage } from './_redact';

const TIMEOUT_MS = 10_000;

function isHttpsUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:';
  } catch {
    return false;
  }
}

export class WebhookAdapter implements CrmAdapter {
  readonly name = 'webhook';

  async pushLead(
    lead: LeadInput,
    landingPage: LandingPageContext,
    config: CrmConfig,
  ): Promise<CrmPushResult> {
    const url = config.url;
    if (!url) throw new CrmAuthError(this.name, 'url missing from config');
    if (!isHttpsUrl(url)) {
      throw new CrmAuthError(this.name, 'url must be https');
    }
    const body = {
      event: 'landing_lead.created',
      lead: {
        id: lead.id,
        email: lead.email,
        name: lead.name,
        phone: lead.phone,
        payload: lead.payload,
      },
      landing_page: {
        id: landingPage.id,
        slug: landingPage.slug,
        title: landingPage.headline,
      },
    };
    const bodyJson = JSON.stringify(body);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'TGP-LeadSync/1 (+https://app.trygrowthproject.com)',
    };
    if (config.secret) {
      const sig = createHmac('sha256', config.secret).update(bodyJson).digest('hex');
      headers['X-TGP-Signature'] = `sha256=${sig}`;
    }
    try {
      const resp = await axios.post(url, bodyJson, {
        headers,
        timeout: TIMEOUT_MS,
        validateStatus: () => true,
        transformRequest: [(d) => d], // bodyJson is already a string
      });
      if (resp.status === 429) {
        const retryAfterSec = Number(resp.headers['retry-after']) || 60;
        throw new CrmRateLimitError(retryAfterSec * 1000, this.name);
      }
      if (resp.status === 401 || resp.status === 403) {
        // Generic webhook can refuse signed payloads — surface as auth.
        throw new CrmAuthError(this.name, `status ${resp.status}`);
      }
      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(`Webhook returned status ${resp.status}`);
      }
      // Some receivers echo a request id in headers; fall back to lead.id.
      const requestId =
        (resp.headers['x-request-id'] as string | undefined) ??
        (resp.headers['x-tgp-receiver-id'] as string | undefined) ??
        '';
      return { external_id: requestId };
    } catch (err) {
      if (err instanceof CrmRateLimitError || err instanceof CrmAuthError) throw err;
      throw new Error(`Webhook pushLead failed: ${safeErrorMessage(err)}`);
    }
  }

  async verifyConfig(config: CrmConfig): Promise<void> {
    const url = config.url;
    if (!url) throw new CrmAuthError(this.name, 'url missing from config');
    if (!isHttpsUrl(url)) {
      throw new CrmAuthError(this.name, 'url must be https');
    }
    // Verify by posting a synthetic ping event.  Most generic webhook
    // receivers (Zapier, Make) respond 200 to any well-formed POST.  We
    // don't fail on 4xx here because some receivers reject the event
    // type but accept the URL — the real test is at pushLead time.
    try {
      const resp = await axios.post(
        url,
        JSON.stringify({ event: 'tgp.ping', ts: Date.now() }),
        {
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'TGP-LeadSync/1 (+https://app.trygrowthproject.com)',
          },
          timeout: TIMEOUT_MS,
          validateStatus: () => true,
          transformRequest: [(d) => d],
        },
      );
      if (resp.status >= 500) {
        throw new Error(`Webhook verifyConfig got 5xx (status ${resp.status})`);
      }
      // 2xx-4xx is considered a reachable endpoint.
    } catch (err) {
      throw new Error(`Webhook verifyConfig failed: ${safeErrorMessage(err)}`);
    }
  }
}
