/**
 * Mailchimp CRM/audience adapter.
 *
 * Endpoint: POST https://<dc>.api.mailchimp.com/3.0/lists/<list_id>/members
 * Auth:     Basic anystring:<api_key>
 * Required config: api_key, list_id
 *
 * The data center suffix (`<dc>`) is encoded in the api_key itself —
 * everything after the final '-' identifies the dc (us19, us21, etc.).
 *
 * Idempotency: subscriber_hash = md5(lowercase(email)) — Mailchimp
 * dedupes by hash.  A duplicate POST returns 400 with
 * "<email> is already a list member" which we treat as success.
 */

import axios from 'axios';
import { createHash } from 'crypto';
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

function inferDc(apiKey: string): string | null {
  const idx = apiKey.lastIndexOf('-');
  if (idx === -1) return null;
  const dc = apiKey.slice(idx + 1).trim();
  // Mailchimp DCs are 2 lowercase letters + digits (e.g. "us19").
  if (!/^[a-z]{2}\d{1,3}$/.test(dc)) return null;
  return dc;
}

function subscriberHash(email: string): string {
  return createHash('md5').update(email.trim().toLowerCase()).digest('hex');
}

function splitName(full: string | null | undefined): { FNAME: string; LNAME: string } {
  if (!full) return { FNAME: '', LNAME: '' };
  const trimmed = full.trim();
  if (!trimmed) return { FNAME: '', LNAME: '' };
  const idx = trimmed.indexOf(' ');
  if (idx === -1) return { FNAME: trimmed, LNAME: '' };
  return { FNAME: trimmed.slice(0, idx), LNAME: trimmed.slice(idx + 1).trim() };
}

export class MailchimpAdapter implements CrmAdapter {
  readonly name = 'mailchimp';

  async pushLead(
    lead: LeadInput,
    landingPage: LandingPageContext,
    config: CrmConfig,
  ): Promise<CrmPushResult> {
    const apiKey = config.api_key;
    const listId = config.list_id;
    if (!apiKey) throw new CrmAuthError(this.name, 'api_key missing from config');
    if (!listId) throw new CrmAuthError(this.name, 'list_id missing from config');
    const dc = inferDc(apiKey);
    if (!dc) throw new CrmAuthError(this.name, 'api_key has no recognizable dc suffix');

    const baseUrl = `https://${dc}.api.mailchimp.com/3.0`;
    const auth = Buffer.from(`anystring:${apiKey}`).toString('base64');
    const { FNAME, LNAME } = splitName(lead.name);
    const body: Record<string, unknown> = {
      email_address: lead.email,
      status: 'subscribed',
      merge_fields: { FNAME, LNAME, PHONE: lead.phone ?? '' },
      tags: [`tgp-landing-${landingPage.slug}`.slice(0, 50)],
    };
    try {
      const resp = await axios.post(
        `${baseUrl}/lists/${listId}/members`,
        body,
        {
          headers: {
            Authorization: `Basic ${auth}`,
            'Content-Type': 'application/json',
          },
          timeout: TIMEOUT_MS,
          validateStatus: () => true,
        },
      );
      if (resp.status === 429) {
        const retryAfterSec = Number(resp.headers['retry-after']) || 60;
        throw new CrmRateLimitError(retryAfterSec * 1000, this.name);
      }
      if (resp.status === 401 || resp.status === 403) {
        throw new CrmAuthError(this.name, `status ${resp.status}`);
      }
      if (resp.status === 400) {
        const detail = (resp.data?.title as string | undefined) ?? '';
        // 'Member Exists' is the idempotent-success signal.
        if (detail === 'Member Exists' || /already a list member/i.test(detail)) {
          return { external_id: subscriberHash(lead.email) };
        }
        throw new Error(`Mailchimp 400 ${detail}`);
      }
      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(`Mailchimp returned status ${resp.status}`);
      }
      const id = (resp.data?.id as string | undefined) ?? subscriberHash(lead.email);
      return { external_id: id };
    } catch (err) {
      if (err instanceof CrmRateLimitError || err instanceof CrmAuthError) throw err;
      throw new Error(`Mailchimp pushLead failed: ${safeErrorMessage(err)}`);
    }
  }

  async verifyConfig(config: CrmConfig): Promise<void> {
    const apiKey = config.api_key;
    const listId = config.list_id;
    if (!apiKey) throw new CrmAuthError(this.name, 'api_key missing from config');
    if (!listId) throw new CrmAuthError(this.name, 'list_id missing from config');
    const dc = inferDc(apiKey);
    if (!dc) throw new CrmAuthError(this.name, 'api_key has no recognizable dc suffix');
    const auth = Buffer.from(`anystring:${apiKey}`).toString('base64');
    try {
      const resp = await axios.get(
        `https://${dc}.api.mailchimp.com/3.0/lists/${listId}`,
        {
          headers: { Authorization: `Basic ${auth}` },
          timeout: TIMEOUT_MS,
          validateStatus: () => true,
        },
      );
      if (resp.status === 401 || resp.status === 403) {
        throw new CrmAuthError(this.name, `status ${resp.status}`);
      }
      if (resp.status === 404) {
        throw new CrmAuthError(this.name, 'list_id not found');
      }
      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(`Mailchimp verifyConfig returned status ${resp.status}`);
      }
    } catch (err) {
      if (err instanceof CrmAuthError) throw err;
      throw new Error(`Mailchimp verifyConfig failed: ${safeErrorMessage(err)}`);
    }
  }
}
