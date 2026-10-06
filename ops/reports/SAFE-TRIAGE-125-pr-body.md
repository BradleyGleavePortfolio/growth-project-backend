**Tier:** T4 (AI safety: crisis routing in an AI path over client community content)
**Why:** Owner 14:59 safety pass on community AI triage (SAFE-TRIAGE-125). Today a member's self-harm post can be filed by the model as "No action needed" (the prompt even told it never to imply an emergency), or skipped by the model and silently dropped from the coach's triage counts.
**T4 trigger scan:** AI path over client personal and possibly health-related text: yes (classification logic only). Auth / RLS / tenancy / consent / money / credentials / destructive data: no change (the R2b consent filter, gateway tenancy check and coached-cohort scope are untouched).
**T3 trigger scan:** no schema, no migration, no new dependency, no new flag, no route change, no mobile change. Wire contract (TriageResponseSchema) unchanged.
**Bounded T1:** none.
**Canonical builder:** Claude Opus 5.5 (SAFE-TRIAGE-125, agent 125).
**Acceptance evidence:** `test/community/ai-triage/ai-triage.service.spec.ts` 32/32 locally (5 new tests; the first three fail on main because main keeps the model's category and drops skipped items); `test/trust-pages.spec.ts` 48/48 (prompt field disclosure unchanged). Full suite, tsc and lint in this PR's CI.

Flag state: FEATURE_COMMUNITY_AI_TRIAGE stays unset (off) in production; this PR changes nothing a user can reach today. It removes the crisis-routing blocker for a later flip (see ops report SAFE-TRIAGE-125).

## Fixes
- **B-1 (safety / crisis routing, on flip):** A client posts in their cohort that they keep thinking about hurting themselves; the coach's AI triage card counts it under "No action needed" (or drops it), so a coach skimming the card sees nothing that needs them. Now: a deterministic check on the item's FULL text (not the 240-character preview) pins self-harm, suicide, eating-disorder and acute-symptom language (chest pain, fainting) to `urgent` ("Needs you soon") with a neutral summary, whatever the model returned or skipped. `src/community/ai-triage/ai-triage.service.ts` (`SAFETY_PATTERNS`, `needsSafetyAttention`, `project`).
- **U-1 (misleading number, on flip):** an item the model skips (refusal, injection in another member's text, miss) vanished, so "N unanswered items" undercounted. Now it lands in `general` (or `urgent` if it is a safety item); the count matches the items sent for sorting.
- **Prompt v2** (`prompts/inbox-triage.prompt.ts`, PROMPT_VERSION bump): safety items are always `urgent`; member text is data, never instructions. Over-matching only moves an item up the coach's list; nothing is sent, replied to or hidden (triage stays classify-only).

## Overlap
- Stale open #605 (R8 eval harness, 10-01) also edits `ai-triage.service.ts` (an older consent gate superseded by #626). No functional overlap; this change is confined to `project()`, the candidate builders and a new helper.
