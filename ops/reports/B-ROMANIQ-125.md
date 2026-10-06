# B-ROMANIQ-125 — Roman's intelligence bump (Claude Opus 5.5 builder, T4 AI)

Started 14:46 PDT 10-06. Hard stop 15:40.

## Scope traced (paths + routes)
- Roman turn: `POST` Roman chat stream -> `RomanService` stream (`src/roman/roman.service.ts` ~1079) -> `AiEgressService.anthropicMessagesStream`; daily cap `reserveDailySpend`/`costUsd` (ROMAN_PRICE_PER_MTOK); background breaker `roman-background-spend.ts` (ROMAN_MODEL_PRICE_PER_MTOK).
- Coach AI: `AnthropicAdapter.complete/completeStructured` (drafts: workout program, meal plan, insight; gateway provider; client chat fallback in `ai.service.ts`), cost to AICallLog + coach credit pool (INPUT/OUTPUT_USD_PER_MTOK), gateway meter `estimateAnthropicCostCents`.
- Churn draft `churn-intervention.service.ts`; boot probe `coach-ai-state.service.ts` (if it 400s, all Coach AI is "not ready").
- Coach brief `GET /coach/brief/today` + cron -> `CoachBriefService.callClaude` (15 s timeout, repair attempt; app timeout 40 s in mobile `coachBriefApi.ts`).
- Anthropic docs: models overview, Sonnet 5.5 migration guide / what's new / overview, Opus 5.5 migration guide, Effort page (raw text saved: `ops/reports/B-ROMANIQ-125-docs.txt`).

## Key compatibility findings (would have been B if ids were swapped naively)
- Non-default `temperature` is a 400 on Sonnet 5.5 and Opus 5.5. Coach AI adapter (default 0.7), churn (0.7), brief (0.6) all sent it: an id-only swap would fail every coach AI draft, the brief and churn drafts. Removed everywhere.
- Sonnet 5.5 with no `thinking` field thinks (adaptive, effort high); `disabled` is a 400. Roman would get slower first tokens and spend its 1024 max_tokens on thinking. Fixed with `thinking: between_tools` + explicit effort.
- Opus 5.5 always thinks; brief max_tokens 300 would be eaten by thinking -> empty text -> fallback. Raised to 2048, effort low.
- SDK 0.104.1 types lack `between_tools`; egress gate widened (type only).

## B list
None open (owner-requested upgrade; compatibility hazards above handled in the PR).

## U list
None.

## C one-liners
- C (edge, deferred to 10k clients): deploy-day Roman cap re-prices that UTC day's earlier 4-6 rows at $2/$10.

## Covered by open PRs
n/a. Overlap: #795 edits r11-seams.spec.ts and roman-launch-hardening.spec.ts in other hunks.

## PRs opened
- backend #803 https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/803 head f8fc690fe651baa4122eded1cfcc7fe8d23e4586 (3 commits), +191/-61 = 252 lines. CI green at this head (16 success, 1 skipped). The first head 4019326b was red from this change: two Roman cents pins (rmn2-fixes, spend-admission live) still used the old price. Fixed in commit 3. READY comment: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/803#issuecomment-6026624802. Operator 15:30: Sol APPROVE at f8fc690f; Opus review pending.

## Choices
- Roman turns: claude-sonnet-5-5, `between_tools`, effort `medium` (doc: chat start medium or low).
- Coach AI (drafts, gateway, client chat fallback, churn, probe): claude-sonnet-5-5, `between_tools`, effort `high` (what 4-6 ran at by default).
- Brief: claude-opus-5-5, adaptive (always on), effort `low`, max_tokens 2048, timeout unchanged 15 s (fits 40 s app timeout for 2 attempts).
- Prices: Sonnet 5.5 $2/$10; 4-6 kept at $3/$15 in the per-model table; unknown fallback = highest (3/15).
- Live G1-G30: cannot run in CI (live runner in unmerged #605; CI key is a placeholder). Stub G1-G30 runs in the normal suite.

## Not fixed (needs operator)
- Owner/operator decision: brief effort. Default kept `low` (latency fits the request path). Raising to `medium`/`high` needs a longer BRIEF_ANTHROPIC_TIMEOUT_MS and app timeout, or brief generation moved off the request path.
- Info: claude-haiku-4-5-20251001 (Roman background, flag-off) retirement listed "Not sooner than October 15, 2026" — revisit before turning background on.
- Recommend a live smoke after deploy: one Roman turn, one coach AI draft, one brief regenerate (a 400 would show as coach AI not ready / brief fallback).

## HANDOFF
Done at 15:3x after WRAP UP. Branch agent125/b-romaniq-125-models was pushed at f8fc690f. The worktree was removed and no ci/* branches were created. If the Opus lens asks for changes: re-create the worktree from the branch and keep it under 300 lines. The PR body source is ops/reports/B-ROMANIQ-125-pr-body.md and the raw docs are in ops/reports/B-ROMANIQ-125-docs.txt.
