AUDIT Claude Opus 5.5 — growth-project-backend#651 @ a8fa651c8f131b7d7f61076143671be350af9ce5 — VERDICT: REQUEST CHANGES

This is the first full T4 audit of the whole diff (`12e1b03b...5a3a6302`, 36 files). `e3709cf1..5a3a6302` only drops the boot validator from the ENV_RULES entry. I read all `src` changes line by line, read the specs that carry the claims, and reproduced three defects with executable probes. I read both FIX ROUND 1 comments and both MAIN MERGE comments ([5964434300](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/651#issuecomment-5964434300) and [5964535851](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/651#issuecomment-5964535851)), the PR body Fix round tables, the D2 contract and the 114-S checklist. There are no prior AUDIT comments on #651. **A0 / B3 / C4.**

The two merges at the head are pure:
- `9402f850` merges main `2e3094b9` (#663). `git merge-tree --write-tree 5a3a6302 2e3094b9` gives `5972683e`, its tree, and #663 brought only CI audit-gate files.
- `a8fa651c` merges main `ec911328` (#608 account deletion). `git merge-tree --write-tree 9402f850 ec911328` gives `924d8970`, the head tree. The only files shared with #608 are `.env.example` and `src/common/env-validation.ts`; both auto-merged as separate entries.

**Seam with #608:** this PR adds no table or column. The #608 erasure manifest already deletes `RomanMessage`/`RomanSession` by `user_id` and `AiRequestAudit` by `subject_user_id` (`account-deletion.manifest.ts:191-192,206`), so this PR's new ledger metadata (`router_class`, context hash) is erased with the user. The only remaining trace is in process memory (C-651-4).

### What holds (verified in code)
- **Box 2 on every Roman AI path.** There is one Anthropic call path, `RomanService.streamAssistantTurn`, and it has three gates:
  - the controller's `assertMayUseAi` (`roman.controller.ts:136`);
  - `egress.assertMaySend` before any context read, spend reservation or prompt build (`roman.service.ts:975`);
  - the live re-check inside `anthropicMessagesStream`.

  Only the deterministic 911/988 templates skip the gate (`roman.service.ts:938-959` and the controller's `crisis`). They send nothing to the processor, as D2 allows. `GET /roman/context/me` shows the student their own bundle and makes no AI call. The coach and owner surface uses `noClientDataSubject` and is never grounded (`grounded = surface==='client' && role==='student'`).
- **Tenant isolation of grounding.**
  - The subject is always the JWT id.
  - Every query is `user_id`/`client_id`/`author_id` = the caller.
  - Coach-owned rows also require the coach to equal the caller's current, live coach, with both the DB role and the JWT role `student`.
  - Bookings select title, time and status only.
  - Wearable connections never read token columns.
  - Guidelines are already client-readable (`GET coach/my-guidelines`).
  - The memo is keyed by the caller id.
  - Values are escaped `< > & U+2028 U+2029` inside `<client_data>`.
- **Spend cap.**
  - Unset or invalid means 25 (`dailyCostCapUsd`, `roman.service.ts:1164-1169`). It is registered in ENV_RULES as optional, with no boot validator per the inventory rule.
  - It counts every Roman turn, for all roles.
  - Reservation is insert-then-aggregate on `(capability, created_at)`, which is indexed. Of two concurrent turns, the one that aggregates later sees both rows, so admitted reservations never exceed the cap. The failure mode is over-rejection, which is safe.
  - An unreadable ledger fails closed with a coded 503.
- **Env.** `ROMAN_DAILY_COST_CAP_USD` is the only new env read.
- **G17/G18 rows and logs.**
  - The ledger row carries ids, enums and a hash. The crisis AuditLog row carries actor, session and action only.
  - Logs and Sentry use `romanErrorTag` / `romanSanitizedError`: an allowlisted class name, the Prisma code and the HTTP status.
  - I found no transcript text in any new log line.
- **OR-113-12.** No new owner read of transcripts.
- **Failure copy.** Every new failure has a stable code plus specific, audience-correct copy with a next action, and no we/us or exclamation marks.
- **Checklist.** (a) holds, apart from the C-651-5 note. (b): `appendMessage` re-checks the live session in the transaction, the stale memo is fenced, and a mid-turn delete settles. (c) is covered by tests. (d) holds for the error copy. (e) holds for the FR1 rows.

### B-651-1: an interrupted turn settles the spend ledger at zero, so the daily cap under-counts real spend
- **Evidence:** in `roman.service.ts:1025-1037` the loop checks `opts.signal?.aborted` before it reads each event:
  - `promptTokens` comes only from `message_start`;
  - `completionTokens` comes only from the final `message_delta`.

  The interrupted settle at `:1102` (and the `session_gone` settle at `:1096`) then writes `promptTokens ?? 0, completionTokens ?? 0`. That replaces the worst-case reservation with the missing values as zeros.
- **Probe** (`ops/s-l-opus-b/spend.probe.spec.ts`, real `RomanService` and real egress, fake stream):
  - The client disconnects after the request is dispatched but before the first event: the row settles at **0 input / 0 output**.
  - The client disconnects mid-stream: it settles at **20,000 input / 0 output**, although output was generated.
- **Why this is B:** the cap is the launch's hard spend stop (OR-113-2). Any client can repeat send-then-disconnect within the per-user limit (50 free, 500 pro, per day). The provider bills those calls, but the ledger records them as free, so one heavy user can pass $25 without the cap ever tripping.
- **Minimal fix:** when the provider request was dispatched and usage is incomplete (no `message_start` or no final `message_delta`), settle with the reservation's values for the missing side. Use `promptTokens ?? promptReserve` and `completionTokens ?? max(ROMAN_MAX_OUTPUT_TOKENS-bounded estimate from acc, …)`; simplest is `ROMAN_MAX_OUTPUT_TOKENS` when interrupted. Over-counting is the safe side. Add tests for abort-before-first-event and abort-mid-stream that assert the settled row is not below what was billed.

### B-651-2: the SafetyRouter sends everyday training words to the 911 template
- **Evidence:** `safety-router.ts:26` matches a bare `\bstroke\b`, and `:25` matches `passed out` with no tense or context.
- **Probe** (`ops/s-l-opus-b/router.probe.spec.ts`), each classified `emergency` with `short_circuit: true`:
  - "What should my stroke rate be on the rower?"
  - "How do I improve my back stroke for swim day?"
  - "My rowing stroke feels weak at the catch, any drills?"
  - "I almost passed out after leg day haha, should I eat more before?"
- **Impact:** each of these clients gets "Please stop what you are doing and call 911 now…", and an owner-visible `roman.safety_emergency` AuditLog row is written for their id. Rowing and swimming are core training vocabulary in this product. Telling a client to call 911 over a stroke-rate question is a day-1 trust failure, and it pollutes the crisis evidence trail.
- **Minimal fix:**
  - Require stroke context, for example `(having|had|signs of|think i'?m having|is this) a stroke`, the FAST symptoms already listed, and `stroke symptoms`.
  - Make the faint pattern present-tense or acute (`i (feel like i'?m|am about to|might) (pass out|faint)`, `just (fainted|passed out)`), leaving a past-tense report to the model with the injury or medical hint.
  - Add these sentences as negative golden items next to the positive ones.

  "I had a mild allergic reaction to whey last month" also routes to 911. Fold it in if cheap; otherwise it is acceptable as conservative.

### B-651-3: post-check false positives replace correct nutrition replies with unrelated medical or banned templates
- **Evidence:** `roman-post-check.ts:137` (`\btreat(s|ed|ing|ment)?\b`) and `:140` (`\b(dose|dosage|dosing)\b`) run on every reply, in every class (`:341`). `:145` matches bare `starv(e|ing)`.
- **Probe** (`ops/s-l-opus-b/postcheck.probe.spec.ts`, router class `normal`):
  - "Yes, a small treat fits tonight…" and "A Friday treat meal is fine inside your plan…" become the **injury** template ("I should not name what might be causing that… stop…").
  - "a small dose of cardio" gets the same.
  - "You are not starving yourself by eating at your target" becomes the **banned-substance** template ("I cannot help with that…").
- **Impact:** "treat" is among the most common words in coaching nutrition. A client who asks about a treat gets an injury refusal. That is a nonsensical reply on the hero path, which the owner bar rules out.
- **Minimal fix:**
  - Scope treatment and dose to medical objects, for example `treat(ing|ment)? (it|this|that|the|your) (injury|pain|condition|symptoms?|infection|[a-z]+itis)`, `treatment (plan|for)`, `(dose|dosage) of (your |the )?(medication|meds|insulin|[a-z]+(in|ol|ide|pam)\b)`. Medication doses are already caught by `MEDICATION_DIRECTIVE`.
  - Make starvation a directive only (`(you should|try|just) starv`, `starvation diet`), not a negated mention.
  - Add these replies as golden negatives.

### C findings (optional)
- **C-651-4:** `memo` and `generation` (`roman-client-context.service.ts:202,208`) only grow. An expired memo entry (15 s TTL) is never served, but it is also never evicted, so a long-lived machine keeps every recent client's rendered health bundle in process memory until restart, including after #608 erases the account. Fix: drop expired entries on `set` (or cap with an LRU). Prune `generation` only for users with no build in flight, so the stale-build fence still holds.
- **C-651-5 (operator decision, OR-113-12):** a per-client crisis or health class is stored in three places:
  - AuditLog action names `roman.safety_emergency` / `roman.safety_self_harm` (owner-readable through `AuditService.list`);
  - `AiRequestAudit.metadata.router_class` (`medical_scope`, `eating_disorder_risk`) next to `subject_user_id`;
  - log lines `roman.turn session=… router=self_harm` (`roman.service.ts:947,1112`).

  These are enums, not transcript text, but they are consumer-health inferences. My recommended default is to keep the audit row (crisis evidence) and record this disclosure in #611. If the operator wants less, drop `router=` from the info logs. The builder already lists this as an open item.
- **C-651-6:** the reservation is not worst case. `promptReserve = 30·600+6000` tokens (`:1231`), but 30 history turns at the current 8,000-char DTO limit plus a 3,500-token context can exceed it. So concurrent turns can overshoot the cap by the difference until they settle. Fix: reserve from the actual assembled prompt length (chars/3), or the DTO maximum.
- **C-651-7:** the header at `roman-client-context.service.ts:27` says "CoachingSession is never read", but bookings now read it (with a safe select). Fix the comment.

### Evidence
- **Local, through `ops/heavy.sh`, at `e3709cf1` (`src/roman` and `test/roman` are byte-identical at this head):** `env CI=false npx jest --runInBand --forceExit --runTestsByPath test/roman/roman-launch-hardening.spec.ts test/roman/roman-streaming.spec.ts test/roman/roman-guardrails.spec.ts test/roman/roman-client-context.spec.ts test/roman/eval/roman-golden.eval.spec.ts` gives 5 suites, **164/164 pass**.
- **Audit-only probes** (`ops/s-l-opus-b/{spend,router,postcheck}.probe.spec.ts`; not pushed):
  - The spend probe fails its zero-settle assertion.
  - The router and post-check probes print the misroutes quoted above.
- **CI at this exact head:** all 11 required checks pass, including npm audit now that #663 is merged in. The PR is BLOCKED only on review.

**Outside this diff:** `roman.controller.ts` wires disconnect detection to `req.on('close')`. Since Node 16, IncomingMessage `close` signals that the request completed, which can happen once the body parser has consumed it, rather than signalling client disconnect. Worth a separate check that `res.on('close')` is the right signal, because B-651-1's abort path depends on it. Not raised as a finding here. No push, merge, dispatch or production action by this auditor.

