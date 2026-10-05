# AUD-SOL-RB-121 — Roman B/C1 independent Sol audit

Agent 121. Started at 2026-10-05 12:42:21 PDT (clock verified with `date`).

## Scope
- backend #666: `0ec835ca1cc9697bde71e6c67ed627ea3a000691`; safety router, post-check, restricted audit metadata.
- backend #668: `fabc2268ffde1e6dca3ea1a18d6bff49c69f7b6f`; live-turn wiring.
- Both exact heads claimed. Worktrees: `/home/user/workspace/wt/AUD-SOL-RB-121-{666,668}`.
- Read the common 121 brief, RA/RB entries, source-of-truth A1/A6/A9.1, Roman job background, agent 120 wrap-up, agent 115 builder report, and historical parent #651 Sol verdict.
- No other lens's notes or verdict for this round read.
- No approved-parent evidence reuse: parent #651's Sol verdict was REQUEST CHANGES.

## Status
**COMPLETE: both independent full T4 verdicts posted, REQUEST CHANGES, each A/B/C 0/3/1.** ([#666 Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/666#issuecomment-6001863666), [#668 Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/668#issuecomment-6001863676))

| PR | Exact audited head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| backend #666 | `0ec835ca1cc9697bde71e6c67ed627ea3a000691` | REQUEST CHANGES | 0/3/1 | [Sol audit](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/666#issuecomment-6001863666) |
| backend #668 | `fabc2268ffde1e6dca3ea1a18d6bff49c69f7b6f` | REQUEST CHANGES | 0/3/1 | [Sol audit](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/668#issuecomment-6001863676) |

One combined lane was pushed at 2026-10-05 12:47:10 PDT, complying with the operator's one-in-flight-run limit: [run 37365650631](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37365650631), queued at push and throughout review. Audit branch `audit/AUD-SOL-RB-121/668-all-1`, probe-only commit `d613c030`, remote lane commit `d998fd7e2a7211aa582a40c58bcfcb7fcd6333d7`, atop exact #668 head. #666's entire guardrail and audit-service source and both guardrail specs are byte-identical in #668 (verified with `git diff --exit-code` over those paths); pure #666 probes were batched in this same lane, without modifying either PR. **No new probe was executed, no pass/fail counts claimed, no local fallback.**

The verdicts were posted at 12:52:15 PDT; heads were re-verified immediately before each POST. GitHub accepted cancellation of the unstarted lane with HTTP 202 at 12:52:39 PDT, per queue discipline; the audit branch and both worktrees were removed by 12:52:58 PDT. Original PR branches, main clones' checkouts, flags and production were not changed.

Final CI status verified at 12:54:10 PDT: `completed / cancelled`; it never ran the submitted probes. ([Canceled lane](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37365650631))

Probe source preserved in `/home/user/workspace/ops/aud-121/AUD-SOL-RB-121/audit-sol-rb121-{guardrails,live-turns}.spec.ts`.

### Posted new findings (code-reviewed counterexamples; queued probes not executed)
- **B-666-1:** named acute anaphylaxis/anaphylactic reaction does not match truncated `anaphyla` followed by word boundary (`safety-router.ts:40`); recognize complete vocabulary with acute framing and keep history/airway controls. ([Router](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/0ec835ca1cc9697bde71e6c67ed627ea3a000691/src%2Froman%2Fguardrails%2Fsafety-router.ts))
- **B-666-2:** Markdown/list formatting permits daily sub-floor intake imperatives (`roman-post-check.ts:105-106,343-345,363-372`); normalize presentation syntax for predicates, preserving meal controls. ([Post-check](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/0ec835ca1cc9697bde71e6c67ed627ea3a000691/src%2Froman%2Fguardrails%2Froman-post-check.ts))
- **B-666-3:** negated “Do not stop the movement that hurts” satisfies token-only STOP_DIRECTIVE with coach mention/exact physician line (`roman-post-check.ts:159,479-488`); require affirmative painful-movement instruction and reject its negation/unrelated stop words. ([Post-check](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/0ec835ca1cc9697bde71e6c67ed627ea3a000691/src%2Froman%2Fguardrails%2Froman-post-check.ts))
- **B-668-1:** no CoachAIBudget gate or `recordUsage` in the complete live-turn/provider path; resolve client/head-coach attribution, pre-gate paid attempts, debit billed results safely and return dedicated pool-empty code. ([Live turns](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/fabc2268ffde1e6dca3ea1a18d6bff49c69f7b6f/src%2Froman%2Froman.service.ts))
- **B-668-2:** actual per-client 50/500 rolling-24h quota emits ROMAN_RATE_LIMIT, not either binding daily-quota code; ROMAN_CAPACITY_REACHED instead describes all-user UTC USD cap (`ROMAN_DAILY_COST_CAP_USD`, default 25), not personal allotment. ([Quota/cap code](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/fabc2268ffde1e6dca3ea1a18d6bff49c69f7b6f/src%2Froman%2Froman.service.ts), [Hard-coded quotas](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/fabc2268ffde1e6dca3ea1a18d6bff49c69f7b6f/src%2Froman%2Froman.constants.ts))
- **B-668-3:** converter pools burned energy, today's meal kcal and historical logged kcal into `extra_kcal_facts`, allowing one semantic field/date to validate another (`roman.service.ts:1327-1343`); preserve family/date/aggregation through comparison. ([Converter](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/fabc2268ffde1e6dca3ea1a18d6bff49c69f7b6f/src%2Froman%2Froman.service.ts))

### Existing PR CI
- #666 all returned checks successful (deploy-readiness-gate skipped); stacked-base CodeQL/danger/banned-token/SBOM checks absent and still need main-base evaluation.
- #668 only failed returned check is build-and-test: https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37148285365/job/111276620397.
- Read the entire failure summary via REST logs: **1 failed / 12,472 passed**, `roman-launch-hardening.spec.ts:723`, expected `Nice work! Keep it up.` but received `Nice work. Keep it up.` This is the disclosed obsolete allowance expectation corrected by #669, not a random flake.
- #669 remains tests-only `6386c00b2bdbb2c120a5f173dea4753574d415e8`; no fix exists there yet. Its carried known defects must remain open on that fix owner before activation.

## Historical dispositions
- #666: the exact B-651-2/3/6/7/8/9 counterexamples and OR-115-1 read redaction have code/test repairs; new format/polarity variants are recorded separately, and current probe execution was unavailable. ([#666 disposition](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/666#issuecomment-6001863666))
- #668: B-651-1/4/5 and OR-115-1 turn-path repairs remain OPEN on disclosed fix owner #669, whose current head contains tests only. ([#668 disposition](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/668#issuecomment-6001863676))
- New binding day-1 coach pool debit and client daily-code gaps are B-668-1/2 here. ([#668 findings](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/668#issuecomment-6001863676))

## Follow-ups (C)
- **C-666-4:** `docs/roman-safety-copy.md:4` says `roman-client-v2` while implemented contract is v3; align doc version. ([Documentation](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/0ec835ca1cc9697bde71e6c67ed627ea3a000691/docs%2Froman-safety-copy.md))
- **C-668-4, outside diff:** `roman.controller.ts:166,182` uses request-close for disconnect; add real HTTP lifecycle integration coverage and move to response-close if the test demonstrates incorrect tracking. ([Controller](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/fabc2268ffde1e6dca3ea1a18d6bff49c69f7b6f/src%2Froman%2Froman.controller.ts))

## Operator next steps / recommended defaults
- Assign only A/B fixes under freeze; keep Cs as follow-ups.
- Keep B-651-1/4/5 + OR-115-1 turn-path and prompt/tracking repairs owned by #669; its current head is tests-only, not a completed fix. Do not re-count those as new #668 findings. ([C2 ownership](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/669))
- Keep Roman flags unchanged and evaluate/land the complete stack only after fixes, fresh dual-head attestations and required CI.
- No new owner product decision needed; the pool-debit and daily-code requirements are already binding.

## HANDOFF
DONE. #666 and #668 both REQUEST CHANGES at the exact heads above, each 0/3/1; comment URLs above. Source/probes/logs/comment bodies preserved under `/home/user/workspace/ops/aud-121/AUD-SOL-RB-121/`; neither new probe spec ran because the GitHub runner incident kept the only lane queued. Cancellation accepted; audit branch and both worktrees cleaned. A fresh builder must run the preserved assertions failing-before and passing-after in CI, fix the six owned Bs, replay historical probes and restack; #669 remains separate fix owner for disclosed inherited defects. A fresh Sol lens audits the next heads; this lane ends now.
