# 06 — Observability & incident response

> **Last reviewed:** 2026-04-30. Docs-only. No runtime change.

## WHY

When something breaks in production, three questions matter:

1. **What broke?** (logs, traces)
2. **What's the user impact?** (metrics, error rates)
3. **Who's responsible for fixing it?** (severity, oncall)

Today we have:

- **Sentry** server-side error reporting (DSN required in prod;
  sourcemaps uploaded on every Fly deploy — PR #95).
- **PostHog** product analytics (server-side, no-ops without
  key).
- **OWNER metrics** counter at `/api/admin/metrics`
  (`docs/metrics.md`).
- **Health probes** — readiness probe lives at `/health` (PR
  #92).
- **Throttler** with Redis-backed shared state (PR #93).
- **Audit log** for OWNER-side actions.

What we don't have:

- A documented **severity taxonomy** (P0/P1/P2/P3) tied to
  Sentry alerting and to oncall handoff.
- A documented **incident-response template** (what to do in
  the first 15 minutes; who to page; how to communicate).
- A documented **postmortem template**.
- A documented **trace** strategy. Sentry has trace support; we
  haven't enabled it. With AI Program Builder (async jobs) and
  Team Mode (more cross-row reads), tracing becomes
  near-mandatory.
- A documented log-volume budget. Without one, AI Program
  Builder's per-token logs would blow our Sentry quota.

**Cross-feature impact:**

| Feature | Why this lane carries it |
|---|---|
| Team Mode | Cross-team read paths add new failure modes (wrong tenant returned). Need traces to diagnose. |
| AI Program Builder | Async jobs (BullMQ on Redis). Need a job-level trace. Per-prompt cost is a metric. |
| Check-ins v2 | New backfill increases write volume. Need a per-table write-rate metric. |
| Public profiles | Public surface; we want a per-page view metric and an XSS-error alert path. |
| Templates marketplace | Stripe Connect transfer failure is a new alert class. |
| Revenue dashboards | The dashboards themselves *consume* analytics; lane #10 covers that side. This lane covers their failure modes. |

## WHEN

Settle this brief **before** PR #117 ships its first runtime
PR — async jobs are the highest-pain target for observability,
and we don't want to debug them after the fact.

## WHERE

- `src/instrument.ts` — Sentry init.
- `src/health/` — readiness probe.
- `docs/deploy-runbook.md` — the deploy procedure today
  references Sentry and PostHog; extend with the incident
  procedure.
- `docs/metrics.md` — server-side metrics doc; extend with the
  taxonomy.
- `docs/incident-response.md` — new doc.
- `docs/postmortem-template.md` — new doc.

## WHO

- **Owner:** OWNER (operator). Backend lead consults.
- **Reviewers:** founder (for severity-to-paging mapping;
  founder is the one being paged today).
- **On the hook in production:** OWNER. There is no separate
  oncall rotation today; OWNER is oncall.

## WHAT

### What already exists

- Sentry with sourcemap upload (PR #95, PR #99).
- PostHog server-side analytics module.
- OWNER metrics endpoint `/api/admin/metrics`
  (`docs/metrics.md`).
- Readiness probe at `/health` (PR #92).
- Shutdown hooks (PR #92).
- Throttler with Redis backend.
- AuditLog for state-changing actions.

### What is missing

1. **Severity taxonomy.** Proposed:
   | Severity | Definition | Response |
   |---|---|---|
   | **P0** | Cross-tenant data leak; production down; payment failures spiking; auth broken. | Page immediately. Investigation + customer comms within 1h. |
   | **P1** | Single-tenant outage; one feature down for ≥5% of traffic; Stripe webhook receiver failing. | Investigate within 4h. Communicate within 24h. |
   | **P2** | Single-feature degradation; AI fallback active for ≥1h; non-blocking error class. | Triage same day. |
   | **P3** | Logs / metrics anomaly; degraded smoke test; non-customer-impacting. | Triage during the week. |
2. **Incident-response template.**
   - First 5 min: confirm impact (synthetic check via
     `npm run smoke:prod`, Sentry dashboard, OWNER metrics).
   - Next 10 min: contain (kill switch, see lane #01).
   - Next 1h: diagnose (logs, Sentry, PostHog).
   - Communication: founder + operator channel; status page
     (`/status` is already a public page).
3. **Postmortem template.** Standard shape: timeline, root
   cause, contributing factors, what went well, what went
   poorly, action items, owners, due dates.
4. **Trace strategy.** Enable Sentry tracing with a 1% sample
   rate by default; bump to 10% during a deploy. AI Program
   Builder async jobs get a 100% sample rate during the first
   month after Builder GA.
5. **Log volume budget.** Per-environment ceiling; documented in
   `docs/metrics.md`. AI Program Builder's per-token logs are
   *not* sent to Sentry (only error states are); per-token
   metrics go to PostHog as a counter, not a per-event row.

### Metric taxonomy (proposed)

Three classes, mapped to existing tooling:

- **RED** (request-level) — Rate, Errors, Duration. Sentry
  spans + Fly metrics. No new code beyond enabling Sentry
  traces.
- **USE** (resource-level) — Utilization, Saturation, Errors.
  Fly metrics + Postgres pg_stat_statements (operator manual).
- **Product** — engagement, conversion, dunning. PostHog +
  the OWNER metrics endpoint.

### What goes to Sentry vs PostHog vs the OWNER counter

| Signal class | Tool | Example |
|---|---|---|
| Server error | Sentry | Unhandled exception |
| Span / trace | Sentry | Builder draft job, end-to-end |
| Product event | PostHog | Coach starts checkout |
| Operator counter | OWNER metrics | Coaches in `past_due` past grace |
| Audit | `AuditLog` | OWNER promoted user X to OWNER |

The split is the rule — when in doubt, ask "is this for an
engineer triaging an outage (Sentry), for a product analyst
(PostHog), for an operator running the platform (OWNER
metrics), or for a regulator/legal (audit)?".

## HOW

### Operator handoff

- A new `docs/incident-response.md` describes the first-15-min
  procedure, the severity ladder, the comms paths, and the
  status page contract.
- A new `docs/postmortem-template.md` is the writeup template
  (one section per known step). Postmortems are stored in
  `docs/postmortems/` (created by the first one).
- `docs/metrics.md` is extended with the metric taxonomy and
  the log volume budget.

### Trace enablement

`src/instrument.ts` already initializes Sentry. The runtime PR
that descends from this brief enables `tracesSampleRate: 0.01`
by default, bumps to 0.10 inside the Sentry init when a build
is detected as the first 24h of a release (env-var
`SENTRY_RELEASE_BOOST=1`, off by default).

For AI Program Builder, the runtime PR adds a trace per draft
job, with the prompt template id and chunk count as span
attributes. PII (asset content, draft body) is **not** sent to
Sentry — see lane #03 for the secret-leak-via-logs threat.

## Risks

- **Sentry quota exhaustion during a degraded prompt.**
  Mitigation: log-volume budget, rate-limited error logs, AI
  per-token metrics aggregated.
- **Severity ladder vs reality.** Mitigation: review every six
  months during the standing review; update if a real incident
  shows the ladder mis-specified.
- **No oncall rotation.** Mitigation: documented as such — OWNER
  is oncall today. Out of scope for this brief is the
  rotation question; that's an org decision.
- **PII in traces.** Mitigation: Sentry `beforeSend` hook
  scrubs known sensitive paths (already partially in place);
  the runtime PR extends to the Builder draft attributes.

## Dependencies

- Lane #01 (kill switches) — every kill switch is the first
  containment action listed in incident response.
- Lane #03 (security posture) — incident response composes
  with the cross-tenant leak P0.
- Lane #08 (AI governance) — AI per-token metrics live
  in PostHog (not Sentry).

## Acceptance criteria

1. ✅ `docs/incident-response.md` exists with the severity
   taxonomy and first-15-min procedure.
2. ✅ `docs/postmortem-template.md` exists.
3. ✅ `docs/metrics.md` is extended with the metric taxonomy
   and the log volume budget.
4. ✅ Sentry tracing is enabled with the documented sample
   rates (runtime PR; not part of this docs PR).
5. ✅ A trace is added per AI Program Builder draft job
   (runtime PR; not part of this docs PR).

## Test strategy

- **Unit:** the Sentry `beforeSend` PII-scrub has unit tests
  asserting that known sensitive fields never leave the
  process.
- **Integration:** existing smoke tests cover `/health`. A new
  smoke step asserts the OWNER metrics endpoint returns
  the expected envelope.
- **Manual:** OWNER walks an incident drill once per quarter
  (synthetic outage of one module, follow the runbook end to
  end, file a postmortem).

## Rollout & kill-switch

- Trace sampling: rollout is rate-bump only (0.001 → 0.01 →
  0.10). Kill switch is `SENTRY_DSN=""` (Sentry no-ops).
- Postmortem cadence: every P0 / P1 within 72h.
- Incident-response procedure ships immediately as a doc; no
  runtime kill switch needed.
