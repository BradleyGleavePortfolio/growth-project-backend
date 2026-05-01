# Apps Platform — Architecture

Status: DRAFT (docs only, no runtime)
Wave: 6
Owner: TGP platform team

## 1. Scope of this document

This document specifies the runtime architecture for third-party apps installed into a TGP coach org. It covers:

- Runtime model (iframe vs server vs hybrid).
- Capability-scoped permission model.
- Sandbox isolation guarantees.
- Resource quotas (CPU, memory, network).
- Lifecycle (install -> active -> suspend -> uninstall).
- Versioning and upgrade paths.
- Failure modes (>=5) with detection + recovery.
- State-transition tables.
- Performance budgets at 100 / 1k / 10k coach scale.
- Audit and security posture.
- Cross-cuts to manifest-spec, sdk-spec, mcp-server-spec, installation-and-billing.

This document is normative for behavior, not for code.

## 2. Definitions

- **App**: a versioned, signed, installable unit. Identified by a globally-unique `app_id` (slug) and a semver version.
- **Manifest**: the JSON document that declares the app's capabilities, surfaces, signing key, monetization terms. See `manifest-spec.md`.
- **Surface**: a rendered UI region (admin-page, storefront-block, dashboard-widget) OR a server entry-point (webhook-handler, scheduled-job, mcp-tool).
- **Install**: the materialized binding of one app version to one coach org with consented capabilities. Identified by `install_id`.
- **Sandbox**: the isolation boundary. UI surfaces run in a cross-origin iframe; server entry-points run in an isolated worker.
- **Capability**: a typed permission (e.g. `read:clients`, `write:programs`, `read:retention.progression`, `webhook:program.created`). The grant is per install, per coach, with scope-stack inheritance from Wave 3.
- **Capability hash**: cache key contribution; see Wave 3 admin data-feed RFC. Re-used here because app responses depend on capability scope.
- **App token**: a short-lived JWT issued to the install at runtime. Carries `install_id`, capability set, scope-stack root, expiry.

## 3. Runtime model — OWNER_DECISION (recommended: hybrid)

### 3.1 Options considered

#### Option A — iframe sandbox only

UI surfaces and server-side logic both run in iframe sandbox in coach's browser. Server logic uses fetch() to TGP API.

Pros: simplest. Strongest isolation from TGP backend (no third-party code in our process). No worker infra needed.
Cons: webhooks need a server. Scheduled jobs need a server. AI agents (MCP) need a server. iframe can't host these. Pushing webhook handling into "the app's website" off-platform breaks the install model.
Verdict: insufficient.

#### Option B — server-side runtime only

All app code runs in a TGP-managed server worker. UI is server-rendered components from the app, hydrated in TGP's main process.

Pros: webhooks, cron, MCP all live in one place. Single billing model for compute.
Cons: third-party JS in TGP's main process is a non-starter from a security standpoint. UI hydration into TGP DOM means XSS reach into TGP. Capability check enforcement is harder when surfaces are mixed into TGP UI.
Verdict: insufficient.

#### Option C — hybrid (RECOMMENDED)

UI surfaces run in cross-origin iframe sandbox. Server entry-points (webhook-handler, scheduled-job, mcp-tool, server-action) run in an isolated worker (Cloudflare Workers / Fly Machines / AWS Lambda — Day-1 implementation choice).

Pros: each surface gets the right primitive. iframe gives strongest UI isolation; worker gives webhook-capable, cron-capable, MCP-capable server compute. Capability checks happen at the TGP API boundary in both cases (worker calls TGP API just like iframe does), so the security model is unified.
Cons: two sets of infra. Two sets of quotas. Slightly more cognitive load for developers.
Verdict: recommended.

### 3.2 Recommendation

Hybrid. The rest of this document assumes hybrid.

### 3.3 Hybrid runtime topology

```
+------------------------------------- coach browser -------------------------------------+
|                                                                                         |
|  TGP main app (admin console)                                                           |
|    +--------- iframe (origin: app-<install_id>.app.tgp.example) ---------+              |
|    |  app UI surface (admin-page / storefront-block / widget)            |              |
|    |  loaded from app-cdn.tgp.example/<app_id>/<version>/...             |              |
|    |  postMessage <-> TGP main app (typed envelope, capability-checked)  |              |
|    +---------------------------------------------------------------------+              |
|                                                                                         |
+-------------------------+----------------------------------+----------------------------+
                          |                                  |
                          | iframe<->parent postMessage      | direct fetch to TGP API
                          | (envelope: see SDK spec)         | (SDK injects app token)
                          v                                  v
                  +--------------------------+   +--------------------------------+
                  | TGP main app server      |   | TGP API gateway                |
                  | (proxy for postMessage,  |   | (capability check, rate limit, |
                  |  capability check)       |   |  quota check, audit log)       |
                  +--------------------------+   +-----+--------------------+-----+
                                                       |                    |
                                                       | reads/writes       | issues app tokens
                                                       v                    v
                                                +-------------+    +------------------+
                                                | Postgres    |    | App token signer |
                                                +-------------+    +------------------+

+----------------------- isolated worker (Cloudflare/Fly/Lambda) -------------------------+
|                                                                                         |
|  webhook-handler ---+                                                                   |
|  scheduled-job   ---+--> all paths route through SDK -> TGP API (capability check)      |
|  mcp-tool        ---+                                                                   |
|  server-action   ---+                                                                   |
|                                                                                         |
+---------------------+-------------------------------------------------------------------+
                      |
                      | network egress quota counted here
                      v
                +-------------+
                | TGP API     |
                +-------------+
```

The unifying property: **every data access goes through the TGP API gateway, where capability and quota checks happen.** App code (iframe or worker) never touches Postgres directly.

### 3.4 Why iframe and not Web Components / shadow DOM

Web Components share the page's origin. Third-party JS in the same origin can read TGP cookies, read TGP DOM, exfiltrate session tokens. The cross-origin iframe gives:

- Same-origin policy isolation (no cookie access, no DOM access).
- CSP boundary (we set CSP on the iframe origin separately).
- postMessage as the single typed channel.
- Easy permission enforcement (window.parent calls require capability check).

### 3.5 Why worker and not "the app's website"

If we let third-party servers receive webhooks directly:

- We lose the audit boundary (we don't know what the app did with the webhook).
- We lose quota enforcement.
- We lose capability check at the call site (the developer can re-call our API with any token they fetched).
- We can't enforce signed-webhook verification on their side.

By owning the worker, every webhook handler runs in our isolation domain, every outbound fetch goes through our SDK, every capability is checked, every byte is metered.

## 4. Capability model

### 4.1 Capability shape

A capability is a string of the form `<verb>:<resource>[.<sub-resource>]`.

Verbs: `read`, `write`, `delete`, `webhook`, `mcp`.
Resources: `clients`, `programs`, `cohorts`, `retention`, `rewards`, `sub_coaches`, `audit`, `payments`, `messages`, `admin.metrics`.

Examples:
- `read:clients` — list and read client records (subject to PII subscope).
- `read:client.email` — PII subscope for client email.
- `write:programs` — create/update programs.
- `delete:programs` — delete programs (much higher-trust).
- `webhook:program.created` — receive `program.created` webhooks.
- `mcp:cohort_metrics` — MCP tool call for cohort metrics.

### 4.2 Capability declaration

The manifest declares capabilities up-front. See `manifest-spec.md` Section 4. At install time, the coach is shown the requested capability set and must consent. The coach may grant a subset (least-privilege).

### 4.3 Capability enforcement

Every TGP API endpoint that backs an app SDK call validates:

1. The app token is valid and not expired.
2. The app's install is `active` (not suspended, not uninstalled).
3. The capability required by the endpoint is present in the install's granted set.
4. The scope-stack root in the token matches the resource being accessed (org match).

If any check fails, response is `{code: "capability_denied", message, details: {required, granted}}`. HTTP 403.

### 4.4 PII subscopes (allowlist)

PII fields are gated by explicit subscopes:

- `read:client.email`
- `read:client.phone`
- `read:client.dob`
- `read:client.address`
- `read:client.payment_method` — Stripe customer ID only, never raw PAN.
- `read:client.health_metrics` — body composition, mood scores, etc.

If `read:clients` is granted but `read:client.email` is not, the response redacts `email` to `null` and includes `_redacted: ["email"]` in the row. Apps cannot reconstruct PII by joining other endpoints — every endpoint applies the subscope filter at the resolver.

### 4.5 Scope-stack inheritance from Wave 3

The install carries a scope-stack root: `org:<org_id>` is always the outermost frame. Capabilities granted at org level apply to every cohort/coach/client below. A coach may further constrain an install to a subset of cohorts (`cohort:<id>`) or sub-coaches (`coach:<id>`). The TGP API uses Wave 3's capability-hash cache key formula so that responses cache correctly per-install.

## 5. Sandbox isolation guarantees

### 5.1 iframe sandbox (UI surfaces)

- Origin: `app-<install_id>.app.tgp.example`. Per-install subdomain pinned to the install's signing key fingerprint. (Per-install, not per-app, because the same app installed into two different orgs gets two different iframes with two different tokens.)
- iframe attributes: `sandbox="allow-scripts allow-forms"`. No `allow-same-origin`. No `allow-top-navigation`. No `allow-popups-to-escape-sandbox`.
- CSP at iframe origin: `default-src 'self' app-cdn.tgp.example; script-src 'self' app-cdn.tgp.example; connect-src 'self' api.tgp.example; frame-ancestors tgp.example`.
- Cookies at iframe origin: none (we set `Set-Cookie` blocked by CSP and by config).
- Local storage: per-origin (per-install). Apps cannot share storage.
- postMessage envelope is typed (see SDK spec Section 6). Untyped messages are dropped.

### 5.2 Isolated worker (server entry-points)

Three concrete options at Day-1 implementation:

| Option | Isolation primitive | Cold start | Suitability |
|---|---|---|---|
| Cloudflare Workers (V8 isolates) | per-isolate sandbox | <50ms | preferred for webhook-handler, mcp-tool |
| Fly Machines (Firecracker VMs) | per-VM sandbox | 200-500ms | preferred for scheduled-job (longer-running) |
| AWS Lambda (Firecracker) | per-VM sandbox | 100-300ms | acceptable fallback |

Decision deferred to Day-1 architecture review. Whichever is chosen, the contract is:

- No filesystem persistence between invocations.
- No network egress except to allowlisted domains (TGP API, app's declared egress allowlist).
- No environment variables except TGP-injected ones (`TGP_APP_TOKEN`, `TGP_INSTALL_ID`, `TGP_API_BASE`).
- Hard CPU and memory caps per invocation.
- Hard wall-clock cap (default 30s, max 300s for scheduled-job).
- Outbound DNS resolution restricted (no public DNS, no `0.0.0.0`/private IP ranges).

### 5.3 Network egress allowlist

Apps declare egress in the manifest:

```json
"egress": {
  "allow": ["api.zoom.us", "api.calendly.com"]
}
```

The worker network policy denies egress not in the allowlist except `api.tgp.example` (always allowed) and `app-cdn.tgp.example` (assets). Egress is metered (bytes) and counted against quota.

### 5.4 Secret storage

Apps may need third-party API keys (Zoom OAuth token, Calendly API key, etc). These live in a per-install KV with KMS encryption at rest:

- App writes via SDK: `app.secrets.set(key, value)`.
- App reads via SDK: `app.secrets.get(key)`.
- Secrets are never sent to the iframe — only the worker.
- Secrets are wiped on uninstall (GDPR cascade).
- Secrets size cap: 64 KB per install.

## 6. Lifecycle and state machine

### 6.1 Install state machine

```
                +-----------+   coach installs    +---------+   passes preflight   +---------+
   submitted -> | reviewed  | ------------------> | pending | -------------------> | active  |
                +-----------+                     +---------+                      +---------+
                                                       |                                |
                                                       | preflight fails                | coach pauses
                                                       v                                v
                                                  +---------+                      +---------+
                                                  | install_| <-------+--+-------- |suspended|
                                                  |  failed |         |  |         +---------+
                                                  +---------+         |  |              |
                                                                      |  | resume       | quota_exhausted / health_fail
                                                                      |  |              v
                                                                      |  +-- +--------------------+
                                                                      |      | auto_suspended    |
                                                                      |      +--------------------+
                                                                      |              |
                                                       +-----------+  |              | reviewer/coach action
                                                       |uninstalled|<-+--------------+
                                                       +-----------+
```

State transitions, allowed by:

| From | To | Trigger | Authorized actor |
|---|---|---|---|
| submitted | reviewed | reviewer approves manifest | ADMIN (TGP staff) |
| reviewed | pending | coach clicks "install" | COACH or ADMIN |
| pending | active | preflight passes (capability check, signature verify, billing-method valid if paid) | system |
| pending | install_failed | preflight fails | system |
| active | suspended | coach pauses | COACH |
| active | auto_suspended | quota exhausted, health-check fails 3x in 5min, manifest signature invalidated | system |
| suspended | active | coach resumes | COACH |
| auto_suspended | active | reviewer or coach resolves the underlying cause | ADMIN or COACH |
| active / suspended / auto_suspended | uninstalled | coach uninstalls or app delisted | COACH or ADMIN |

### 6.2 Per-app state

The app itself (not an install) has its own state:

| State | Meaning |
|---|---|
| draft | dev-portal record only, no code uploaded |
| sandbox-only | code uploaded, only installable in dev sandbox orgs |
| under-review | submitted for production review |
| approved | installable into any org |
| delisted | no new installs, existing installs continue (until next breaking version) |
| banned | no installs, all existing installs auto_suspended pending uninstall |

Detail in `developer-portal-and-review.md`.

### 6.3 Versioning

- Apps are semver-versioned (`MAJOR.MINOR.PATCH`).
- An install pins to a version. Auto-upgrade is opt-in per install:
  - `auto_upgrade: "patch"` — patch bumps applied automatically.
  - `auto_upgrade: "minor"` — patch + minor bumps applied automatically.
  - `auto_upgrade: "manual"` — coach approves each upgrade.
  - Default: `patch`.
- A new MAJOR version triggers a re-consent flow if it requests new capabilities. Coach must explicitly approve the new manifest.

### 6.4 GDPR / uninstall data wipe

On `uninstalled`, within 7 days:

- All app-scoped storage (KV, secrets) is deleted.
- All audit log rows for this install older than the retention window (default 90 days) are deleted; rows within retention are pseudonymized (install_id replaced with hash).
- Webhook delivery queue entries are dropped.
- Scheduled jobs are cancelled.

The 7-day window allows for an "undo uninstall" UX. After 7 days, deletion is irreversible.

## 7. Resource quotas — OWNER_DECISION (recommendation defaults)

Recommended Day-1 defaults (all per install per coach org unless noted):

| Resource | Default cap | Burst | Tier-up path |
|---|---|---|---|
| CPU per request (worker) | 2,000 ms | 5,000 ms (1 burst per 60s) | paid tier |
| Memory peak per worker invocation | 256 MB | n/a | paid tier 512 MB |
| Network egress | 100 MB / day | 200 MB / day (1 burst) | paid tier 1 GB / day |
| Inbound API requests (SDK calls to TGP) | 50 req/s sustained | 200 req/s burst (10s window) | paid tier 200/s sustained |
| Concurrent worker invocations | 10 | n/a | paid tier 50 |
| Webhook deliveries received | 1,000 / day | 10,000 / day burst | paid tier unlimited |
| Scheduled jobs registered | 5 | n/a | paid tier 25 |
| Scheduled-job wall-clock | 30s | 300s (cron-only) | n/a |
| Manifest signing key rotations | 4 / year | n/a | n/a |
| KV storage (per install) | 64 KB total | n/a | paid tier 1 MB |
| Audit-log row inserts | tracked, not capped | n/a | n/a |

These are recommendations. OWNER picks at Day-1.

### 7.1 Quota enforcement

- TGP API gateway runs a token bucket per (install_id, resource) keyed in Redis.
- Worker runtime enforces CPU/memory at the runtime layer (Cloudflare Workers / Fly Machines per-invocation limits).
- Egress is counted at the worker network policy layer.
- KV storage is checked on write.

### 7.2 Quota-exhausted behavior

When a quota is hit:

1. SDK call returns `{code: "quota_exhausted", message, details: {resource, reset_at}}`.
2. Three quota_exhausted responses in 60s -> install transitions to `auto_suspended`.
3. Coach receives an in-app notification + email.
4. Developer receives a webhook (`install.auto_suspended`) at their dev-portal-registered URL.

## 8. Failure modes (>=5)

### 8.1 Manifest signature invalid (mid-runtime)

**Scenario.** App's signing key is rotated by the developer (legitimate or compromised) and the new public key has not propagated to TGP's KMS-backed verifier cache. App's iframe loads stale signed bundle; signature verification fails.

**Detection.** iframe-bootstrap signature verifier returns `signature_invalid`. Worker bootstrap likewise.

**Recovery.**
- Cache the public key set with TTL 5min, refresh on signature mismatch.
- If, after refresh, signature still invalid: install transitions to `auto_suspended`, coach notified, developer notified.
- App developer can request re-verification via dev portal.

### 8.2 Worker cold-start storm

**Scenario.** Bulk webhook delivery from upstream (e.g. Stripe sends 1k events) triggers 1k worker cold starts. Coach exceeds concurrency cap (10).

**Detection.** Concurrency limiter returns `429 quota_exhausted` to webhook dispatcher.

**Recovery.**
- Webhook dispatcher uses exponential backoff (1s, 2s, 4s, ... 5min cap) and a per-install delivery queue.
- After 24h of failed delivery, dispatcher gives up; webhook is dead-lettered to `app_webhook_dlq` table.
- Coach + developer notified.
- DLQ replay tool available in admin console (not built in Wave 6).

### 8.3 PII leak via misdeclared capability

**Scenario.** App declares `read:clients` but not `read:client.email`. Bug in TGP resolver leaks email into the response.

**Detection.**
- Periodic schema-mismatch check: every API resolver runs an assertion against the capability set; in non-prod, this is a hard fail.
- Audit-log replay job replays a sample of responses and verifies no PII leaked outside declared scope.
- External: bug bounty.

**Recovery.**
- Hotfix the resolver.
- Identify all installs whose responses included leaked PII (audit log query).
- Notify affected coaches and clients per GDPR breach notification rules.
- Rotate any tokens that may have been observed by the app worker (since worker logs may have captured them).

### 8.4 Install installs while billing fails

**Scenario.** App is paid (subscription). Coach clicks install, TGP attempts to charge first-month fee via Stripe, charge fails (declined card). Install would be created in `pending` and never advance.

**Detection.** Preflight charge attempt returns `payment_failed`.

**Recovery.**
- Preflight is synchronous: install does not transition to `pending` if billing preflight fails.
- Coach sees inline error: "Payment failed. Update your card on file and retry."
- No install row is created in DB (or if a row was created speculatively, it's cleaned up by a sweeper job within 5min).

### 8.5 Scheduled job loops infinitely

**Scenario.** App's scheduled job has a bug; it calls itself recursively or never returns.

**Detection.** Wall-clock cap (30s default, 300s max) trips at the worker runtime.

**Recovery.**
- Worker is killed.
- 3 wall-clock trips in 24h -> install `auto_suspended`.
- Developer notified.

### 8.6 MCP tool action without consent

**Scenario.** AI agent (Wave 7) calls an MCP tool that mutates data (e.g. `programs.create`) without explicit user consent.

**Detection.** MCP server enforces consent gates; mutating tools require a recent (5min) `consent_token` in the call envelope.

**Recovery.**
- Without consent_token, MCP server returns `{code: "consent_required", details: {tool, scope, consent_url}}`.
- Audit log entry written with `consent_missing`.
- Repeated consent_missing from same agent -> agent's session is suspended.

### 8.7 Capability hash collision (cache poisoning)

**Scenario.** Wave 3 capability-hash key collides with a hostile-crafted capability set, returning cached data from a different install.

**Detection.**
- Hash function: SHA-256 over canonicalized capability set + scope-stack root + install_id. Collision is cryptographically infeasible; this scenario is for completeness.

**Recovery.**
- If a collision is somehow constructed: invalidate the cache, switch to per-install salt, ship a hash-version bump.

### 8.8 Compromised developer signing key

**Scenario.** Developer's manifest signing key is leaked. Attacker pushes a malicious version.

**Detection.**
- Out-of-band: bug bounty, security disclosure.
- In-band: anomaly detection on app version-publish frequency, manifest diff size, capability scope expansion.

**Recovery.**
- Revoke the signing key in KMS.
- All installs of that app -> `auto_suspended`.
- Developer rotates key, signs new manifest with new key, re-submits for review.
- Affected coaches notified.

## 9. Performance budgets

### 9.1 Per-call SLOs

| Surface | p50 | p95 | p99 |
|---|---|---|---|
| iframe bootstrap (cold) | 800 ms | 1,500 ms | 2,500 ms |
| iframe bootstrap (warm) | 200 ms | 400 ms | 700 ms |
| SDK call (read, cached) | 30 ms | 80 ms | 200 ms |
| SDK call (read, uncached) | 80 ms | 200 ms | 500 ms |
| SDK call (write) | 100 ms | 300 ms | 800 ms |
| MCP tool call (read-only) | 100 ms | 250 ms | 600 ms |
| MCP tool call (mutating, with consent) | 200 ms | 500 ms | 1,200 ms |
| Webhook delivery (TGP -> worker) | 100 ms | 500 ms | 2,000 ms |
| Scheduled job dispatch latency | 1s | 5s | 15s |

### 9.2 Scale targets

| Tier | Coaches | Installs/coach | Apps installed total | Peak SDK req/s |
|---|---|---|---|---|
| 100 coach | 100 | 5 | 500 | 250 |
| 1k coach | 1,000 | 5 | 5,000 | 2,500 |
| 10k coach | 10,000 | 5 | 50,000 | 25,000 |

Read replicas: SDK reads route to read replica by default. Cache TTL: 60s for cohort metrics, 30s for client lists, 0 (no cache) for retention progression (sensitive). MCP read calls cache 30s.

### 9.3 Worker pool sizing

10k coach scale, 5 installs/coach, 10 concurrent workers/install -> worst-case 500k concurrent workers. Realistic peak: ~5k concurrent (most installs are idle). Sized for 10k peak with horizontal autoscale.

## 10. Audit and security

### 10.1 Audit log shape (illustrative — Wave 6 docs only, no migration)

```prisma
model AppAuditLog {
  id           String   @id @default(cuid())
  install_id   String
  app_id       String
  app_version  String
  actor_type   String   // "coach" | "sub_coach" | "client" | "admin" | "agent" | "system"
  actor_id     String?
  action       String   // "install" | "uninstall" | "capability_grant" | "capability_revoke" | "sdk_read" | "sdk_write" | "mcp_tool_call" | "webhook_received" | "scheduled_job_run" | "auto_suspend" | "resume"
  resource     String?  // e.g. "client:abc", "program:xyz"
  capability   String?  // capability used at this call site
  outcome      String   // "ok" | "denied" | "rate_limited" | "quota_exhausted" | "error"
  details      Json?
  consent_token String?
  ip           String?
  user_agent   String?
  created_at   DateTime @default(now())

  @@index([install_id, created_at])
  @@index([app_id, action, created_at])
  @@index([actor_id, created_at])
}
```

Retention: 90 days for sdk_read/sdk_write rows, 7 years for install/uninstall/capability_grant/capability_revoke (legal/billing).

### 10.2 What we audit

Every mutation. Every capability check that denies. Every consent prompt + decision. Every install/uninstall. Every webhook received. Every scheduled job run. Every MCP tool call.

We do not audit successful read SDK calls in full (that is too noisy at 10k coach scale). We sample 1% and we audit any read that returns >100 rows.

### 10.3 PII handling

PII never leaves the TGP API gateway boundary in plaintext unless the install has the relevant subscope. PII never goes to PostHog. PII never appears in audit log details (only resource IDs).

### 10.4 Secrets handling

App's third-party API keys (per Section 5.4): KMS-encrypted at rest, decrypted only when injected into the worker invocation, never logged, never returned to iframe.

App's manifest signing public key: stored in KMS, public key fingerprint cached at API gateway.

App token: short-lived JWT (15min), signed by TGP, includes `install_id` + `cap_set_hash` + `scope_root` + `exp`. Verified at gateway on every call. Refreshed by SDK transparently.

### 10.5 Threat model in one paragraph

We treat every app as adversarial. App code has no access to TGP DB, TGP cookies, other apps' state, other coaches' data, or PII it did not declare. Every privilege boundary is enforced at the TGP API gateway, not at the app boundary. Apps cannot re-call TGP API with stolen tokens because tokens are bound to install_id, capability hash, and scope root, all of which are checked server-side. Compromised developer signing key is detectable via abnormal version-publish patterns and recoverable via KMS revocation.

## 11. Cross-cuts

- **manifest-spec.md**: declares capabilities, surfaces, signing key.
- **sdk-spec.md**: typed surface app code uses to talk to TGP API.
- **installation-and-billing.md**: how install transitions are gated by billing, refunds.
- **developer-portal-and-review.md**: how an app gets to `approved`.
- **mcp-server-spec.md**: how AI agents talk to TGP via apps platform primitives.

## 12. Test plan (architecture slice)

- **Unit**: state-transition validator (every (from, to, trigger) tuple); quota token bucket; capability check matcher; PII redaction at resolver.
- **Integration**: install end-to-end with mock app; iframe boot + postMessage envelope; worker invocation + capability check + audit log row.
- **E2E**: full coach install flow, app exceeds quota, app auto_suspended, coach resumes, app uninstalled, GDPR wipe verified.
- **Load**: 10k coach simulation with 5 installs each, sustained 50 req/s/install, p95 SLO holds.
- **Chaos**: kill worker mid-invocation; corrupt manifest signature; force capability-hash collision (synthetic).

## 13. Migration / backfill

No backfill. New tables, opt-in feature flag. First migration creates `apps_registry`, `apps_install`, `apps_audit_log`, `apps_secret_kv`, `apps_webhook_delivery`, `apps_scheduled_job`. None of these are written here (docs only); they will be drafted in implementation PR.

## 14. Rollback

Feature flags:
- `apps.runtime.iframe.enabled`
- `apps.runtime.worker.enabled`
- `apps.install.enabled`
- `apps.mcp.enabled`
- `apps.marketplace.enabled`

Disabling all flags returns the platform to pre-Wave-6 behavior. Existing installs persist in DB but no surface loads, no webhooks dispatch, no MCP responds.

## 15. Day-1 implementation order (architecture slice)

1. Pick runtime model OWNER_DECISION (recommended: hybrid).
2. Pick worker substrate (Cloudflare Workers / Fly Machines / Lambda).
3. Stand up iframe origin + CDN for app static bundles.
4. Stand up worker invocation harness with capability-checked SDK injection.
5. Stand up token issuer (15-min JWT, KMS-signed).
6. Stand up Redis token-bucket quota counter.
7. Stand up audit-log writer.
8. Wire feature flags.
9. Cut the install state machine (no UI).
10. Wire CI: manifest validator + capability-set diff check.

## 16. Senior-engineer onboarding checklist (architecture slice)

- [ ] Can describe in 30 seconds why we picked hybrid over pure-iframe and pure-server.
- [ ] Can name the 3 places capability is enforced (gateway, SDK call site assertion, audit log replay).
- [ ] Can read the install state machine and answer: what triggers `auto_suspended`?
- [ ] Can identify which 5 quotas are hard caps vs soft caps.
- [ ] Knows the 7-day GDPR uninstall wipe window and can explain the "undo uninstall" UX rationale.
