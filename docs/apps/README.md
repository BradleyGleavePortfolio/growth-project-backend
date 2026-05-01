# Wave 6 — Apps Platform: Architecture, SDK, Manifest, MCP

Status: DRAFT (docs only, no runtime, no migrations)
Wave: 6
Branch: `docs/wave-6-app-architecture-sdk`
Base: `main`

## Purpose

The Growth Project (TGP) needs a third-party application platform so coaches and external developers can extend the operating system with custom apps. This is the "Whop-AI parity" gap for the apps marketplace: programs, integrations, custom storefront blocks, dashboards, AI tools, and webhooks must all be expressible as installable units that respect TGP's permission model, retention doctrine, and money discipline.

This wave defines the runtime model, the manifest schema, the SDK surface, the install/billing flow, the developer-portal review pipeline, and the MCP server that exposes the admin data-feed (Wave 3) to AI agents.

This wave is **docs only**. Nothing runs. `prisma/schema.prisma` is not touched. All schema deltas inside files are illustrative inside fenced ` ```prisma ` blocks.

## Non-goals (this wave)

- We do not implement any runtime, sandbox, signing service, or marketplace UI.
- We do not pick a single OWNER_DECISION. We surface options + recommendation; the owner decides.
- We do not duplicate Wave 2 (product specs) or Wave 3 (admin data-feed). We depend on them.
- We do not specify mobile parity for app surfaces — that lives in `growth-project-mobile` Wave 4 follow-up.
- We do not own the finance payout machine — that is `tgp-finance-app` (Wave 5 + Wave 8 finance half).
- We do not define the public marketplace storefront (browse, search, ratings) — Wave 9.
- We do not specify how AI agents themselves are written — only the MCP surface they consume.

## File map

| File | Approx. lines | Owns |
|---|---|---|
| `README.md` | 200 | Index, OWNER_DECISIONs, dependency graph, merge order. |
| `architecture.md` | 1,000 | Runtime model (iframe vs server vs hybrid), capability model, sandbox, quotas, lifecycle, failure modes. |
| `manifest-spec.md` | 900 | JSON manifest schema, signing, version pinning, capability declarations, surfaces, sample manifests. |
| `sdk-spec.md` | 800 | TypeScript client surface, hooks, typed API, auth flow, rate limits, errors, pagination, webhooks. |
| `installation-and-billing.md` | 800 | Install/uninstall, revenue split, Connect routing, refunds, trials, Decimal(14,2). |
| `developer-portal-and-review.md` | 800 | Submission, review SLA, reject taxonomy, sandbox lifecycle, trust ladder, banned categories. |
| `mcp-server-spec.md` | 700 | MCP tools for AI agents, scopes, rate limits, audit, consent gates. Default model: sonar-pro. |
| `PERP_HANDOFF.md` | 150 | Session log, decisions, deferrals. |

Total: ~5,400 lines of dense spec.

## Dependency graph

```
                           Wave 1 (admin console canonical)
                                       |
                                       v
        +------ Wave 2 (product specs: coaches, programs, retention) ------+
        |                                                                  |
        v                                                                  v
Wave 3 (admin data-feed)                                       Wave 5 (sub-coach billing on Connect)
        |                                                                  |
        +-----------+---------------------------+--------------------------+
                    |                           |
                    v                           v
              Wave 6 (THIS): Apps platform — runtime, manifest, SDK, MCP
                    |
                    +--> Wave 7 (AI agents author apps)
                    |
                    +--> Wave 8 (apps that move money use finance half)
                    |
                    +--> Wave 9 (marketplace storefront over apps)
                    |
                    +--> Wave 10 (psychology doctrine constrains app surfaces)
```

Wave 6 hard depends on:

- **Wave 2** for the entity model (`Coach`, `SubCoach`, `Client`, `Org`, `Program`, `Cohort`, retention engine).
- **Wave 3** for the scope-stack, capability-hash cache key shape, SSE envelope. The SDK and MCP server consume this contract.
- **Wave 5** for Stripe Connect routing — apps that take money route through the same Connect account graph.

Wave 6 is the foundation for:

- **Wave 7 (AI agent authoring)**: agents author apps by emitting valid manifests + SDK calls.
- **Wave 8 (finance half)**: per-app revenue split, Connect onboarding for app developers.
- **Wave 9 (marketplace storefront)**: install button, browse, ratings, install metrics.
- **Wave 10 (psych doctrine)**: forbids certain app surfaces (public streak counters, noisy reactions, dark-pattern social proof).

## OWNER_DECISIONs surfaced in this wave

This wave does NOT decide these. Owner picks before Day-1 implementation.

1. **Runtime model.** iframe sandbox vs server-side runtime vs hybrid.
   Recommendation: **hybrid**. iframe for UI surfaces, server runtime (isolated worker) for webhook handlers + scheduled jobs + MCP-tool-style server functions.
   Rationale: iframe gives strongest UI isolation and lowest TGP-side blast radius for third-party JS; server runtime is required for webhooks/cron because we cannot host them inside an iframe; doing both gives a graded trust model. See `architecture.md` Section 3.

2. **Manifest signing key custody.** AWS KMS vs HashiCorp Vault vs in-process keypair.
   Recommendation: **AWS KMS** (asymmetric ECC_NIST_P256, SIGN_VERIFY usage).
   Rationale: matches existing AWS deploy posture, provides hardware-backed custody and audit log, asymmetric so verifiers never see private material. See `manifest-spec.md` Section 6.

3. **Per-app revenue split percentage.** 70/30 dev/platform with first $1k/mo developer revenue free vs flat 15% platform fee vs tiered (15% under $50k, 20% above).
   Recommendation: **70/30 with first $1k/mo free** (developer keeps 100% on first $1k/mo, then 70/30 thereafter).
   Rationale: lowest friction for early devs, matches Apple/Google small-business programs, keeps unit economics aligned with Stripe Connect flat fees. See `installation-and-billing.md` Section 4.

4. **Review SLA for new app submissions.** 5 business days vs 10 vs "best effort".
   Recommendation: **5 business days** for new submissions, **2 business days** for verified-developer updates that do not change capability scopes.
   Rationale: aggressive enough to attract early devs, lenient enough to staff with ~1.0 FTE reviewer at 100-coach scale. See `developer-portal-and-review.md` Section 3.

5. **Sandbox resource quotas.**
   Recommendation: 2 CPU-sec/req hard cap, 256 MB memory peak per worker, 100 MB/day egress per app per org, 50 req/s sustained, 200 req/s burst, 10 concurrent workers per app.
   Rationale: covers webhook + cron + MCP-tool-action patterns without underwriting abuse. See `architecture.md` Section 7.

6. **Default for unverified developers**: sandbox-only (no production install) until first review pass.
   Recommendation: **enforced**. No production install for unverified developers.

7. **PII data scopes available to apps.** Allowlist (recommended) vs denylist.
   Recommendation: **allowlist**. Apps must declare each PII scope (`read:client.email`, `read:client.phone`, `read:client.dob`, etc.) explicitly. Coach must consent at install time.

## Merge order

1. This wave (Wave 6) opens as **draft**, base `main`. No conflicts with Waves 1-5 because docs-only and lives under `docs/apps/` which does not exist yet.
2. Wave 6 must merge **after** Wave 2, Wave 3, Wave 5 are merged or otherwise sealed (currently draft). If Wave 2/3/5 receive material changes, this wave must be re-reviewed for capability-scope consistency.
3. Wave 7-10 branch off main after Wave 6.

## Personas + permission matrix (cross-cut for this wave)

| Capability | OWNER | COACH | SUB_COACH | CLIENT | ADMIN | DEVELOPER |
|---|---|---|---|---|---|---|
| Submit a new app | no | no | no | no | yes | yes |
| Approve an app submission | no | no | no | no | yes | no |
| Install an app on own org | n/a | yes | no | no | yes | n/a |
| Install an app on coach's org (sub-coach) | n/a | n/a | only if coach grants | no | yes | n/a |
| Uninstall an app | n/a | yes | only if coach grants | no | yes | n/a |
| Configure app capabilities | n/a | yes | no | no | yes | n/a |
| Receive payouts from app sales | n/a | n/a | n/a | n/a | n/a | yes |
| Read app's audit log | yes (TGP) | yes (own org) | no | no | yes | yes (own apps) |
| Trigger MCP tool action via AI agent | yes (consent) | yes (consent) | yes (if coach delegates + consent) | no | yes (consent) | n/a |

`DEVELOPER` is a new persona introduced in this wave. A `DEVELOPER` is a Stripe-Connect-onboarded entity (individual or company) authorized to publish apps. A `DEVELOPER` may also be a `COACH` — those are independent grants.

## Cross-repo dependency map

| Repo | What changes here forces a follow-up | Wave |
|---|---|---|
| `growth-project-mobile` | Mobile must render storefront-block surfaces and admin-page surfaces inside its native shell. WebView container spec. | Wave 4 + Wave 9 mobile half |
| `tgp-finance-app` | Per-app revenue split, Connect platform fee config, refund/clawback for app subscriptions. | Wave 8 finance half |

## Day-1 implementation order (when owner unblocks)

1. Pick OWNER_DECISIONs 1-7 above.
2. Implement manifest validator (no runtime yet) — pure function `validateManifest(json) -> Result`.
3. Stand up `apps_registry` table behind a feature flag (no traffic).
4. Stand up developer portal (forms only, no review).
5. Implement signing service (KMS keys provisioned, signing endpoint behind staff-only auth).
6. Implement install flow (no UI, behind feature flag).
7. Stand up sandbox runtime (Cloudflare Workers / Fly Machines / Lambda — chosen at architecture review).
8. Implement SDK package (`@tgp/apps-sdk`).
9. Stand up MCP server (read-only first; no tool-actions until consent UI shipped).
10. Marketplace storefront — Wave 9.

## Test plan summary

Each spec file owns its slice of the test plan. The union covers:

- **Unit**: manifest validator, capability scope checks, signature verifier, rate-limit token bucket, quota counter, error-envelope serializer.
- **Integration**: install flow end-to-end with a mock app, uninstall + GDPR data wipe, capability revocation, version-pinning upgrade path, MCP tool-action consent gate.
- **E2E**: developer submits app, reviewer approves, coach installs, app makes valid SDK calls, app exceeds quota and is throttled, app fails health check and is auto-suspended, app is uninstalled and all install-scoped data is purged.
- **Load**: 10k coach scale, 5 apps installed per coach (50k installs), 100 req/s per install sustainable, MCP tool calls under 250ms p50.

## Migration / backfill

No backfill. New tables, new code paths. Apps platform is opt-in and starts empty.

## Rollback

Feature flags on every entry point: `apps.install.enabled`, `apps.runtime.enabled`, `apps.mcp.enabled`, `apps.marketplace.enabled`. Disabling all flags returns the platform to pre-Wave-6 behavior. Already-installed apps remain in DB but do not load. Webhooks/cron jobs queued by apps stop dispatching.

## Senior-engineer onboarding checklist

- [ ] Read `architecture.md` end to end. Understand the iframe-vs-server split.
- [ ] Read `manifest-spec.md` and write a sample manifest by hand.
- [ ] Run the manifest validator against the 3 sample manifests.
- [ ] Read `sdk-spec.md`. Identify the auth flow.
- [ ] Read `mcp-server-spec.md`. Identify the consent-gate diagram.
- [ ] Read `installation-and-billing.md`. Trace one purchase end-to-end.
- [ ] Confirm that no schema deltas in this wave have leaked into `prisma/schema.prisma`.
