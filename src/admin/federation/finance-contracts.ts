// Typed contracts for the finance backend's admin federation surface.
//
// These shapes mirror what tgp-finance-app PR #93 ships under
// `/api/admin/federation/*`. The fitness backend (this repo) calls those
// endpoints with a service-token bearer; the responses are deserialised
// into the types below and either folded into a unified federation payload
// or returned through the admin-console alias surface.
//
// Endpoints (relative to `FINANCE_API_BASE_URL`):
//
//   GET  /api/admin/federation/health
//        Static contract object. Used by FinanceFederationService.getHealth
//        to do a real liveness probe without burning a per-record query.
//
//   GET  /api/admin/federation/users/search?q=&limit=
//        Returns an array of user hits across both client and coach roles.
//        `limit` is clamped on the finance side to 1..100 (default 20).
//
//   GET  /api/admin/federation/clients/by-email/:email
//        Single-client finance summary. 404 maps to `not_found`.
//
//   GET  /api/admin/federation/coaches/by-email/:email
//        Single-coach finance + business summary. 404 maps to `not_found`.
//        A non-coach role returns 404 with `FEDERATION_NOT_A_COACH`.
//
//   GET  /api/admin/federation/usage/product
//        Product-wide usage split (DAU/WAU/MAU + role split + product
//        engagement counters). Used by the admin-console product-usage
//        widget.
//
// Identity join key: lower-cased email. The finance side echoes
// `identityMapping: 'email'` in the health endpoint so the console can
// surface the limitation in its UI. When a durable shared identity lands,
// we will switch to that and keep email as a fallback.

export interface FinanceHealthContract {
  ok: boolean;
  service: string; // 'tgp-finance'
  identityMapping: 'email';
  surface: 'admin-federation';
}

// One row in the finance /users/search response. The finance side returns
// both clients and coaches in a single array; `role` distinguishes them.
export interface FinanceUserSearchHit {
  id: string;
  email: string;
  name: string | null;
  role: 'client' | 'coach' | 'owner' | string;
  has_coach: boolean;
  created_at: string; // ISO8601
}

// Coach pointer that can travel inside a client summary.
export interface FinanceCoachPointer {
  id: string;
  email: string;
  name: string | null;
}

export interface FinanceClientSummary {
  id: string;
  email: string;
  name: string | null;
  role: string;
  // Optional durable shared id. Populated only when the finance backend
  // begins emitting one; keep email as the fallback join key in the meantime.
  account_id?: string | null;
  net_worth: number | null;
  asset_total: number | null;
  debt_total: number | null;
  cash_total: number | null;
  streak_days: number | null;
  last_eod_date: string | null; // ISO date or null
  wealth_velocity_score: number | null;
  activity_last_7d: {
    eod_submissions: number;
    what_if_scenarios: number;
    coach_notes: number;
  };
  coach: FinanceCoachPointer | null;
}

export interface FinanceCoachSummary {
  id: string;
  email: string;
  name: string | null;
  role: string; // 'coach' or 'owner'
  account_id?: string | null;
  invite_code: string | null;
  student_count: number;
  active_students_7d: number;
  eod_submissions_7d: number;
  coach_notes_total: number;
  program_templates_total: number;
}

export interface FinanceProductUsage {
  users: {
    total: number;
    by_role: Record<string, number>;
    onboarding_complete: number;
  };
  engagement: {
    dau: number;
    wau: number;
    mau: number;
  };
  product: {
    eod_submissions_last_7_days: number;
    what_if_scenarios_last_30_days: number;
    coach_notes_total: number;
    milestones_unlocked_total: number;
  };
}

// Outcome envelope returned by FinanceAdminClient. Three terminal states:
//
//   ok        — finance returned a 2xx with a parseable body. `data` set.
//   not_found — finance explicitly returned 404. Treated as "no record"
//               rather than an error so callers can show a clean fitness-
//               only response.
//   degraded  — anything else (timeout, 5xx, malformed body, network
//               error, unconfigured env). `reason` describes the failure
//               mode; `data` is null. Never replaced with fake payloads.
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
