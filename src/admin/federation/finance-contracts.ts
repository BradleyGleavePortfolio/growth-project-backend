// Typed contracts for the finance backend's admin federation surface.
//
// This file is the single shared shape between this fitness backend and the
// finance backend. The finance backend exposes (or will expose) three
// admin-only endpoints described below; the FinanceAdminClient calls them
// over HTTP and returns the typed payloads to FederationService.
//
// Identity join key: the initial release joins on lower-cased email. A
// durable shared identity (uuid emitted by an upstream account service)
// would be preferred and is documented in src/admin/federation/README.md;
// when finance starts emitting one, replace `email` with the durable id
// at the call sites in FederationService — the wire format already carries
// optional `account_id` for forward-compatibility.
//
// Endpoints:
//
//   GET  /admin/federation/clients/search?q=<term>&limit=<n>
//        Returns best-effort matches by email/name. Used by the unified
//        admin search bar. Limit clamped to 1..50.
//
//   GET  /admin/federation/clients/lookup?email=<email>
//        Single-user resolution. Returns 404 when finance has no record
//        for the email.
//
//   GET  /admin/federation/coaches/lookup?email=<email>
//        Coach-side resolution for the OWNER coach-detail screen. Returns
//        404 when finance has no coach record for the email.

export interface FinanceClientSummary {
  // Optional durable shared id. Populate when the finance backend exposes
  // a stable account id; otherwise leave undefined and rely on email.
  account_id?: string | null;
  email: string;
  name: string | null;
  // Subscription / engagement signal in finance. The shape mirrors the
  // fitness CoachSubscription mirror: status string + optional period end.
  subscription_status: string | null;
  current_period_end: string | null; // ISO8601 or null
  last_active_at: string | null; // ISO8601 or null
  // Coarse usage counts so the unified admin panel can show "this person
  // logged 12 transactions in the last 7d" without a second round-trip.
  usage_last_7d: {
    transactions: number;
    sessions: number;
  };
}

export interface FinanceCoachSummary {
  account_id?: string | null;
  email: string;
  name: string | null;
  subscription_status: string | null;
  current_period_end: string | null;
  client_count: number;
  active_client_count: number;
}

export interface FinanceSearchResponse {
  clients: FinanceClientSummary[];
}

// Outcome envelope returned by FinanceAdminClient. Three terminal states:
//
//   ok        — finance returned a 2xx with a parseable body. `data` set.
//   not_found — finance explicitly returned 404. Treated as "no record"
//               rather than an error so callers can show a clean fitness-
//               only response.
//   degraded  — anything else (timeout, 5xx, malformed body, network
//               error). `reason` describes the failure mode for the
//               operator console; `data` is null. Never replaced with
//               fake payloads.
//
// Federation never throws into the controller layer; the caller folds
// `degraded` into a `finance.status` field so the admin UI can render a
// "finance temporarily unavailable" pill instead of 500ing the whole
// admin screen.
export type FinanceCallOutcome<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'not_found' }
  | { kind: 'degraded'; reason: FinanceDegradedReason; detail: string };

export type FinanceDegradedReason =
  | 'not_configured'
  | 'auth_unconfigured'
  | 'timeout'
  | 'network_error'
  | 'http_error'
  | 'malformed_response';
