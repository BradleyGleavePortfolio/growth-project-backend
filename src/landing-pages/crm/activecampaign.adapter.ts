/**
 * ActiveCampaign adapter.
 *
 * Endpoint: POST https://<account>.api-us1.com/api/3/contact/sync
 * Auth:     Api-Token: <api_token>
 * Required config: account, api_token
 *
 * /contact/sync is the idempotent upsert endpoint — repeat calls with
 * the same email update the existing contact in place.  Returns the
 * contact object including `id`.
 */

import axios from 'axios';
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

function splitName(full: string | null | undefined): { firstName: string; lastName: string } {
  if (!full) return { firstName: '', lastName: '' };
  const trimmed = full.trim();
  if (!trimmed) return { firstName: '', lastName: '' };
  const idx = trimmed.indexOf(' ');
  if (idx === -1) return { firstName: trimmed, lastName: '' };
  return { firstName: trimmed.slice(0, idx), lastName: trimmed.slice(idx + 1).trim() };
}

export class ActiveCampaignAdapter implements CrmAdapter {
  readonly name = 'activecampaign';

  async pushLead(
    lead: LeadInput,
    landingPage: LandingPageContext,
    config: CrmConfig,
  ): Promise<CrmPushResult> {
    const account = config.account;
    const token = config.api_token;
    if (!account) throw new CrmAuthError(this.name, 'account missing from config');
    if (!token) throw new CrmAuthError(this.name, 'api_token missing from config');
    const { firstName, lastName } = splitName(lead.name);
    const body = {
      contact: {
        email: lead.email,
        firstName,
        lastName,
        phone: lead.phone ?? '',
        fieldValues: [
          { field: 'tgp_landing_page_id', value: landingPage.id },
          { field: 'tgp_landing_source', value: landingPage.headline.slice(0, 80) },
        ],
      },
    };
    try {
      const resp = await axios.post(
        `https://${account}.api-us1.com/api/3/contact/sync`,
        body,
        {
          headers: {
            'Api-Token': token,
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
      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(`ActiveCampaign returned status ${resp.status}`);
      }
      const id =
        (resp.data?.contact?.id as string | undefined) ??
        (resp.data?.id as string | undefined) ??
        '';
      return { external_id: id };
    } catch (err) {
      if (err instanceof CrmRateLimitError || err instanceof CrmAuthError) throw err;
      throw new Error(`ActiveCampaign pushLead failed: ${safeErrorMessage(err)}`);
    }
  }

  async verifyConfig(config: CrmConfig): Promise<void> {
    const account = config.account;
    const token = config.api_token;
    if (!account) throw new CrmAuthError(this.name, 'account missing from config');
    if (!token) throw new CrmAuthError(this.name, 'api_token missing from config');
    try {
      const resp = await axios.get(
        `https://${account}.api-us1.com/api/3/users/me`,
        {
          headers: { 'Api-Token': token },
          timeout: TIMEOUT_MS,
          validateStatus: () => true,
        },
      );
      if (resp.status === 401 || resp.status === 403) {
        throw new CrmAuthError(this.name, `status ${resp.status}`);
      }
      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(`ActiveCampaign verifyConfig returned status ${resp.status}`);
      }
    } catch (err) {
      if (err instanceof CrmAuthError) throw err;
      throw new Error(`ActiveCampaign verifyConfig failed: ${safeErrorMessage(err)}`);
    }
  }
}
