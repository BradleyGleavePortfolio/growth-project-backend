/**
 * HubSpot CRM adapter.
 *
 * Endpoint: POST https://api.hubapi.com/crm/v3/objects/contacts
 * Auth:     Bearer <access_token>  (private app token; OAuth refresh is
 *           out of scope for v1 — coaches paste a private-app token)
 * Idempotency: HubSpot dedupes by email server-side, so a retry after a
 *              partial network failure does not create duplicates.  We
 *              return the contact id from the response.
 *
 * Field mapping (TGP → HubSpot):
 *   name  → firstname / lastname (split on first whitespace)
 *   email → email
 *   phone → phone
 *   tgp_landing_page_id  custom property (must be created by coach in HS)
 *   hs_analytics_source_data_1  carries the page headline as a free-form
 *                                source-text hint so HubSpot reports
 *                                attribute the lead to "TGP / <page>".
 */

import axios, { AxiosError } from 'axios';
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

const HUBSPOT_BASE_URL = 'https://api.hubapi.com';
const TIMEOUT_MS = 10_000;

function splitName(full: string | null | undefined): { firstname: string; lastname: string } {
  if (!full) return { firstname: '', lastname: '' };
  const trimmed = full.trim();
  if (!trimmed) return { firstname: '', lastname: '' };
  const idx = trimmed.indexOf(' ');
  if (idx === -1) return { firstname: trimmed, lastname: '' };
  return {
    firstname: trimmed.slice(0, idx),
    lastname: trimmed.slice(idx + 1).trim(),
  };
}

export class HubSpotAdapter implements CrmAdapter {
  readonly name = 'hubspot';

  async pushLead(
    lead: LeadInput,
    landingPage: LandingPageContext,
    config: CrmConfig,
  ): Promise<CrmPushResult> {
    const token = config.access_token;
    if (!token) {
      throw new CrmAuthError(this.name, 'access_token missing from config');
    }
    const { firstname, lastname } = splitName(lead.name);
    const body = {
      properties: {
        email: lead.email,
        firstname,
        lastname,
        phone: lead.phone ?? '',
        tgp_landing_page_id: landingPage.id,
        hs_analytics_source_data_1: landingPage.headline.slice(0, 80),
      },
    };
    try {
      const resp = await axios.post(
        `${HUBSPOT_BASE_URL}/crm/v3/objects/contacts`,
        body,
        {
          headers: {
            Authorization: `Bearer ${token}`,
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
      // 409 = contact already exists.  HubSpot includes the existing
      // contact id in the error body — we extract it and treat as success.
      if (resp.status === 409) {
        const existingId =
          (resp.data?.message as string | undefined)?.match(/Existing ID: (\d+)/)?.[1] ??
          (resp.data?.errors?.[0]?.context?.ids?.[0] as string | undefined);
        if (existingId) return { external_id: existingId };
        // Fallback — HubSpot did dedupe but we couldn't extract the id.
        return { external_id: '' };
      }
      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(`HubSpot returned status ${resp.status}`);
      }
      const id = (resp.data?.id as string | undefined) ?? '';
      return { external_id: id };
    } catch (err) {
      if (err instanceof CrmRateLimitError || err instanceof CrmAuthError) throw err;
      const msg = safeErrorMessage(err);
      throw new Error(`HubSpot pushLead failed: ${msg}`);
    }
  }

  async verifyConfig(config: CrmConfig): Promise<void> {
    const token = config.access_token;
    if (!token) {
      throw new CrmAuthError(this.name, 'access_token missing from config');
    }
    try {
      const resp = await axios.get(
        `${HUBSPOT_BASE_URL}/crm/v3/objects/contacts?limit=1`,
        {
          headers: { Authorization: `Bearer ${token}` },
          timeout: TIMEOUT_MS,
          validateStatus: () => true,
        },
      );
      if (resp.status === 401 || resp.status === 403) {
        throw new CrmAuthError(this.name, `status ${resp.status}`);
      }
      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(`HubSpot verifyConfig returned status ${resp.status}`);
      }
    } catch (err) {
      if (err instanceof CrmAuthError) throw err;
      if (err instanceof AxiosError && err.code === 'ECONNABORTED') {
        throw new Error('HubSpot verifyConfig timed out');
      }
      throw new Error(`HubSpot verifyConfig failed: ${safeErrorMessage(err)}`);
    }
  }
}
