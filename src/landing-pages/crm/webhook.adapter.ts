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
 *
 * SECURITY (audit #6 P0-1):
 *   The URL is run through `assertPublicHttpsUrl` (src/common/net/ssrf-guard.ts)
 *   on every push and verify — rejects private/loopback/link-local/IMDS
 *   ranges on both IPv4 and IPv6. The axios request is pinned to the
 *   resolved IP via a custom `lookup` callback to defeat DNS rebinding,
 *   and `maxRedirects: 0` ensures axios never follows a 30x into a
 *   private destination.
 */

import axios from 'axios';
import { createHmac } from 'crypto';
import https from 'https';
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
import { assertPublicHttpsUrl, lookupForResolved } from '../../common/net/ssrf-guard';

const TIMEOUT_MS = 10_000;

export class WebhookAdapter implements CrmAdapter {
  readonly name = 'webhook';

  async pushLead(
    lead: LeadInput,
    landingPage: LandingPageContext,
    config: CrmConfig,
  ): Promise<CrmPushResult> {
    const rawUrl = config.url;
    if (!rawUrl) throw new CrmAuthError(this.name, 'url missing from config');
    let asserted;
    try {
      asserted = await assertPublicHttpsUrl(rawUrl);
    } catch (err) {
      throw new CrmAuthError(this.name, `url rejected: ${(err as Error).message}`);
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
    const agent = new https.Agent({ lookup: lookupForResolved(asserted.resolved) });
    try {
      const resp = await axios.post(asserted.url.toString(), bodyJson, {
        headers,
        timeout: TIMEOUT_MS,
        validateStatus: () => true,
        transformRequest: [(d) => d], // bodyJson is already a string
        maxRedirects: 0,
        httpsAgent: agent,
      });
      if (resp.status === 429) {
        const retryAfterSec = Number(resp.headers['retry-after']) || 60;
        throw new CrmRateLimitError(retryAfterSec * 1000, this.name);
      }
      if (resp.status === 401 || resp.status === 403) {
        // Generic webhook can refuse signed payloads — surface as auth.
        throw new CrmAuthError(this.name, `status ${resp.status}`);
      }
      if (resp.status >= 300 && resp.status < 400) {
        throw new Error(
          `Webhook returned redirect (status ${resp.status}); not followed (SSRF guard)`,
        );
      }
      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(`Webhook returned status ${resp.status}`);
      }
      // Some receivers echo a request id in headers; fall back to lead.id.
      const requestId =
        (resp.headers['x-request-id'] as string | undefined) ??
        (resp.headers['x-tgp-receiver-id'] as string | undefined) ??
        '';
      return { external_id: requestId || `tgp-${lead.id}` };
    } catch (err) {
      if (err instanceof CrmRateLimitError || err instanceof CrmAuthError) throw err;
      throw new Error(`Webhook pushLead failed: ${safeErrorMessage(err)}`);
    }
  }

  async verifyConfig(config: CrmConfig): Promise<void> {
    const rawUrl = config.url;
    if (!rawUrl) throw new CrmAuthError(this.name, 'url missing from config');
    let asserted;
    try {
      asserted = await assertPublicHttpsUrl(rawUrl);
    } catch (err) {
      throw new CrmAuthError(this.name, `url rejected: ${(err as Error).message}`);
    }
    const agent = new https.Agent({ lookup: lookupForResolved(asserted.resolved) });
    // Verify by posting a synthetic ping event.  Most generic webhook
    // receivers (Zapier, Make) respond 200 to any well-formed POST.  We
    // don't fail on 4xx here because some receivers reject the event
    // type but accept the URL — the real test is at pushLead time.
    try {
      const resp = await axios.post(
        asserted.url.toString(),
        JSON.stringify({ event: 'tgp.ping', ts: Date.now() }),
        {
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'TGP-LeadSync/1 (+https://app.trygrowthproject.com)',
          },
          timeout: TIMEOUT_MS,
          validateStatus: () => true,
          transformRequest: [(d) => d],
          maxRedirects: 0,
          httpsAgent: agent,
        },
      );
      if (resp.status >= 500) {
        throw new Error(`Webhook verifyConfig got 5xx (status ${resp.status})`);
      }
      if (resp.status >= 300 && resp.status < 400) {
        throw new Error(
          `Webhook verifyConfig got redirect (status ${resp.status}); not followed (SSRF guard)`,
        );
      }
      // 2xx-4xx is considered a reachable endpoint.
    } catch (err) {
      throw new Error(`Webhook verifyConfig failed: ${safeErrorMessage(err)}`);
    }
  }
}
