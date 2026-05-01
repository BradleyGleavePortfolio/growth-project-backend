# Wave 6 — Apps Platform: PERP Handoff Log

Status: DRAFT (docs only)
Branch: `docs/wave-6-app-architecture-sdk`
Base: `main`
Author: TGP platform / Wave 6 spec team
Date: 2026-05-01

## 1. What this wave shipped

Eight files under `docs/apps/` totaling ~5,400 lines of dense spec describing TGP's third-party application platform — the "modular apps marketplace" parity gap with Whop. Docs only. No runtime, no migration, no schema applied. `prisma/schema.prisma` not touched.

| File | Owns |
|---|---|
| `README.md` | Index, OWNER_DECISIONs, dependency graph, file map, merge order. |
| `architecture.md` | Hybrid runtime (iframe + worker), capability model, sandbox, quotas, lifecycle, 8 failure modes. |
| `manifest-spec.md` | JSON manifest schema, TS types, JSON Schema, ECDSA-P256-SHA256 signing via KMS, capability vocab, 3 worked examples. |
| `sdk-spec.md` | TS client surface, auth flow, modules (clients, programs, cohorts, retention, rewards, sub-coaches, messages, payments, audit, admin.metrics, secrets, events), iframe envelope, webhook signing. |
| `installation-and-billing.md` | Install/uninstall flow, 70/30 + first-$1k-free split, Stripe Connect routing, refunds, trials, GDPR wipe. |
| `developer-portal-and-review.md` | Submission flow, 5/2 business-day SLAs, reject taxonomy, sandbox lifecycle, trust ladder, banned categories, end-to-end walkthrough. |
| `mcp-server-spec.md` | MCP transport, Day-1 tool surface, capability scopes, rate limits, consent gates (drafts not sends), default model sonar-pro, audit. |
| `PERP_HANDOFF.md` | This file. |

## 2. Decisions made (in spec)

These are decisions that lived implicitly in the wave's framing and that I made explicit in the spec. They are not OWNER_DECISIONs (those are below for the owner to ratify).

- Hybrid runtime is the recommended model and the rest of the spec assumes it. Pure-iframe and pure-server were considered and rejected with rationale.
- Capabilities are declared in manifest with a `reason` string shown at coach consent. Consent is per-install with PII subscope allowlist.
- Manifest is signed via detached signature over RFC 8785 JCS canonical form, ECDSA-P256-SHA256.
- App tokens are 15-min JWTs bound to (install_id, cap_set_hash, scope_root).
- All money is `Decimal(14,2)` strings; currency stored on row; banker's rounding.
- Mutating MCP tools write drafts, not sends. This is policy, not technology limitation.
- `delete:*`, direct message sends, money movement, sub-coach suspends are NEVER exposed via MCP.
- GDPR uninstall wipe runs at 7 days post-uninstall (undo window).

## 3. OWNER_DECISIONs surfaced (owner picks before Day-1)

| # | Decision | Recommendation |
|---|---|---|
| 1 | Runtime model: iframe / server / hybrid | hybrid |
| 2 | Manifest signing key custody: KMS / Vault / in-process | AWS KMS |
| 3 | Per-app revenue split: 70/30+first-$1k-free / flat 15% / tiered | 70/30 + first $1k/mo dev-only |
| 4 | Review SLA: 5/2 business days / 10 / best-effort | 5 business days new, 2 verified-update |
| 5 | Sandbox quotas: see `architecture.md` Section 7 | 2 CPU-sec/req, 256 MB, 100 MB egress/day, 50 rps sustained, 10 concurrent workers |
| 6 | Unverified developer default: sandbox-only or production | sandbox-only enforced |
| 7 | PII data scopes for apps: allowlist or denylist | allowlist (per-field subscope) |

## 4. Deferred / open questions

These are knowingly punted to later waves or to Day-1 implementation review.

- **Worker substrate** (Cloudflare Workers vs Fly Machines vs AWS Lambda). Decision deferred to Day-1 architecture review. Spec is substrate-agnostic.
- **Marketplace storefront UI** (browse, search, ratings, install button) — Wave 9.
- **First-party AI agent prompts and routing** — Wave 7.
- **Mobile WebView container for iframe surfaces** — `growth-project-mobile` Wave 4 follow-up.
- **Developer payout statements / dispute UI** — `tgp-finance-app` Wave 8 finance half.
- **Psychology doctrine collision with app surfaces** (public streak counters, noisy reactions) — surfaced as a reject category in `developer-portal-and-review.md` Section 6, but Wave 10 ratifies the doctrine.
- **WebSocket transport for MCP** — Day-30.
- **Tier-up paid platform plan for higher quotas** — pricing TBD; plumbing in spec.
- **Anomaly detection for compromised dev signing keys** — sketched, not specified.

## 5. Cross-wave dependencies (forward and backward)

### Backward (this wave depends on)
- Wave 2: entity model (Coach, SubCoach, Client, Org, Program, Cohort), retention engine.
- Wave 3: scope-stack, capability-hash cache key, SSE envelope.
- Wave 5: Stripe Connect routing for sub-coach billing; we extend Connect to a third axis (developer payouts).

### Forward (this wave is foundation for)
- Wave 7: AI agents author apps, call MCP tools.
- Wave 8 (finance half): per-app payout ledger, statements, disputes.
- Wave 9: marketplace storefront over apps.
- Wave 10: psychology doctrine ratifies which app surfaces are forbidden.

## 6. Cross-repo handoffs

| Repo | Required follow-up | Wave |
|---|---|---|
| `growth-project-mobile` | WebView container spec for iframe surfaces; native shell for storefront blocks | Wave 4 follow-up |
| `tgp-finance-app` | Developer payout ledger view; YTD revenue source-of-truth; refund/clawback UI | Wave 8 finance half |

## 7. Open risks

- **R1: Reviewer staffing.** 5 business-day SLA is committable at launch (~20 apps) but degrades as inbound volume grows. Mitigation: fast-path for verified-dev capability-preserving updates; trust ladder accelerates known-good devs.
- **R2: KMS lock-in.** Recommendation is AWS KMS; if TGP later moves clouds, signing migration is non-trivial. Mitigation: signing is via abstraction in TGP code; key import to a new HSM is supported by KMS export workflow but practically one-way per key.
- **R3: First $1k/mo free is expensive at scale.** If developers earning $5k+/mo become common, platform fee revenue is materially lower than flat-15. Re-evaluate at 12 months with data.
- **R4: Quotas may be too tight.** 2 CPU-sec/req + 256 MB worker may be too constrained for some legitimate use cases (e.g. AI tool that does heavy postprocessing). Tier-up path is sketched; pricing TBD.
- **R5: Doctrine drift.** Wave 10 may forbid app surface patterns we haven't thought of. Reject taxonomy has a "Psychology doctrine" category; we add sub-reasons as Wave 10 lands.

## 8. Implementation runway estimate (post owner-decisions)

| Milestone | Weeks |
|---|---|
| Manifest validator + signing service (KMS) | 2 |
| Install state machine + apps_install table | 2 |
| Worker substrate stand-up | 3 |
| iframe origin + CDN + bootstrap | 2 |
| SDK package | 4 |
| MCP server (read-only tools) | 3 |
| Consent flow UI + API | 2 |
| Developer portal | 4 |
| Review queue + reject taxonomy UI | 2 |
| End-to-end test of one paid install | 1 |
| Marketplace (Wave 9) — separate runway | n/a |

Total Day-1 runway: ~25 person-weeks. Achievable in 8-10 calendar weeks with 3 engineers.

## 9. What a senior engineer needs to know on Monday

- Read `README.md` first.
- Internalize the hybrid runtime: UI in iframe, webhooks/cron/MCP-tools in worker.
- Capability checks happen at the TGP API gateway. Always. Twice. (Gateway + SDK call site.)
- Money is Decimal(14,2). Currency on row. No floats anywhere.
- PII never to PostHog. Audit every mutation.
- MCP mutating tools draft, never send. Coaches commit in TGP UI.
- Default AI model sonar-pro. Spend caps are hard.
- GDPR uninstall wipe runs 7 days post-uninstall.

## 10. Sign-off

This handoff is complete. Owner reviews OWNER_DECISIONs (Section 3). Day-1 implementation can start once decisions ratify.

No further action from this wave's authors until owner ratifies decisions or requests revisions.
