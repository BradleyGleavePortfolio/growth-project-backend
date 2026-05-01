# Apps Platform — SDK Spec

Status: DRAFT (docs only)
Wave: 6

## 1. Purpose

The TGP Apps SDK (`@tgp/apps-sdk`) is the typed, capability-checked client surface that app code uses to talk to the TGP API. It is the only sanctioned way for an app — running in iframe or worker — to read or mutate platform state.

This document specifies:

- Package surface and module layout.
- Authentication flow (app token issuance, refresh).
- Typed API methods (clients, programs, cohorts, retention, rewards, sub-coaches, audit, payments, messages, admin metrics).
- Hooks for retention / rewards / sub-coach data.
- Error envelope.
- Pagination contract.
- Rate-limit contract.
- Webhook signing and verification.
- iframe<->parent postMessage envelope.

## 2. Package layout

```
@tgp/apps-sdk
  /core         <- AppClient, auth, fetch wrapper, error types
  /clients      <- app.clients.*
  /programs     <- app.programs.*
  /cohorts      <- app.cohorts.*
  /retention    <- app.retention.*
  /rewards      <- app.rewards.*
  /sub-coaches  <- app.subCoaches.*
  /messages     <- app.messages.*
  /payments     <- app.payments.*
  /audit        <- app.audit.*
  /admin        <- app.admin.metrics.*
  /webhooks     <- verifyWebhookSignature, parseEvent
  /mcp          <- types only; MCP runtime in worker
  /iframe       <- frame-side helpers (postMessage envelope, parent RPC)
  /worker       <- worker-side helpers (lifecycle handlers, scheduled jobs)
  /react        <- (optional) React hooks: useClients, useProgression, etc.
```

Two distributions:
- ESM, browser-targeted, for iframe surfaces.
- Node 20+ ESM, for worker surfaces.

Both share the core types.

## 3. Authentication flow

### 3.1 Token issuance

- **iframe**: at iframe boot, parent (TGP main app) issues an `app_token` via postMessage envelope. Token is a JWT signed by TGP (RS256). Lifetime 15 minutes.
- **worker (webhook/scheduled-job)**: TGP injects `TGP_APP_TOKEN` env var per invocation. Token lifetime is the invocation wall-clock cap.
- **worker (server-action invoked from iframe)**: iframe gets a one-shot `action_token` from parent, posts to worker; worker exchanges it for a normal app_token at TGP API.

### 3.2 Token shape (illustrative)

```ts
interface AppToken {
  iss: "tgp";
  sub: string;       // install_id
  aud: "app";
  app_id: string;
  app_version: string;
  install_id: string;
  org_id: string;
  scope_root: string;       // "org:<org_id>" or narrower
  cap_set_hash: string;     // SHA-256 of canonicalized capability set
  caps: string[];           // granted capabilities
  iat: number;
  exp: number;              // <= iat + 900 (15m) for iframe; <= iat + invocation cap for worker
}
```

### 3.3 Refresh

- iframe: SDK posts `tgp.token.refresh` envelope to parent before expiry. Parent issues a new token if install is still active. SDK transparently swaps tokens; in-flight requests retry with new token if they failed with 401 token_expired.
- worker: tokens are per-invocation; no refresh.

### 3.4 Capability check at call site

Every SDK method declares the capability it needs (TS literal union). At call site, SDK runs:

```ts
function assertCap(cap: string) {
  if (!ctx.token.caps.includes(cap)) {
    throw new TgpError({ code: "capability_denied", message: `Missing ${cap}`, details: { required: cap, granted: ctx.token.caps } });
  }
}
```

This is a defense-in-depth check; the gateway enforces too.

## 4. Core types

### 4.1 Error envelope

```ts
export interface TgpErrorEnvelope {
  code: TgpErrorCode;
  message: string;
  details?: Record<string, unknown>;
  request_id?: string;
  retry_after_ms?: number;
}

export type TgpErrorCode =
  | "capability_denied"
  | "auth_invalid"
  | "auth_expired"
  | "rate_limited"
  | "quota_exhausted"
  | "not_found"
  | "validation_failed"
  | "conflict"
  | "idempotency_replay"
  | "consent_required"
  | "internal_error"
  | "service_unavailable"
  | "schema_unsupported"
  | "version_pinned_against_call";

export class TgpError extends Error {
  readonly envelope: TgpErrorEnvelope;
  constructor(envelope: TgpErrorEnvelope);
}
```

Every error returned to the SDK is an instance of `TgpError`. Network failures wrap as `service_unavailable`. JSON parse failures wrap as `internal_error`.

### 4.2 Pagination

All list endpoints use cursor pagination.

```ts
export interface Page<T> {
  items: T[];
  next_cursor: string | null;
  has_more: boolean;
  /** Total only on small lists; null when count is expensive. */
  total_count: number | null;
}

export interface PageOpts {
  cursor?: string;
  limit?: number;     // default 50, max 200
  order?: "asc" | "desc";
  order_by?: string;  // method-defined
}
```

Cursors are opaque base64 strings. Apps must not parse them.

### 4.3 Idempotency

All mutating methods take an optional `idempotency_key` (string, <= 128 chars). The gateway de-duplicates by (install_id, method, idempotency_key) for 24 hours. Replay returns the original response with `idempotency_replay: true`.

```ts
export interface MutationOpts {
  idempotency_key?: string;
}
```

### 4.4 Rate limit

The gateway emits headers on every response:

| Header | Meaning |
|---|---|
| `X-RateLimit-Limit-RPS` | sustained rps cap |
| `X-RateLimit-Remaining` | tokens remaining in current window |
| `X-RateLimit-Reset-Ms` | ms until refill |
| `X-Quota-Daily-Used` | bytes egress used today |
| `X-Quota-Daily-Limit` | daily egress cap |

SDK exposes `client.rateLimit` getter returning the latest snapshot.

`429 rate_limited` -> SDK retries with jittered exponential backoff (default 3 retries; opt-in `retries: 0`).

## 5. AppClient surface

```ts
export interface AppClientOptions {
  /** Token source. iframe and worker pass different sources. */
  tokenSource: TokenSource;

  /** Default request timeout (ms). */
  timeoutMs?: number;        // default 10_000

  /** Fetch implementation. Override for tests. */
  fetchImpl?: typeof fetch;

  /** Extra default request headers. Restricted (cannot override TGP headers). */
  headers?: Record<string, string>;
}

export class AppClient {
  constructor(opts: AppClientOptions);

  readonly clients: ClientsModule;
  readonly programs: ProgramsModule;
  readonly cohorts: CohortsModule;
  readonly retention: RetentionModule;
  readonly rewards: RewardsModule;
  readonly subCoaches: SubCoachesModule;
  readonly messages: MessagesModule;
  readonly payments: PaymentsModule;
  readonly audit: AuditModule;
  readonly admin: { metrics: AdminMetricsModule };
  readonly secrets: SecretsModule;     // worker only
  readonly events: EventsModule;       // emit custom events to coach UI
}
```

## 6. Modules

### 6.1 clients

```ts
export interface Client {
  id: string;
  display_name: string;
  email: string | null;        // redacted unless read:client.email
  phone: string | null;        // redacted unless read:client.phone
  dob: string | null;          // redacted unless read:client.dob
  status: "active" | "paused" | "churned";
  cohort_ids: string[];
  coach_id: string;
  created_at: string;
  updated_at: string;
  /** Fields stripped due to missing PII subscope. */
  _redacted?: string[];
}

export interface ClientListFilter {
  cohort_id?: string;
  coach_id?: string;
  status?: "active" | "paused" | "churned";
  search?: string;             // matches display_name only by default
}

export interface ClientsModule {
  /** Capability: read:clients */
  list(filter?: ClientListFilter, page?: PageOpts): Promise<Page<Client>>;

  /** Capability: read:clients */
  get(id: string): Promise<Client>;

  /** Capability: write:clients */
  update(id: string, patch: ClientPatch, opts?: MutationOpts): Promise<Client>;

  /** Capability: delete:clients */
  delete(id: string, opts?: MutationOpts): Promise<{ ok: true }>;
}

export interface ClientPatch {
  display_name?: string;
  status?: "active" | "paused" | "churned";
  metadata?: Record<string, unknown>;   // app-namespaced; isolated from other apps
}
```

Notes:
- `metadata` is app-namespaced; key path is `metadata.<app_id>.<key>`. Apps cannot read other apps' metadata.
- Search is `display_name` only because broader search would leak PII.

### 6.2 programs

```ts
export interface Program {
  id: string;
  title: string;
  status: "draft" | "published" | "archived";
  weeks_count: number;
  cohort_id: string | null;
  created_by_app_id: string | null;     // attribution
  created_at: string;
  updated_at: string;
}

export interface ProgramsModule {
  /** Capability: read:programs */
  list(filter?: { cohort_id?: string; status?: Program["status"] }, page?: PageOpts): Promise<Page<Program>>;

  /** Capability: read:programs */
  get(id: string): Promise<Program>;

  /** Capability: write:programs */
  create(input: ProgramCreate, opts?: MutationOpts): Promise<Program>;

  /** Capability: write:programs */
  update(id: string, patch: ProgramPatch, opts?: MutationOpts): Promise<Program>;

  /** Capability: delete:programs */
  delete(id: string, opts?: MutationOpts): Promise<{ ok: true }>;
}
```

### 6.3 cohorts

```ts
export interface Cohort {
  id: string;
  title: string;
  start_date: string;
  end_date: string | null;
  client_count: number;
  coach_id: string;
}

export interface CohortsModule {
  list(page?: PageOpts): Promise<Page<Cohort>>;
  get(id: string): Promise<Cohort>;
  create(input: CohortCreate, opts?: MutationOpts): Promise<Cohort>;
  update(id: string, patch: CohortPatch, opts?: MutationOpts): Promise<Cohort>;
}
```

### 6.4 retention

The retention engine is doctrine-sensitive (Wave 2 + Wave 10). Apps see scores and milestones, never raw event streams that would let an app build its own shame-counter.

```ts
export interface Progression {
  client_id: string;
  /** 0..100 score; product team's smoothed retention metric. */
  score: number;
  trend: "up" | "flat" | "down";
  last_event_at: string | null;
  /** Number of milestones hit, no public streak counter. */
  milestones_hit: number;
}

export interface Streak {
  client_id: string;
  /** Current quiet-streak length in days. */
  length_days: number;
  /** Longest historical quiet-streak. */
  best_length_days: number;
  /** TGP doctrine: NOT exposed publicly to clients in any UI. */
  visibility: "coach_only";
}

export interface RetentionMilestone {
  id: string;
  client_id: string;
  kind: string;
  achieved_at: string;
}

export interface RetentionModule {
  /** Capability: read:retention.progression */
  getProgression(client_id: string): Promise<Progression>;

  /** Capability: read:retention.progression */
  listProgressions(filter?: { cohort_id?: string }, page?: PageOpts): Promise<Page<Progression>>;

  /** Capability: read:retention.streaks */
  getStreak(client_id: string): Promise<Streak>;

  /** Capability: read:retention.milestones */
  listMilestones(filter?: { client_id?: string }, page?: PageOpts): Promise<Page<RetentionMilestone>>;
}
```

### 6.5 rewards

```ts
export interface Reward {
  id: string;
  client_id: string;
  kind: string;
  granted_at: string;
  granted_by_app_id: string | null;
}

export interface RewardsModule {
  /** Capability: read:rewards */
  list(filter?: { client_id?: string }, page?: PageOpts): Promise<Page<Reward>>;

  /** Capability: write:rewards */
  grant(input: { client_id: string; kind: string }, opts?: MutationOpts): Promise<Reward>;

  /** Capability: write:rewards */
  revoke(reward_id: string, opts?: MutationOpts): Promise<{ ok: true }>;
}
```

### 6.6 subCoaches

```ts
export interface SubCoach {
  id: string;
  display_name: string;
  email: string | null;
  status: "invited" | "active" | "suspended";
  parent_coach_id: string;
}

export interface SubCoachesModule {
  list(page?: PageOpts): Promise<Page<SubCoach>>;
  get(id: string): Promise<SubCoach>;
  invite(input: { email: string; display_name: string }, opts?: MutationOpts): Promise<SubCoach>;
  suspend(id: string, opts?: MutationOpts): Promise<SubCoach>;
}
```

### 6.7 messages

High-trust capability set. Sending a message on behalf of a coach requires `write:messages` AND a recent consent_token.

```ts
export interface Message {
  id: string;
  thread_id: string;
  from_user_id: string;
  body: string;
  created_at: string;
  /** Apps that sent this message are attributed. */
  sent_by_app_id: string | null;
}

export interface MessagesModule {
  /** Capability: read:messages */
  list(filter: { thread_id: string }, page?: PageOpts): Promise<Page<Message>>;

  /** Capability: write:messages + consent */
  send(input: { thread_id: string; body: string }, opts: MutationOpts & { consent_token: string }): Promise<Message>;
}
```

### 6.8 payments

Read-only (apps never move money outside their own monetization). `read:payments` exposes payment history without card data.

```ts
export interface PaymentRecord {
  id: string;
  client_id: string;
  /** Decimal(14,2) string. */
  amount: string;
  currency: string;
  status: "succeeded" | "pending" | "refunded" | "failed";
  occurred_at: string;
}

export interface PaymentsModule {
  /** Capability: read:payments */
  list(filter?: { client_id?: string }, page?: PageOpts): Promise<Page<PaymentRecord>>;
}
```

### 6.9 audit

App can read its own audit log (only). No cross-app reads.

```ts
export interface AuditEntry {
  id: string;
  install_id: string;
  app_id: string;
  action: string;
  actor_type: string;
  actor_id: string | null;
  outcome: "ok" | "denied" | "rate_limited" | "quota_exhausted" | "error";
  details: Record<string, unknown> | null;
  created_at: string;
}

export interface AuditModule {
  /** Capability: read:audit */
  list(filter?: { since?: string; action?: string }, page?: PageOpts): Promise<Page<AuditEntry>>;
}
```

### 6.10 admin.metrics (Wave 3 data-feed integration)

Apps that declare `read:admin.metrics` consume the same data-feed primitives as the admin console.

```ts
export interface CohortMetric {
  cohort_id: string;
  metric: string;
  value: number;
  capability_hash: string;     // Wave 3 cache key
  computed_at: string;
}

export interface AdminMetricsModule {
  /** Capability: read:admin.metrics */
  getCohortMetrics(input: {
    cohort_id: string;
    metrics: string[];
    /** Wave 3 scope-stack frame; defaults to install scope. */
    scope?: { coach_id?: string; cohort_id?: string };
  }): Promise<CohortMetric[]>;

  /** SSE-style subscription for live updates (Wave 3 envelope). */
  subscribeCohortMetrics(input: { cohort_id: string }): AsyncIterable<CohortMetric>;
}
```

### 6.11 secrets (worker only)

```ts
export interface SecretsModule {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<{ keys: string[] }>;
}
```

KMS-encrypted at rest. 64 KB total per install (hard cap). Secrets never leak to iframe.

### 6.12 events

Apps can emit custom events into the coach's activity feed (with capability `write:events`, subject to spam quotas).

```ts
export interface EventsModule {
  /** Capability: write:events */
  emit(input: { kind: string; subject_id?: string; payload?: Record<string, unknown> }, opts?: MutationOpts): Promise<{ event_id: string }>;
}
```

Quota: 100 events/install/min. Spam detection auto-suspends.

## 7. iframe<->parent envelope

```ts
export interface FrameMessage {
  /** Always "tgp.app.v1". */
  v: "tgp.app.v1";

  /** Random per-message id. */
  id: string;

  /** Direction. */
  dir: "in" | "out";

  /** Method. */
  method:
    | "tgp.token.issue"
    | "tgp.token.refresh"
    | "tgp.api.call"
    | "tgp.event.emit"
    | "tgp.consent.request"
    | "tgp.theme.get"
    | "tgp.locale.get"
    | "tgp.navigate"
    | "tgp.height";

  /** Method-specific payload. */
  payload: unknown;

  /** Response error (only on dir=in responses). */
  error?: TgpErrorEnvelope;
}
```

Rules:
- All messages MUST be JSON-serializable.
- Untyped or unknown-method messages are dropped silently.
- Origin checks: parent only accepts messages from the iframe's exact origin; iframe only accepts from `tgp.example`.
- `tgp.api.call` is the only way to make API calls from iframe; the parent enforces capability check at this hop in addition to the gateway, defense-in-depth.

### 7.1 React hook example

```tsx
import { useClients } from "@tgp/apps-sdk/react";

function ClientList() {
  const { data, error, isLoading, fetchMore } = useClients({ status: "active" });
  if (isLoading) return <Spinner />;
  if (error) return <ErrorBanner error={error} />;
  return (
    <>
      {data.items.map(c => <ClientRow key={c.id} client={c} />)}
      {data.has_more && <button onClick={fetchMore}>Load more</button>}
    </>
  );
}
```

Hooks provided:

| Hook | Capability | Returns |
|---|---|---|
| `useClients` | `read:clients` | `Page<Client>` with `fetchMore` |
| `useClient(id)` | `read:clients` | `Client` |
| `usePrograms` | `read:programs` | `Page<Program>` |
| `useProgression(client_id)` | `read:retention.progression` | `Progression` |
| `useCohortMetrics(cohort_id, metrics)` | `read:admin.metrics` | `CohortMetric[]` |
| `useSubCoaches` | `read:sub_coaches` | `Page<SubCoach>` |
| `useTheme` | none | `Theme` |
| `useLocale` | none | `string` |

## 8. Worker-side helpers

```ts
import { handleScheduled, handleWebhook, handleMcp, handleLifecycle } from "@tgp/apps-sdk/worker";

export default {
  scheduled: handleScheduled(async (ctx, event) => {
    const app = ctx.client;
    const clients = await app.clients.list({ status: "active" });
    // ...
  }),

  fetch: handleWebhook(async (ctx, req, event) => {
    if (event.kind === "client.created") {
      // ...
    }
    return new Response("ok");
  }),
};
```

`ctx` is `{ client: AppClient, install_id: string, app_version: string, request_id: string, logger: Logger }`.

## 9. Rate limits per app

Limits enforced at the gateway, surfaced to the SDK via headers (Section 4.4).

| Class | Sustained | Burst | Per |
|---|---|---|---|
| Read | 50 rps | 200 rps (10s window) | install |
| Write | 10 rps | 50 rps (10s window) | install |
| MCP read | 20 rps | 60 rps | install |
| MCP write | 2 rps | 10 rps | install |
| Webhook delivery (inbound) | 100/min | 1k/min burst | install |

Tier-up via paid platform tier (Day-1 plumbing only).

## 10. Webhook signing

### 10.1 Inbound (TGP -> worker)

TGP signs every webhook delivery to the app worker:

- Header `Tgp-Signature: t=<unix_ts>,v1=<hex_hmac>`.
- HMAC-SHA-256 over `<unix_ts>.<raw_body>` keyed with the install's webhook secret (provisioned at install).
- App SDK helper:

```ts
import { verifyWebhookSignature } from "@tgp/apps-sdk/webhooks";

const result = verifyWebhookSignature({
  rawBody,
  signatureHeader: req.headers.get("Tgp-Signature")!,
  secret: ctx.webhookSecret,
  toleranceSec: 300,
});
if (!result.ok) {
  return new Response("invalid signature", { status: 401 });
}
```

`toleranceSec` default 300 (5 minutes); reject older deltas to defeat replay.

### 10.2 Outbound webhooks (app -> third party)

If the app calls third-party APIs, the app is responsible for its own signing. TGP only signs the inbound channel.

### 10.3 Delivery semantics

- At-least-once delivery.
- Per-event idempotency key passed via `Tgp-Idempotency-Key` header.
- Dedup is the app's responsibility (TGP guarantees same key on retry).
- Retries: exponential, 1s, 2s, 4s, 8s, 16s, 32s, 1m, 5m, 15m, 1h, 6h, 24h. After that: dead-letter.

### 10.4 Signed event payloads

Event payload is a typed envelope:

```ts
export interface WebhookEvent<TKind extends string, TData> {
  kind: TKind;
  delivery_id: string;
  event_id: string;
  install_id: string;
  app_id: string;
  /** Timestamp of the originating event in TGP. */
  occurred_at: string;
  /** Timestamp of this delivery attempt. */
  delivered_at: string;
  /** Sequence number within (install_id, kind). Monotonic. */
  seq: number;
  data: TData;
}
```

App SDK exposes typed parsers per event:

```ts
import { parseEvent } from "@tgp/apps-sdk/webhooks";

const event = parseEvent(rawBody);
switch (event.kind) {
  case "client.created":
    // event.data: { client_id, cohort_id, coach_id, occurred_at }
    break;
  case "program.created":
    // event.data: { program_id, cohort_id, ... }
    break;
}
```

### 10.5 Replay protection

`(install_id, delivery_id)` deduped by the app SDK helper if `dedupStore` supplied (in-memory LRU + optional persistent). Default helper is in-memory only and warns about replays across worker restarts.

## 11. Failure modes (>=5)

### 11.1 Token expired mid-call

Detection: 401 with `code: auth_expired`.
Recovery: SDK refreshes token (iframe) or returns to the worker harness (worker; harness returns 503 to gateway, which retries).

### 11.2 Capability denied (gateway disagrees with token)

Detection: 403 `capability_denied`. Could happen if cap was revoked between token issue and call.
Recovery: SDK throws `TgpError`. App must surface error or fall back gracefully. Token is invalidated.

### 11.3 Rate limit hit

Detection: 429 `rate_limited`, `retry_after_ms`.
Recovery: SDK auto-retries up to 3 times with jitter. App can opt-out.

### 11.4 Quota exhausted

Detection: 429 `quota_exhausted`.
Recovery: NOT auto-retried (would loop). Surfaced as `TgpError`. After 3 in 60s, install auto-suspended.

### 11.5 Schema unsupported (manifest required platform feature missing)

Detection: 422 `schema_unsupported`. Returned when an app pinned `requires.platform_min_version` not met.
Recovery: install fails preflight. Coach told to wait for platform update.

### 11.6 Webhook signature mismatch

Detection: HMAC verify fails.
Recovery: app rejects with 401. TGP retries up to 5 times then DLQs and notifies developer.

### 11.7 Idempotency replay against different payload

Detection: TGP sees same `(install_id, method, idempotency_key)` with different payload hash.
Recovery: 409 `conflict`. App must use a fresh key.

## 12. Performance budgets (SDK slice)

| Operation | p50 | p95 |
|---|---|---|
| SDK call (read, cached) | 30 ms | 80 ms |
| SDK call (read, uncached, replica) | 80 ms | 200 ms |
| SDK call (read, primary) | 100 ms | 300 ms |
| SDK call (write) | 100 ms | 300 ms |
| Bundle size (ESM, gzipped) | 18 KB | 25 KB |
| TS check time on large project | 200 ms | 600 ms |

## 13. Test plan (SDK slice)

- **Unit**: every module method against a fake gateway; capability denial path; pagination edge cases (empty, single, last); idempotency replay; rate-limit retry logic; webhook signature verifier (positive/negative/replay).
- **Contract**: regenerate types from the OpenAPI spec; assert that fixture envelopes deserialize cleanly.
- **Integration**: SDK + real gateway in a staging sandbox install; PII redaction visible in responses; consent_token flow for write:messages.
- **E2E**: developer publishes app, install boots, app makes 100 SDK calls within 1 minute, audit log entries match.
- **Load**: 1k concurrent SDK calls/sec/install sustained; bundle size doesn't regress.

## 14. Audit (SDK slice)

Each SDK call mutating state writes one row to `AppAuditLog`. Reads are sampled at 1%; reads returning >100 rows are always logged.

## 15. Migration / backfill

No backfill. SDK is new.

## 16. Rollback

Old SDK versions are hosted at `app-cdn.tgp.example/sdk/<version>/`. Apps pin to a major; we maintain the latest two majors at any time. Deprecation runway: 12 months for a major.

## 17. Senior-engineer onboarding (SDK slice)

- [ ] Can call `app.clients.list()` from a fresh project with one import.
- [ ] Knows that `metadata` is app-namespaced and isolated.
- [ ] Knows the difference between `rate_limited` (auto-retry) and `quota_exhausted` (no auto-retry).
- [ ] Knows the iframe<->parent message envelope shape and origin rules.
- [ ] Can verify a webhook signature without copying code.
