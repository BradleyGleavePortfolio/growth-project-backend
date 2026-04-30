# Handoff brief — AI weekly recap (B2)

**Roadmap row:** #23.
**Status:** In discovery — spec drafted; runtime work not started.
**Spec:** [`../../specs/weekly-recap.md`](../../specs/weekly-recap.md).
**Cross-references:** PR #117 (AI Program Builder RFC — same
provider plumbing, same cost cap), PR #119 (parent roadmap), brief
[`21-outcome-check-ins.md`](./21-outcome-check-ins.md) (input),
brief [`22-at-risk-detector.md`](./22-at-risk-detector.md)
(input), brief [`24-coach-ai-voice.md`](./24-coach-ai-voice.md)
(tone source).

## WHY

The smallest end-to-end use of platform AI: one prompt, one
client, one human-in-the-loop edit, one outbound coach message.
It is the *forcing function* for the coach AI voice setting (#24)
and the *first user-visible signal* that the platform's AI is
trustworthy. Founder's blueprint puts it at week 3–6.

## WHEN

- Coach AI voice setting (#24) has shipped at least the data
  model.
- Outcome check-ins (#21) are in flight (graceful when missing).
- One design partner has agreed to review the first ten recaps
  by hand before send.

## WHERE

- New module: `src/weekly-recap/`.
- New table: `WeeklyRecap`.
- New routes: `POST /api/coach/clients/:id/weekly-recap/draft`,
  `GET .../weekly-recap/latest`, `PATCH /api/coach/weekly-recaps/:id`,
  `POST .../send`.
- Outbound: posts the sent recap as a `CoachMessage` (no new
  channel).

## WHO

- **Sign-off:** founder reviews first recap; backend lead for
  tables; design partners for prompt iteration.
- **On the hook:** backend platform.
- **Downstream:** coach console.
- **Provider:** Anthropic (per AI Program Builder RFC §4) with
  deterministic fallback.

## WHAT

- **Already exists:** Anthropic provider plumbing, `CoachMessage`
  thread, per-coach AI budget cap on `CoachProfile`.
- **Net-new:** one table, one module, prompt template under
  `prompt-templates/recap.v1.md`, eval CI step (shared with PR
  #117), one feature flag (`WEEKLY_RECAP_ENABLED`).
- **Non-goals:** no auto-send; no separate analytics opt-in;
  edit-required workflow.

## HOW

PR-1 model + migration + prompt template + deterministic
fallback. PR-2 wires routes + budget gate. PR-3 adds eval CI
step. PR-4 design-partner allow-list, manual review of first 10.
PR-5 cohort. PR-6 platform-wide.

## Risks (top three)

1. **Hallucinated facts** — prompt template forbids inventing,
   eval suite includes "no-data week" fixture.
2. **Voice drift** — hard dependency on #24; recap gated on
   voice setting being present.
3. **PII in Sentry breadcrumbs** — explicit scrubber for the
   `weekly_recap` namespace; covered by integration test.

## Cross-references

- Spec: [`../../specs/weekly-recap.md`](../../specs/weekly-recap.md).
- Upstream: brief #21 (input), brief #22 (input), brief #24
  (tone), PR #117 (provider posture, eval CI shared).
