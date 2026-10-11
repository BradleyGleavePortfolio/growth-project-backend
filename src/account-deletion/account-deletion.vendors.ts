import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  StripeConnectApiError,
  StripeConnectApiService,
} from '../connect/stripe-connect-api.service';
import { describeFailure } from '../observability/log-pii';

/**
 * Account deletion at our vendors. The privacy policy promises that a deleted
 * person is removed from analytics and that service providers delete their
 * copies, so after the database deletion commits each vendor is asked once.
 * Every step is idempotent: a person the vendor no longer has counts as done
 * (`not_found`), so a retry after a partial failure is safe.
 *
 *   posthog  persons/bulk_delete by distinct id (the user id), events too
 *   crisp    every conversation of the email, then the people profile
 *   stripe   the person's own platform customers (never a coach's connected
 *            account, never a customer of a surviving client)
 *   resend   not_applicable: transactional mail only, no contacts or audiences
 *   sentry   not_applicable: no per-person deletion; we send it no person data
 */

export const VENDORS = ['posthog', 'crisp', 'stripe', 'resend', 'sentry'] as const;
export type Vendor = (typeof VENDORS)[number];
export type VendorOutcome = 'done' | 'not_found' | 'not_configured' | 'not_applicable' | 'failed';
export type VendorOutcomes = Partial<Record<Vendor, VendorOutcome>>;

/** What the vendors still to do need to find the person. Stored only until they confirm. */
export type VendorWork = {
  vendors: Vendor[];
  email: string | null;
  stripe_customer_ids: string[];
};

const TIMEOUT_MS = 10_000;
const CRISP_MAX_PAGES = 50;

/** null on 404; throws on any other non-2xx with the status only (a body can echo the email). */
async function send(vendor: Vendor, url: string, init: RequestInit): Promise<Response | null> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw Object.assign(new Error(`${vendor} answered ${res.status}`), { status: res.status });
  }
  return res;
}

@Injectable()
export class AccountDeletionVendorsService {
  private readonly logger = new Logger(AccountDeletionVendorsService.name);

  constructor(private readonly stripe: StripeConnectApiService) {}

  /** Inside the finalization transaction, while the rows holding the customer ids still exist. */
  async collect(tx: Prisma.TransactionClient, userId: string, email: string): Promise<VendorWork> {
    const rows = [
      ...(await tx.connectCustomer.findMany({
        where: { client_user_id: userId },
        select: { stripe_customer_id: true },
      })),
      ...(await tx.coachProfile.findMany({
        where: { user_id: userId },
        select: { stripe_customer_id: true },
      })),
      ...(await tx.coachSubscription.findMany({
        where: { coach_id: userId },
        select: { stripe_customer_id: true },
      })),
      // Only purchases the person paid for: a coach's sales belong to their clients.
      ...(await tx.clientPurchase.findMany({
        where: { client_user_id: userId },
        select: { stripe_customer_id: true },
      })),
      ...(await tx.guestCheckout.findMany({
        where: { OR: [{ created_user_id: userId }, { guest_email: email }] },
        select: { stripe_customer_id: true },
      })),
    ];
    const ids = new Set(rows.map((r) => r.stripe_customer_id).filter((id): id is string => !!id));
    return { vendors: [...VENDORS], email, stripe_customer_ids: [...ids] };
  }

  /** One attempt per listed vendor; never throws. `left` is the work still to retry, or null. */
  async erase(
    userId: string,
    work: VendorWork,
  ): Promise<{ outcomes: VendorOutcomes; left: VendorWork | null }> {
    const steps: Record<Vendor, () => Promise<VendorOutcome>> = {
      posthog: () => this.posthog(userId),
      crisp: () => this.crisp(work.email),
      stripe: () => this.stripeCustomers(work.stripe_customer_ids),
      // The backend only sends transactional mail (POST /emails); it never adds
      // contacts or audiences, and Resend drops its send logs after 30 days.
      resend: async () => 'not_applicable',
      // Sentry has no per-person deletion. The backend sends it no user id,
      // email, IP or request data (allow-list in observability/sentry-config.ts).
      sentry: async () => 'not_applicable',
    };
    const outcomes: VendorOutcomes = {};
    for (const vendor of work.vendors) {
      try {
        outcomes[vendor] = await steps[vendor]();
      } catch (err) {
        outcomes[vendor] = 'failed';
        this.logger.warn(
          `account deletion: ${vendor} erasure failed user=${userId}; retrying nightly: ${describeFailure(err)}`,
        );
      }
    }
    const vendors = work.vendors.filter((v) => outcomes[v] === 'failed');
    if (vendors.length === 0) return { outcomes, left: null };
    return {
      outcomes,
      left: {
        vendors,
        email: vendors.includes('crisp') ? work.email : null,
        stripe_customer_ids: vendors.includes('stripe') ? work.stripe_customer_ids : [],
      },
    };
  }

  private async posthog(userId: string): Promise<VendorOutcome> {
    const key = process.env.POSTHOG_PERSONAL_API_KEY;
    const project = process.env.POSTHOG_PROJECT_ID;
    if (!key || !project) return 'not_configured';
    // Events are ingested at us.i.posthog.com; the private API is us.posthog.com.
    const host = (process.env.POSTHOG_HOST ?? 'https://us.i.posthog.com').replace(
      '.i.posthog.com',
      '.posthog.com',
    );
    const res = await send(
      'posthog',
      `${host}/api/projects/${encodeURIComponent(project)}/persons/bulk_delete/`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ distinct_ids: [userId], delete_events: true }),
      },
    );
    if (!res) throw new Error('posthog project not found');
    const body: { persons_found?: number; deletion_errors?: unknown[] } = await res.json();
    if (body.deletion_errors?.length) throw new Error('posthog reported deletion errors');
    return body.persons_found ? 'done' : 'not_found';
  }

  private async crisp(email: string | null): Promise<VendorOutcome> {
    const site = process.env.CRISP_WEBSITE_ID;
    const token = process.env.CRISP_API_TOKEN;
    if (!site || !token) return 'not_configured';
    if (!email) return 'not_found';
    const base = `https://api.crisp.chat/v1/website/${encodeURIComponent(site)}`;
    const people = encodeURIComponent(email);
    const headers = {
      Authorization: `Basic ${Buffer.from(token).toString('base64')}`,
      'X-Crisp-Tier': 'website',
    };
    // Conversations are stored apart from the profile: remove each, then the profile.
    const sessions: string[] = [];
    for (let page = 1; page <= CRISP_MAX_PAGES; page += 1) {
      const res = await send('crisp', `${base}/people/conversations/${people}/list/${page}`, {
        headers,
      });
      const body: { data?: string[] } = res ? await res.json() : {};
      if (!body.data?.length) break;
      sessions.push(...body.data);
    }
    for (const session of sessions) {
      const url = `${base}/conversation/${encodeURIComponent(session)}`;
      await send('crisp', url, { method: 'DELETE', headers });
    }
    const profile = await send('crisp', `${base}/people/profile/${people}`, {
      method: 'DELETE',
      headers,
    });
    return profile || sessions.length ? 'done' : 'not_found';
  }

  private async stripeCustomers(ids: string[]): Promise<VendorOutcome> {
    if (ids.length === 0) return 'not_found';
    if (!this.stripe.isConfigured()) return 'not_configured';
    let deleted = 0;
    for (const id of ids) {
      try {
        await this.stripe.deleteCustomer(id);
        deleted += 1;
      } catch (err) {
        if (!(err instanceof StripeConnectApiError && err.httpStatus === 404)) throw err;
      }
    }
    return deleted ? 'done' : 'not_found';
  }
}
