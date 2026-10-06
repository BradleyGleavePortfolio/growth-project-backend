// Coach packages — coach-authored offerings clients can purchase.
//
// Contract alignment (audit PR149 R2):
//   • Backend list returns `{ packages: rows }`; we unwrap to a flat array.
//   • Backend archive is `DELETE /v1/coach/packages/:id`; we use that verb.
//   • Backend payload is snake_case; we map mobile camelCase ↔ backend
//     snake_case so screens keep the typed CoachPackage shape.
//   • Backend `CreatePackageDto` accepts: name, description, amount_cents,
//     currency, billing_type ('one_time'|'recurring'), billing_interval
//     ('week'|'month'|'year'), billing_interval_count, is_active. We map
//     mobile UI values ('monthly','quarterly','yearly') to backend enums.
//   • Backend `UpdatePackageDto` accepts only: name, description,
//     amount_cents, currency, is_active. trial_days/features are TODO.
//   • Backend checkout is `POST /v1/checkout/sessions` with `{ package_id,
//     success_url, cancel_url }`. URLs must use growthproject://,
//     com.growthproject.app://, or https:// prefixes.
//
// Every mutation sends a client-generated UUID `Idempotency-Key` header so
// retries/double-taps don't create duplicate rows or duplicate Checkout
// sessions (R19). The key is generated via the canonical generateIdempotencyKey()
// helper (src/utils/idempotency.ts) which uses crypto.getRandomValues backed
// by the react-native-get-random-values polyfill — cryptographically secure
// on a payments surface, with no Math.random fallback.

import api from '../services/api';
import { isValidPackageShareToken } from '../utils/packageShare';
import { generateIdempotencyKey } from '../utils/idempotency';

export type PackageBillingInterval = 'one_time' | 'monthly' | 'quarterly' | 'yearly';

export type PackageStatus = 'draft' | 'active' | 'archived';

// Backend deep-link prefixes allowed for checkout redirects: the backend
// allow-list (growth-project-backend checkout.controller.ts:30-38) accepts
// only `growthproject://`, `com.growthproject.app://`, and `https://` — it
// REJECTS `tgp://`. The redirect PATH must also match the in-app return
// handler: BrandedCheckoutWebViewScreen.parseReturnDeepLink() and the
// RootNavigator deep-link config both intercept `<scheme>://checkout/success`
// (with the `session_id` query param) and `<scheme>://checkout/cancel`.
//
// The previous value used the `/return` path, which NEVER matched the
// `/success` path the webview/deep-link parser expects, so a completed
// Stripe payment was never routed to CheckoutReturn (P0). We now mint the
// backend-accepted `com.growthproject.app://checkout/success` (with Stripe's
// `{CHECKOUT_SESSION_ID}` placeholder so the confirm step can re-verify the
// session) and `.../checkout/cancel`. Callers MUST pass the matching
// `returnScheme` ('com.growthproject.app') to BrandedCheckoutWebView.
export const PACKAGE_CHECKOUT_RETURN_SCHEME = 'com.growthproject.app';
export const PACKAGE_CHECKOUT_SUCCESS_URL =
  'com.growthproject.app://checkout/success?session_id={CHECKOUT_SESSION_ID}';
export const PACKAGE_CHECKOUT_CANCEL_URL = 'com.growthproject.app://checkout/cancel';

export interface CoachPackage {
  id: string;
  coachUserId: string;
  title: string;
  description: string | null;
  priceCents: number;
  currency: string; // ISO-4217 lower-case e.g. 'usd'
  billingInterval: PackageBillingInterval;
  intervalCount: number;
  trialDays: number | null;
  features: string[];
  status: PackageStatus;
  shareToken: string | null;
  subscriberCount: number;
  monthlyRevenueCents: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface PackageCreateInput {
  title: string;
  description?: string | null;
  priceCents: number;
  currency?: string;
  billingInterval: PackageBillingInterval;
  intervalCount?: number;
  trialDays?: number | null;
  features?: string[];
}

export type PackageUpdateInput = Partial<PackageCreateInput> & {
  status?: PackageStatus;
};

export interface PackageSubscriber {
  id: string;
  userId: string;
  name: string;
  email: string;
  startedAt: string;
  status: 'active' | 'past_due' | 'canceled' | 'trialing';
  nextRenewalAt: string | null;
  totalPaidCents: number;
}

export interface PackageSubscribersResponse {
  packageId: string;
  subscribers: PackageSubscriber[];
  totalActive: number;
  monthlyRecurringRevenueCents: number;
}

// Backend `GET /v1/coach/payments/earnings` returns the raw split-ledger view:
//   {
//     summary: { posted_cents, pending_cents, reversed_cents },
//     entries: SplitLedgerEntry[]
//   }
// The mobile screen consumes a normalised `CoachEarningsSummary` derived from
// that shape — see `adaptEarnings()`. Fields the backend does not yet expose
// (per-package breakdown, next-payout ETA, last-payout date/amount) are left
// null so the UI degrades honestly instead of inventing numbers.
export interface BackendEarningsResponse {
  summary: {
    posted_cents: number;
    pending_cents: number;
    reversed_cents: number;
  };
  entries: Array<{
    id: string;
    purchase_id: string;
    kind: string;
    payee_user_id: string | null;
    amount_cents: number;
    currency: string;
    status: string;
    reversed_cents: number;
    created_at?: string | null;
    posted_at?: string | null;
  }>;
}

export interface CoachEarningsSummary {
  currency: string;
  pendingPayoutCents: number;
  lifetimeNetCents: number;
  monthToDateNetCents: number;
  lastPayoutAt: string | null;
  lastPayoutAmountCents: number | null;
  nextPayoutEta: string | null;
  perPackage: Array<{
    packageId: string;
    title: string;
    monthToDateGrossCents: number;
    activeSubscribers: number;
  }>;
}

export function adaptEarnings(raw: BackendEarningsResponse): CoachEarningsSummary {
  const currency =
    (raw.entries.find((e) => e.currency)?.currency || 'usd').toLowerCase();

  // Month-to-date net = posted (minus reversed) for entries whose posted_at
  // (or created_at) falls in the current calendar month. Net for an entry
  // is amount_cents - reversed_cents when status === 'posted'.
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  let monthToDateNet = 0;
  for (const e of raw.entries) {
    if (e.status !== 'posted') continue;
    const ts = e.posted_at ?? e.created_at;
    if (!ts) continue;
    const t = new Date(ts).getTime();
    if (isNaN(t) || t < monthStart) continue;
    monthToDateNet += e.amount_cents - (e.reversed_cents ?? 0);
  }

  return {
    currency,
    pendingPayoutCents: raw.summary.pending_cents ?? 0,
    // Lifetime net = posted - reversed. The summary already excludes
    // reversed via posted_cents, but we subtract `reversed_cents` to keep
    // the screen's "net" framing honest if backend semantics drift.
    lifetimeNetCents:
      (raw.summary.posted_cents ?? 0) - (raw.summary.reversed_cents ?? 0),
    monthToDateNetCents: monthToDateNet,
    // Backend does not (yet) return payout-cadence metadata. Null tells the
    // UI to hide those rows rather than render fake values.
    lastPayoutAt: null,
    lastPayoutAmountCents: null,
    nextPayoutEta: null,
    perPackage: [],
  };
}

export interface PublicPackageView {
  id: string;
  title: string;
  description: string | null;
  priceCents: number;
  currency: string;
  billingInterval: PackageBillingInterval;
  intervalCount: number;
  trialDays: number | null;
  features: string[];
  coach: {
    // Backend public payload (storefront.types.ts PublicPackageData) does NOT
    // expose the coach user id — the storefront is anonymous and checkout is
    // keyed off the resolved package id + share token. Mobile must NOT invent
    // an id (IDOR is backend-owned), so this is null when absent.
    id: string | null;
    displayName: string;
    avatarUrl: string | null;
    bio: string | null;
    /** Coach is fully Stripe-Connect onboarded (KYC + payouts proven). */
    verified: boolean;
  };
  /** Stripe publishable key for the coach's connected account (web checkout). */
  stripePublishableKey: string | null;
}

// Backend `GET /v1/packages/public/join/:token` payload
// (growth-project-backend storefront.types.ts `PublicPackageData`). snake_case;
// `billing_cycle` uses 'annual' (not 'yearly') and there is NO interval_count
// or coach.id field. We adapt this to the camelCase `PublicPackageView` model
// here so screens never see the raw backend shape.
interface BackendPublicPackage {
  package_id?: string;
  package_name?: string;
  description?: string | null;
  price_cents?: number;
  currency?: string;
  billing_cycle?: 'monthly' | 'quarterly' | 'annual' | 'one_time';
  trial_days?: number | null;
  features?: string[];
  coach?: {
    display_name?: string;
    bio?: string | null;
    avatar_url?: string | null;
    verified?: boolean;
  };
  stripe_publishable_key?: string | null;
  share_link_enabled?: boolean;
}

function billingCycleToInterval(
  cycle: BackendPublicPackage['billing_cycle'],
): PackageBillingInterval {
  // Backend BillingCycle ('annual') → mobile PackageBillingInterval ('yearly').
  if (cycle === 'one_time') return 'one_time';
  if (cycle === 'quarterly') return 'quarterly';
  if (cycle === 'annual') return 'yearly';
  return 'monthly';
}

/**
 * Adapt the backend public-storefront payload (snake_case `PublicPackageData`)
 * into the camelCase `PublicPackageView` the client screens consume.
 *
 * Quarterly maps to intervalCount 3 (months); everything else is count 1 so
 * `intervalCopy()` renders "per month/year" rather than "every N months".
 */
export function adaptPublicPackage(raw: BackendPublicPackage): PublicPackageView {
  const interval = billingCycleToInterval(raw.billing_cycle);
  return {
    id: raw.package_id ?? '',
    title: raw.package_name ?? '',
    description: raw.description ?? null,
    priceCents: raw.price_cents ?? 0,
    currency: (raw.currency ?? 'usd').toLowerCase(),
    billingInterval: interval,
    intervalCount: interval === 'quarterly' ? 3 : 1,
    trialDays: raw.trial_days ?? null,
    features: Array.isArray(raw.features) ? raw.features : [],
    coach: {
      id: null,
      displayName: raw.coach?.display_name?.trim() || 'Your Coach',
      avatarUrl: raw.coach?.avatar_url ?? null,
      bio: raw.coach?.bio ?? null,
      verified: raw.coach?.verified === true,
    },
    stripePublishableKey: raw.stripe_publishable_key ?? null,
  };
}

export interface CheckoutSessionResponse {
  url?: string;
  sessionId?: string;
  paymentIntentClientSecret?: string;
  setupIntentClientSecret?: string;
  ephemeralKey?: string;
  customerId?: string;
  publishableKey?: string;
}

// ─── helpers ────────────────────────────────────────────────────────────────

export function idemHeaders(key?: string): { headers: { 'Idempotency-Key': string } } {
  return { headers: { 'Idempotency-Key': key ?? generateIdempotencyKey() } };
}

const BILLING_TYPE_FOR_INTERVAL: Record<PackageBillingInterval, 'one_time' | 'recurring'> = {
  one_time: 'one_time',
  monthly: 'recurring',
  quarterly: 'recurring',
  yearly: 'recurring',
};

// Mobile UI billing interval → backend enum ('week' | 'month' | 'year').
// Backend rejects 'monthly' / 'quarterly' / 'yearly' (whitelist validator).
function toBackendIntervalFields(
  interval: PackageBillingInterval,
  intervalCountInput?: number,
): { billing_interval?: 'week' | 'month' | 'year'; billing_interval_count?: number } {
  if (interval === 'one_time') {
    return {};
  }
  if (interval === 'monthly') {
    return { billing_interval: 'month', billing_interval_count: intervalCountInput ?? 1 };
  }
  if (interval === 'quarterly') {
    return { billing_interval: 'month', billing_interval_count: (intervalCountInput ?? 1) * 3 };
  }
  if (interval === 'yearly') {
    return { billing_interval: 'year', billing_interval_count: intervalCountInput ?? 1 };
  }
  return {};
}

interface BackendPackageRow {
  id?: string;
  coach_user_id?: string;
  name?: string;
  title?: string;
  description?: string | null;
  amount_cents?: number;
  price_cents?: number;
  currency?: string;
  billing_type?: 'one_time' | 'recurring';
  billing_interval?: 'week' | 'month' | 'year' | PackageBillingInterval | 'quarter';
  billing_interval_count?: number;
  interval_count?: number;
  trial_days?: number | null;
  features?: string[];
  status?: PackageStatus;
  is_active?: boolean;
  share_token?: string | null;
  subscriber_count?: number;
  monthly_revenue_cents?: number;
  created_at?: string;
  updated_at?: string;
  archived_at?: string | null;
}

function fromBackendInterval(
  raw: BackendPackageRow['billing_interval'],
  count: number,
  billingType: BackendPackageRow['billing_type'],
): PackageBillingInterval {
  if (billingType === 'one_time') return 'one_time';
  if (raw === 'week') return 'monthly';
  if (raw === 'month') {
    if (count >= 3 && count < 12) return 'quarterly';
    return 'monthly';
  }
  if (raw === 'year') return 'yearly';
  if (raw === 'monthly' || raw === 'quarterly' || raw === 'yearly' || raw === 'one_time') {
    return raw;
  }
  return 'monthly';
}

function fromBackend(row: BackendPackageRow): CoachPackage {
  const count = row.billing_interval_count ?? row.interval_count ?? 1;
  const interval = fromBackendInterval(row.billing_interval, count, row.billing_type);
  const status: PackageStatus =
    row.status ?? (row.is_active === false ? 'archived' : 'active');
  return {
    id: row.id ?? '',
    coachUserId: row.coach_user_id ?? '',
    title: row.name ?? row.title ?? '',
    description: row.description ?? null,
    priceCents: row.amount_cents ?? row.price_cents ?? 0,
    currency: row.currency ?? 'usd',
    billingInterval: interval,
    intervalCount: count,
    trialDays: row.trial_days ?? null,
    features: Array.isArray(row.features) ? row.features : [],
    status,
    shareToken: row.share_token ?? null,
    subscriberCount: row.subscriber_count ?? 0,
    monthlyRevenueCents: row.monthly_revenue_cents ?? 0,
    createdAt: row.created_at ?? '',
    updatedAt: row.updated_at ?? '',
    archivedAt: row.archived_at ?? null,
  };
}

interface BackendCreateBody {
  name: string;
  description?: string | null;
  amount_cents: number;
  currency?: string;
  billing_type: 'one_time' | 'recurring';
  billing_interval?: 'week' | 'month' | 'year';
  billing_interval_count?: number;
  is_active?: boolean;
  // TODO(backend): trial_days and features are not yet on the backend
  // CreatePackageDto. Once added, expand the body. Mobile keeps the UI
  // fields in `PackageCreateInput` so we don't lose them.
}

function toBackendCreate(input: PackageCreateInput): BackendCreateBody {
  const intervalFields = toBackendIntervalFields(input.billingInterval, input.intervalCount);
  const body: BackendCreateBody = {
    name: input.title,
    description: input.description ?? null,
    amount_cents: input.priceCents,
    billing_type: BILLING_TYPE_FOR_INTERVAL[input.billingInterval],
  };
  if (input.currency !== undefined) body.currency = input.currency;
  if (intervalFields.billing_interval) body.billing_interval = intervalFields.billing_interval;
  if (intervalFields.billing_interval_count != null) {
    body.billing_interval_count = intervalFields.billing_interval_count;
  }
  // TODO(backend): trial_days, features rejected by whitelist DTO. Omit until added.
  return body;
}

interface BackendUpdateBody {
  name?: string;
  description?: string | null;
  amount_cents?: number;
  currency?: string;
  is_active?: boolean;
  // TODO(backend): UpdatePackageDto does not accept billing_type,
  // billing_interval, billing_interval_count, trial_days, or features.
}

function toBackendUpdate(input: PackageUpdateInput): BackendUpdateBody {
  const out: BackendUpdateBody = {};
  if (input.title !== undefined) out.name = input.title;
  if (input.description !== undefined) out.description = input.description;
  if (input.priceCents !== undefined) out.amount_cents = input.priceCents;
  if (input.currency !== undefined) out.currency = input.currency;
  if (input.status !== undefined) out.is_active = input.status === 'active';
  return out;
}

// ─── coach API ──────────────────────────────────────────────────────────────

export const coachPackagesApi = {
  list: async () => {
    const res = await api.get<{ packages?: BackendPackageRow[] } | BackendPackageRow[]>(
      '/v1/coach/packages',
    );
    const rows = Array.isArray(res.data)
      ? res.data
      : Array.isArray(res.data?.packages)
      ? (res.data!.packages as BackendPackageRow[])
      : [];
    return { ...res, data: rows.map(fromBackend) };
  },

  // TODO(backend): `GET /v1/coach/packages/:id` not yet deployed.
  // CoachPackageEditScreen passes the list row through nav params instead.
  get: async (id: string) => {
    const res = await api.get<BackendPackageRow>(
      `/v1/coach/packages/${encodeURIComponent(id)}`,
    );
    return { ...res, data: fromBackend(res.data) };
  },

  create: async (input: PackageCreateInput, idempotencyKey?: string) => {
    const res = await api.post<BackendPackageRow>(
      '/v1/coach/packages',
      toBackendCreate(input),
      idemHeaders(idempotencyKey),
    );
    return { ...res, data: fromBackend(res.data) };
  },

  update: async (
    id: string,
    input: PackageUpdateInput,
    idempotencyKey?: string,
  ) => {
    const res = await api.patch<BackendPackageRow>(
      `/v1/coach/packages/${encodeURIComponent(id)}`,
      toBackendUpdate(input),
      idemHeaders(idempotencyKey),
    );
    return { ...res, data: fromBackend(res.data) };
  },

  archive: async (id: string, idempotencyKey?: string) => {
    const res = await api.delete<BackendPackageRow | { ok?: true }>(
      `/v1/coach/packages/${encodeURIComponent(id)}`,
      idemHeaders(idempotencyKey),
    );
    const body = res.data as BackendPackageRow | { ok?: true } | undefined;
    const row: BackendPackageRow =
      body && typeof body === 'object' && 'id' in (body as BackendPackageRow)
        ? (body as BackendPackageRow)
        : { id, is_active: false, status: 'archived' };
    return { ...res, data: fromBackend(row) };
  },

  // TODO(backend): `GET /v1/coach/packages/:id/subscribers` not yet deployed.
  // 404 is surfaced to the caller — we do NOT convert to an empty list so
  // a missing endpoint doesn't masquerade as "0 subscribers".
  subscribers: (id: string) =>
    api.get<PackageSubscribersResponse>(
      `/v1/coach/packages/${encodeURIComponent(id)}/subscribers`,
    ),

  // Backend route: `GET /v1/coach/payments/earnings`.
  // Returns `{ summary: { posted_cents, pending_cents, reversed_cents },
  // entries: SplitLedgerEntry[] }`. We adapt to the mobile `CoachEarningsSummary`
  // shape here so the screen does not have to know about the raw ledger.
  earnings: async () => {
    const res = await api.get<BackendEarningsResponse>(
      '/v1/coach/payments/earnings',
    );
    return { ...res, data: adaptEarnings(res.data) };
  },
};

// ─── public / client-facing API ─────────────────────────────────────────────

export const publicPackagesApi = {
  // Backend route is `GET /v1/packages/public/join/:token`
  // (storefront-public.controller.ts: @Controller('v1/packages/public')
  // + @Get('join/:token')). It returns the snake_case `PublicPackageData`
  // payload, which we adapt into the camelCase `PublicPackageView` before any
  // consumer sees it. The earlier `/v1/packages/:shareToken` route was a TODO
  // that was never deployed.
  getByShareToken: async (shareToken: string) => {
    if (!isValidPackageShareToken(shareToken)) {
      return Promise.reject(new Error('INVALID_SHARE_TOKEN'));
    }
    const res = await api.get<BackendPublicPackage>(
      `/v1/packages/public/join/${encodeURIComponent(shareToken)}`,
    );
    return { ...res, data: adaptPublicPackage(res.data) };
  },

  // Backend `POST /v1/checkout/sessions` requires:
  //   { package_id: <uuid>, success_url, cancel_url }
  // URLs must start with growthproject:// | com.growthproject.app:// | https://
  createCheckoutSession: (
    packageId: string,
    body: { successUrl?: string; cancelUrl?: string } = {},
    idempotencyKey?: string,
  ) => {
    if (typeof packageId !== 'string' || packageId.length === 0) {
      return Promise.reject(new Error('INVALID_PACKAGE_ID'));
    }
    const successUrl = body.successUrl ?? PACKAGE_CHECKOUT_SUCCESS_URL;
    const cancelUrl = body.cancelUrl ?? PACKAGE_CHECKOUT_CANCEL_URL;
    return api.post<CheckoutSessionResponse>(
      '/v1/checkout/sessions',
      {
        package_id: packageId,
        success_url: successUrl,
        cancel_url: cancelUrl,
      },
      idemHeaders(idempotencyKey),
    );
  },
};
