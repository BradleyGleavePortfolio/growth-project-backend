# Apps Platform — MCP Server Spec

Status: DRAFT (docs only)
Wave: 6

## 1. Purpose

The Model Context Protocol (MCP) server exposes a controlled, capability-scoped set of tools that AI agents — both first-party (TGP-built) and third-party (apps installed via this wave) — can call to query and (with explicit user consent) mutate the TGP admin data-feed (Wave 3) and platform state.

This document specifies:

- The MCP transport and authentication.
- The Day-1 tool surface.
- Capability scopes (which TGP capabilities back which MCP tools).
- Rate limits per agent, per session.
- Audit log shape for every tool call.
- Consent gates for mutating tools (no unsafe action without explicit user consent).
- Default model selection (sonar-pro per shared context).
- Failure modes.
- Cross-cuts to architecture, sdk-spec, manifest-spec.

## 2. What is the MCP server in TGP terms

We expose two endpoint flavors:

1. **Platform MCP server** (`mcp.tgp.example`): owned by TGP, exposes core platform tools (cohort metrics, coach directory, client progression, etc.). Used by:
   - First-party AI agents (Wave 7).
   - Third-party AI clients (Anthropic Claude Desktop, Cursor, etc.) that the coach explicitly authorizes.
2. **App MCP tools** (`worker.tgp.example/<install>/mcp/<tool>`): defined by individual apps in their manifest under `surface.type=mcp-tool`. Routed via the platform MCP server, which acts as the discovery + auth + audit hub.

This document covers both. Implementation Day-1 focuses on the platform MCP server.

## 3. Transport

- **Protocol**: standard MCP wire protocol over JSON-RPC 2.0 with streaming-JSON responses.
- **Transport options**:
  - HTTPS streaming endpoint at `https://mcp.tgp.example/v1/rpc`. Long-poll / chunked-transfer style for streaming tool output.
  - WebSocket at `wss://mcp.tgp.example/v1/ws`. Required for low-latency tool calls and bidirectional notifications.
- Day-1 supports HTTPS streaming. WebSocket is Day-30 follow-up.

## 4. Authentication

### 4.1 Coach-authorized session

A coach grants an MCP client (e.g. Claude Desktop) access via an OAuth-like flow:

```
Client redirects coach to: https://app.tgp.example/oauth/mcp/authorize
  ?client_id=<registered_client_id>
  &scope=read:cohort_metrics+read:coach_directory
  &state=<csrf>
   |
   v
Coach reviews scopes, approves
   |
   v
Redirect back with authorization code
   |
   v
Client exchanges code for access_token (24h) + refresh_token
   |
   v
Token used in Authorization: Bearer <access_token> on /v1/rpc
```

### 4.2 First-party agent

First-party agents (Wave 7) authenticate via service-account JWT issued by TGP IAM. The JWT carries the agent's identity, scope set, and on-behalf-of (`obo`) field that names the coach the agent is acting for. Audit log captures `obo`.

### 4.3 App MCP tool

When a coach has installed an app that declares `mcp-tool` surfaces, the platform MCP server proxies tool calls to the app worker:

- Discovery: `tools/list` includes app tools alongside platform tools, namespaced by `app:<app_id>.<tool_name>`.
- Invocation: platform MCP server authenticates the caller, checks scope, audits, then forwards to the app worker with an SDK-issued `app_token` + `consent_token` (if mutating).
- The app worker never sees the original MCP client's token; only the per-call `app_token`.

## 5. Day-1 platform tool surface

### 5.1 `query.cohort_metrics` (read)

```ts
interface QueryCohortMetricsInput {
  cohort_id: string;
  metrics: Array<
    | "active_clients"
    | "weekly_checkin_rate"
    | "progression_score_avg"
    | "milestone_hit_count"
    | "rewards_granted_count"
    | "churn_rate_28d"
  >;
  /** Wave 3 scope-stack frame; defaults to the session's scope. */
  scope?: { coach_id?: string; cohort_id?: string };
  /** Time window. Default: trailing 28 days. */
  window?: { from?: string; to?: string };
}

interface QueryCohortMetricsOutput {
  metrics: Array<{
    metric: string;
    value: number;
    capability_hash: string;     // Wave 3 cache key
    computed_at: string;
  }>;
}
```

Capability: `mcp:cohort_metrics` (consumes Wave 3 `read:admin.metrics` server-side).

Mutating: no.

### 5.2 `query.coach_directory` (read)

```ts
interface QueryCoachDirectoryInput {
  search?: string;
  org_id?: string;     // OWNER scope only
  limit?: number;
  cursor?: string;
}

interface QueryCoachDirectoryOutput {
  coaches: Array<{
    coach_id: string;
    display_name: string;
    cohort_count: number;
    client_count: number;
    is_sub_coach_of?: string;
  }>;
  next_cursor: string | null;
}
```

Capability: `mcp:coach_directory`.

Mutating: no.

### 5.3 `query.client_progression` (read)

```ts
interface QueryClientProgressionInput {
  client_id: string;
}

interface QueryClientProgressionOutput {
  client_id: string;
  progression_score: number;
  trend: "up" | "flat" | "down";
  milestones_hit: number;
  last_event_at: string | null;
}
```

Capability: `mcp:client_progression` (consumes `read:retention.progression`).

Mutating: no.

PII: this tool returns no PII fields (display_name, email, etc. are not returned). Use SDK directly with proper subscope if PII needed.

### 5.4 `query.retention_milestones` (read)

```ts
interface QueryRetentionMilestonesInput {
  client_id?: string;
  cohort_id?: string;
  since?: string;        // ISO date
  limit?: number;
  cursor?: string;
}

interface QueryRetentionMilestonesOutput {
  milestones: Array<{
    id: string;
    client_id: string;
    kind: string;
    achieved_at: string;
  }>;
  next_cursor: string | null;
}
```

Capability: `mcp:retention_milestones` (consumes `read:retention.milestones`).

Mutating: no.

### 5.5 `query.rewards_granted` (read)

```ts
interface QueryRewardsGrantedInput {
  client_id?: string;
  cohort_id?: string;
  since?: string;
  limit?: number;
  cursor?: string;
}

interface QueryRewardsGrantedOutput {
  rewards: Array<{ id: string; client_id: string; kind: string; granted_at: string }>;
  next_cursor: string | null;
}
```

Capability: `mcp:rewards.read`. Mutating: no.

### 5.6 `query.installed_apps` (read)

```ts
interface QueryInstalledAppsInput { org_id?: string; }
interface QueryInstalledAppsOutput {
  installs: Array<{ install_id: string; app_id: string; version: string; state: string; }>;
}
```

Capability: `mcp:apps.list`. Mutating: no.

### 5.7 `action.draft_message` (mutating, requires consent)

```ts
interface DraftMessageInput {
  client_id: string;
  body: string;
  consent_token: string;       // required
}

interface DraftMessageOutput {
  draft_id: string;
  /** Coach must approve in UI before send. */
  status: "draft_pending_coach_approval";
}
```

Capability: `mcp:messages.draft`.

Mutating: yes. Drafts only — the message is NOT sent until coach approves in TGP UI. The MCP tool never sends; that's by design.

### 5.8 `action.grant_reward` (mutating, requires consent)

```ts
interface GrantRewardInput {
  client_id: string;
  kind: string;
  consent_token: string;
}

interface GrantRewardOutput { reward_id: string; }
```

Capability: `mcp:rewards.grant`. Mutating: yes.

### 5.9 `action.suggest_program_revision` (read-only / writes draft)

Suggests changes to a program but writes a draft, not a published change.

```ts
interface SuggestProgramRevisionInput {
  program_id: string;
  brief: string;
  consent_token: string;       // optional; only required if writing a draft
}

interface SuggestProgramRevisionOutput {
  draft_program_id: string;
  diff_summary: string;
}
```

Capability: `mcp:programs.suggest`. Mutating: yes (writes a draft program).

### 5.10 `tools/list` and `tools/describe`

Standard MCP catalogue endpoints. Returns the union of platform tools and app tools the coach has installed AND authorized for the calling session.

## 6. Capability scopes

MCP scopes are a subset of the platform capability vocab (see `manifest-spec.md` Section 4) prefixed with `mcp:`. Mapping:

| MCP scope | Underlying TGP capabilities required |
|---|---|
| `mcp:cohort_metrics` | `read:admin.metrics` |
| `mcp:coach_directory` | `read:sub_coaches`, `read:cohorts` |
| `mcp:client_progression` | `read:retention.progression` |
| `mcp:retention_milestones` | `read:retention.milestones` |
| `mcp:rewards.read` | `read:rewards` |
| `mcp:rewards.grant` | `write:rewards` + consent |
| `mcp:messages.draft` | `write:messages` (drafts only) |
| `mcp:programs.suggest` | `write:programs` (drafts only) |
| `mcp:apps.list` | (none; metadata only, scoped to org) |

A coach grants a subset at the OAuth consent screen. The scope set is recorded on the session token. Server enforces.

## 7. Rate limits

Per-session token bucket:

| Class | Sustained | Burst |
|---|---|---|
| Read tools | 30 rps | 90 rps (10s) |
| Mutating tools (with consent) | 2 rps | 10 rps (10s) |
| `tools/list` | 5 rps | 15 rps |

Per-coach aggregate (across all sessions and agents):

| Bucket | Day cap |
|---|---|
| Read tool calls | 50,000 / day |
| Mutating tool calls | 1,000 / day |

Exceed -> 429 with `retry_after_ms`. Repeated abuse -> session suspended.

## 8. Consent gates

Mutating tools require a `consent_token` in the request. Consent_tokens are issued by TGP via:

```
POST /api/mcp/consent/request
  body: { tool, args_summary, scope, expires_in_sec? }
   |
   v
Returns: { consent_url, request_id }
   |
   v
Coach visits consent_url in TGP UI
  - sees: which tool, which app/agent, what args, what side effect
  - clicks "Allow once" or "Allow for 24h" or "Deny"
   |
   v
On allow -> consent_token issued (single-use OR scoped 24h)
  - bound to (request_id, tool, args_hash, coach_id)
  - 5min default TTL for single-use; 24h for "Allow for 24h"
```

### 8.1 Consent token shape

```ts
interface ConsentToken {
  jti: string;
  iss: "tgp";
  aud: "mcp";
  coach_id: string;
  agent_id: string;       // who can use this token
  tool: string;
  /** SHA-256 of canonicalized request args. */
  args_hash: string;
  /** Scope of consent: "single_use" or "session_24h". */
  scope: "single_use" | "session_24h";
  iat: number;
  exp: number;            // 5min for single_use, 24h for session_24h
}
```

### 8.2 Verification

At MCP server, before forwarding a mutating call:

1. Verify consent_token signature.
2. Verify `agent_id` matches the calling session.
3. Verify `tool` matches the called tool.
4. Verify `args_hash` matches the canonicalized request args (re-hash and compare).
5. Verify not expired.
6. If `scope=single_use`, mark used (Redis dedup) and reject reuse.
7. Audit-log the consent_token's jti as `consent_used`.

If any check fails: `{code: "consent_required", details: {tool, scope, consent_url}}`. Audit log entry `consent_missing`.

### 8.3 Why drafts and not sends

For high-trust mutations (messages, program publishes), MCP tools write **drafts**, not commits. The coach reviews and approves in TGP UI. This is enforced at the tool boundary: `action.draft_message` writes to a `MessageDraft` table; sending requires a separate coach action. AI cannot bypass this with consent_token alone.

This is policy, not technology. The technology supports send-via-MCP if we ever decide. We choose drafts because the doctrine here (Wave 10) prefers human-in-the-loop for client-facing communication.

### 8.4 Banned tools

We do NOT expose:
- `delete:*` capabilities via MCP.
- `write:messages` direct send (only draft).
- `write:sub_coaches.suspend` (admin only, never AI).
- Anything that moves money.

These can only be done via human UI.

## 9. Audit log

```prisma
model McpAuditLog {
  id              String   @id @default(cuid())
  session_id      String
  agent_id        String
  coach_id        String
  obo_user_id     String?  // on-behalf-of, for first-party agents
  tool            String
  args_hash       String
  outcome         String   // "ok" | "denied" | "consent_missing" | "rate_limited" | "error"
  error_code      String?
  consent_jti     String?
  duration_ms     Int
  bytes_in        Int
  bytes_out       Int
  ip              String?
  user_agent      String?
  created_at      DateTime @default(now())

  @@index([coach_id, created_at])
  @@index([agent_id, tool, created_at])
  @@index([outcome, created_at])
}
```

Retention: 365 days for non-mutating; 7 years for mutating. Mutating audits include consent_jti.

### 9.1 What we audit

Every tool call. Every consent request and decision. Every rate-limit-triggered denial. Every scope mismatch. Every replay of single-use consent_token.

### 9.2 What we never audit

`args` payload in plaintext if it contains PII. Args are SHA-256 hashed; the hash is logged. PII never to PostHog. PII never in audit details.

## 10. Default AI model: sonar-pro

Per shared context, default model is `sonar-pro` (Perplexity). This applies to:

- TGP first-party agents (Wave 7) calling MCP tools.
- App-defined `mcp-tool` workers when they themselves call out to a model.
- The "AI Program Drafter" worked example (`manifest-spec.md` Example 2) that calls `api.perplexity.ai`.

Apps may declare their own model preference. The default is sonar-pro.

### 10.1 Spend caps

Hard monthly cap per (coach, app): $50 default; configurable by coach up to $500. Cap counts inference cost (input + output token cost at sonar-pro pricing). Exceeding cap -> tool returns `{code: "quota_exhausted", details: {resource: "ai_spend"}}`.

### 10.2 Model selection override

Coach can set per-install model preference at install time (manifest-declared options). Cap and capability checks unchanged.

## 11. Failure modes (>=5)

### 11.1 Consent token replay

Detection: single-use jti seen second time.
Recovery: reject with `consent_required`. Audit log `consent_replay`. After 3 in 24h from same agent, suspend agent's session and notify coach.

### 11.2 Tool returns >100 KB output (chunked)

Detection: streaming response exceeds soft cap.
Recovery: stream is truncated at 1 MB; tail says `truncated_at: "1048576"`. Audit logs full size (counted bytes, not stored body).

### 11.3 App MCP tool worker times out

Detection: 30s wall-clock cap.
Recovery: tool returns `{code: "service_unavailable", details: {tool, retry_after_ms}}`. Caller can retry. After 3 timeouts in 60s, app install -> `auto_suspended`.

### 11.4 Coach revokes session mid-call

Detection: token revocation list updated; gateway sees revoked jti.
Recovery: in-flight request returns `auth_invalid`. Caller must re-authorize.

### 11.5 Scope creep (agent calls tool outside granted scope)

Detection: scope check fails.
Recovery: 403 `capability_denied`. Audit log. After 5 such denials in 1 hour, session suspended pending review.

### 11.6 PII in args (agent passes a client email by mistake)

Detection: optional PII detector on args (regex+ML) flags potential PII.
Recovery: in detection-mode, log and strip from audit hash; in enforce-mode (default for client-facing-arg fields), reject with `validation_failed`. Apps cannot pass raw PII through MCP.

### 11.7 Cross-org data bleed via cached capability hash

Detection: capability_hash collision (Section 4.1 of `architecture.md`); also: scope-root check at gateway.
Recovery: gateway checks scope_root on every call; cached responses keyed including `org_id` not just capability hash. Bleed is P0.

### 11.8 Spend cap blow-through

Detection: counter exceeds cap.
Recovery: tool returns `quota_exhausted`. Coach notified. Coach can raise cap up to $500.

## 12. Performance budgets

| Operation | p50 | p95 |
|---|---|---|
| `tools/list` | 50 ms | 150 ms |
| Read tool (cached) | 80 ms | 200 ms |
| Read tool (uncached, Wave 3 data-feed) | 150 ms | 400 ms |
| Mutating tool (with consent verify) | 200 ms | 500 ms |
| Consent flow round-trip (coach approval) | n/a (UX bound) | n/a |
| Audit-log write | 5 ms | 20 ms |

Cache TTL: 30s for `query.cohort_metrics`, 60s for `query.coach_directory`, 0 for `query.client_progression` (no cache; sensitive).

## 13. Test plan (MCP slice)

- **Unit**: scope check matrix; consent_token verification (positive/negative/replay); args-hash canonicalization; rate-limit token bucket.
- **Integration**: full OAuth-like flow for an MCP client; tool call -> data-feed query -> response; consent gate happy path and denial path.
- **E2E**: Claude Desktop authorizes, calls `query.cohort_metrics`, gets data; tries to call `action.grant_reward` without consent, gets `consent_required`, runs consent flow, retries, succeeds; audit log inspected.
- **Load**: 100 sessions, 30 rps each, p95 SLO holds.
- **Security**: consent_token replay attempts, scope bypass attempts, PII-in-args attempts.

## 14. Audit dashboards

Coach-visible dashboard: `/admin/integrations/mcp` shows:
- Active sessions (one per authorized client).
- Recent tool calls (last 100).
- Failed consent prompts (signals abuse).
- Spend-cap usage.

Coach can revoke any session with one click. Revocation propagates within 60s.

## 15. Cross-cuts

- `architecture.md` for runtime model and capability enforcement.
- `manifest-spec.md` for `mcp-tool` surface declarations and capability vocab.
- `sdk-spec.md` for the SDK helpers MCP tool workers call.
- Wave 3 admin data-feed RFC for cohort metrics primitives, scope-stack, and capability hash.
- Wave 7 (next wave) for first-party agent definitions and prompts.

## 16. Migration / backfill

No backfill. New surface.

## 17. Rollback

Feature flags:
- `apps.mcp.enabled` (gate everything)
- `apps.mcp.read.enabled` (allow read tools)
- `apps.mcp.write.enabled` (allow mutating tools, consent-gated)
- `apps.mcp.app_tools.enabled` (allow app-defined tools to be invoked via MCP)

Disabling flips the platform back to no-MCP. Existing OAuth grants persist but tool calls return 503.

## 18. Senior-engineer onboarding (MCP slice)

- [ ] Can call `query.cohort_metrics` from `curl` against the local MCP server with a synthetic token.
- [ ] Knows that all mutating tools write drafts, never commits.
- [ ] Knows the consent_token shape and replay protection.
- [ ] Knows the default model is `sonar-pro` and the spend cap path.
- [ ] Knows that `delete:*` and direct message sends are NEVER on MCP.
