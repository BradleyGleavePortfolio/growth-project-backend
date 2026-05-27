/**
 * GoHighLevel (LeadConnector) CRM adapter.
 *
 * Endpoint: POST https://services.leadconnectorhq.com/contacts/
 * Auth:     Bearer <api_key>  +  Version: 2021-07-28 header
 * Required config keys: api_key, locationId
 *
 * GHL upserts by phone or email when both are passed in the same payload.
 * For our case (email always present, phone optional) the create call may
 * return 201 with a fresh id OR 400 "duplicated contacts" with the
 * existing id in the response — we handle both.
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

const GHL_BASE_URL = 'https://services.leadconnectorhq.com';
const GHL_API_VERSION = '2021-07-28';
const TIMEOUT_MS = 10_000;

// GoHighLevel location IDs are stable alphanumeric strings (typically 24
// chars). Validating before path interpolation closes the path-traversal
// vector at audit #6 P0-3 (e.g. `locationId = '../oauth/...'`).
const GHL_LOCATION_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
export function isValidGhlLocationId(id: unknown): id is string {
  return typeof id === 'string' && GHL_LOCATION_ID_RE.test(id);
}

function splitName(full: string | null | undefined): { firstName: string; lastName: string } {
  if (!full) return { firstName: '', lastName: '' };
  const trimmed = full.trim();
  if (!trimmed) return { firstName: '', lastName: '' };
  const idx = trimmed.indexOf(' ');
  if (idx === -1) return { firstName: trimmed, lastName: '' };
  return { firstName: trimmed.slice(0, idx), lastName: trimmed.slice(idx + 1).trim() };
}

export class GoHighLevelAdapter implements CrmAdapter {
  readonly name = 'gohighlevel';

  private commonHeaders(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      Version: GHL_API_VERSION,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  async pushLead(
    lead: LeadInput,
    landingPage: LandingPageContext,
    config: CrmConfig,
  ): Promise<CrmPushResult> {
    const token = config.api_key;
    const locationId = config.locationId;
    if (!token) throw new CrmAuthError(this.name, 'api_key missing from config');
    if (!locationId) throw new CrmAuthError(this.name, 'locationId missing from config');
    if (!isValidGhlLocationId(locationId)) {
      throw new CrmAuthError(this.name, 'invalid locationId format');
    }
    const { firstName, lastName } = splitName(lead.name);
    const body: Record<string, unknown> = {
      locationId,
      email: lead.email,
      firstName,
      lastName,
      source: `TGP Landing: ${landingPage.headline.slice(0, 80)}`,
      tags: [`tgp-landing-${landingPage.slug}`.slice(0, 40)],
    };
    if (lead.phone) body.phone = lead.phone;
    try {
      const resp = await axios.post(`${GHL_BASE_URL}/contacts/`, body, {
        headers: this.commonHeaders(token),
        timeout: TIMEOUT_MS,
        validateStatus: () => true,
        maxRedirects: 0,
      });
      if (resp.status === 429) {
        const retryAfterSec = Number(resp.headers['retry-after']) || 60;
        throw new CrmRateLimitError(retryAfterSec * 1000, this.name);
      }
      if (resp.status === 401 || resp.status === 403) {
        throw new CrmAuthError(this.name, `status ${resp.status}`);
      }
      // GHL returns 400 + meta.contactId when the contact already exists.
      if (resp.status === 400) {
        const existingId =
          (resp.data?.meta?.contactId as string | undefined) ??
          (resp.data?.contact?.id as string | undefined);
        if (existingId) return { external_id: existingId };
      }
      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(`GoHighLevel returned status ${resp.status}`);
      }
      const id =
        (resp.data?.contact?.id as string | undefined) ??
        (resp.data?.id as string | undefined) ??
        '';
      return { external_id: id };
    } catch (err) {
      if (err instanceof CrmRateLimitError || err instanceof CrmAuthError) throw err;
      throw new Error(`GoHighLevel pushLead failed: ${safeErrorMessage(err)}`);
    }
  }

  async verifyConfig(config: CrmConfig): Promise<void> {
    const token = config.api_key;
    const locationId = config.locationId;
    if (!token) throw new CrmAuthError(this.name, 'api_key missing from config');
    if (!locationId) throw new CrmAuthError(this.name, 'locationId missing from config');
    if (!isValidGhlLocationId(locationId)) {
      throw new CrmAuthError(this.name, 'invalid locationId format');
    }
    try {
      const resp = await axios.get(
        `${GHL_BASE_URL}/locations/${locationId}`,
        {
          headers: this.commonHeaders(token),
          timeout: TIMEOUT_MS,
          validateStatus: () => true,
          maxRedirects: 0,
        },
      );
      if (resp.status === 401 || resp.status === 403) {
        throw new CrmAuthError(this.name, `status ${resp.status}`);
      }
      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(`GoHighLevel verifyConfig returned status ${resp.status}`);
      }
    } catch (err) {
      if (err instanceof CrmAuthError) throw err;
      throw new Error(`GoHighLevel verifyConfig failed: ${safeErrorMessage(err)}`);
    }
  }
}
