# Handoff brief — Outcome check-ins (B7)

**Roadmap row:** #21.
**Status:** In discovery — spec drafted; runtime work not started.
**Spec:** [`../../specs/outcome-check-ins.md`](../../specs/outcome-check-ins.md).
**Cross-references:** PR #117 (AI Program Builder RFC §22 — the
Outcome Graph this feature feeds), PR #118 (Team Mode ADR — the
tenancy axis the new tables must respect), PR #119 (parent
roadmap), brief [`22-at-risk-detector.md`](./22-at-risk-detector.md)
(downstream consumer), brief [`23-weekly-recap.md`](./23-weekly-recap.md)
(downstream consumer).

## WHY

The existing daily `CheckIn` model is a wellness ping. The
proprietary outcome data the platform's data moat depends on —
weight, lifts, MRR, hours worked, adherence — is *not* in that
ping. This item adds a **weekly, per-niche, structured**
check-in (`OutcomeCheckIn`) that sits alongside the daily one
and accrues the longitudinal data the AI Program Builder, the
at-risk detector, and the platform's eventual Outcome Graph all
read.

## WHEN

- Design-partner cohort is signed and the schema-design session
  for B7 has produced niche-field shapes for at least two niches.
- AI Program Builder RFC §17 is closed on whether the Builder
  reads daily, weekly, or both.
- Team Mode ADR §10 is closed on per-staff attribution at the
  outcome-check-in level.

## WHERE

- New module: `src/outcome-check-ins/`.
- New tables: `OutcomeCheckInTemplate`, `OutcomeCheckIn`.
- New routes under `/api/coach/outcome-templates`,
  `/api/coach/clients/:id/outcome-check-ins`,
  `/api/me/outcome-check-ins/*`.
- Read by: at-risk detector (#22), weekly recap (#23), AI Program
  Builder (PR #117), OWNER metrics.

## WHO

- **Sign-off:** founder for niche fields; backend lead for
  tables; design partners for cadence.
- **On the hook:** backend platform.
- **Downstream:** coach console, mobile, AI Program Builder.
- **Hard boundary:** `new-website` repo is out of scope.

## WHAT

- **Already exists:** `CheckIn` daily model (kept as-is); RBAC
  guards on `coach-check-ins.controller.ts`.
- **Net-new:** two tables, one module, one feature flag
  (`OUTCOME_CHECKINS_ENABLED`), seeded starter templates.
- **Non-goals:** does not replace daily check-in; does not
  define AI summarization (#23) or thresholds (#22); ships API
  before UI.

## HOW

PR-1 adds the migration + empty module shell + flag (off). PR-2
wires templates API. PR-3 wires per-client weekly endpoints.
PR-4 wires OWNER metrics counters. PR-5 turns the flag on for
the design-partner allow-list.

## Risks (top three)

1. **Schema-by-committee drift** breaks the cross-coach moat —
   spec mandates per-niche allow-list of field types and a small
   set of canonical keys.
2. **Daily / weekly confusion** for coaches — handoff doc and
   help center copy must clarify the split.
3. **GDPR scrub miss** — the runtime PR must update
   `audit-and-gdpr.md` on the same change.

## Cross-references

- Spec: [`../../specs/outcome-check-ins.md`](../../specs/outcome-check-ins.md)
- Roadmap: [`../expansion-roadmap.md`](../expansion-roadmap.md)
  row #21.
- Upstream RFCs: PR #117 §22, PR #118 §11.
