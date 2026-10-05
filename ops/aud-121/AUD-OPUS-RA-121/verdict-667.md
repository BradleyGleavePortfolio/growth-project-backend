AUDIT Claude Opus 5.5 — growth-project-backend#667 @ bacd83e10ff0e00dc5165dd223da8b4745e3c82a — VERDICT: REQUEST CHANGES

AUD-OPUS-RA-121 (agent 121). First full T4 review of A1 at this head (AI grounding, health data, PII, consent). **A/B/C = 0/1/1.**

Scope read line by line: all 10 files (`git diff d23fa317...bacd83e1`). Background: the #651 verdicts (Opus [5964857917](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/651#issuecomment-5964857917), Sol [5964898255](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/651#issuecomment-5964898255)) for history only, the split notes on #651/#665, docs/roman-client-context.md and the binding rules for this stack (OR-115-1/2; no CoachingSession private notes, bloodwork, purchases or other users' rows; coaches never see Roman internals). No evidence reused from #651: none of my lens's prior verdicts was an APPROVE.

### What holds
- **Inert piece.** Nothing here is registered in a Nest module or reachable from a route. The one live change is `ClientAIContextService.invalidateForUser` -> `romanContextInvalidate` (`src/ai/client-ai-context.service.ts:110-111`). It is a plain module with no DI, so there is no AiModule<->RomanModule cycle. Listener errors are swallowed (`roman-context-invalidation.ts:26-32`), so a write path cannot break. With no listener registered until A2/C, it is a no-op.
- **Shape exclusions** (`roman-client-context.types.ts`). There is no field for email, phone, last name, raw ids, exact DOB, coach_notes_md, bloodwork, payments or wearable tokens. Bookings carry title, local time, duration and status only.
- **Consultation source** (`roman-consultation.source.ts:38-58`):
  - It reads only `client_id = caller`, with a belt-and-braces id check.
  - P0 consent is excluded through `buildConsultationView`.
  - A read failure throws rather than reporting a clear screen.
  - The onboarding chapters contain no bloodwork, medication or purchase item. I checked consultation-answers/-view on main.
- **Renderer** (`roman-client-context.renderer.ts:48-53`). `< > & U+2028 U+2029` are escaped as JSON unicode, so data cannot close `<client_data>`. The truncation order matches the doc, every drop is recorded, and the hash is taken over the exact rendered block.
- **Error tag** (`roman-error-tag.ts`). It uses a closed class allowlist, the Prisma code only through `safeDiagnostic`'s redacted message, and the numeric status. `err.message` is never logged.
- **Main drift.** 296 commits behind. `git merge-tree --write-tree origin/main eb7cb7a8` (A1+A2) is clean. None of the APIs these files use changed on main since d23fa317 (consultation-view, consultation-answers, orm-diagnostics, sanitize-prompt-input, client-ai-context), and the schema delta since then is money-only.
- **Size.** 1,832 lines (grandfathered, 3,000 ceiling). All PR checks are green at this head.

### B-667-1: a partly answered health screen is reported as completed, so the "screen not answered" safety rule never fires
- **Where:** `src/roman/context/roman-consultation.source.ts:85-88`.
  - The code sets `completed = view.screening.items.some(i => i.answer !== null)`.
  - Intake answers are saved by PATCH merge (`onboarding.service.ts:491-518` on main), so a client who answers P1 and leaves has a row with P1 = no and P2..P7 unset.
  - That row reads `safety_intake: { completed: true, clearance_recommended: false }`.
- **Why it matters:** the guardrail contract keys the conservative rule on exactly this flag. `roman-guardrail.contract.ts:47` in #666 says: "If safety_intake.completed is false (the health questions are not answered), never suggest increasing intensity…". With six health-screen questions unanswered, Roman treats the screen as clear and may step up intensity. This fails open on a T4 health-safety input.
- **Probe:** `B-667-1` in `test/roman/audit-opus-ra121.probe.spec.ts`, run on `audit/AUD-OPUS-RA-121/665-1` (RUN_LINK). This file is byte-identical at #665's head.
  - P1-only intake: expects `completed === false` and gets `true`.
  - Control: all 7 answered "no" gives `completed: true, clearance: false`, and passes.
- **Minimal fix:** `completed` is true only when every `SCREENING_KEYS` item has a yes/no answer (or, if the product prefers, when the intake's own `completed_at` is set). Keep `clearance_recommended` on any "yes" as today. Add the partial-screen case and the all-answered control as tests.

### C (follow-ups)
- **C-667-1 (doc and comment truth):** `docs/roman-client-context.md` is out of date in four places:
  - it says `ctx-v2`, but the code is `ctx-v3`;
  - "Never read: `CoachingSession`" contradicts the narrow booking select added in A2, which is the C-651-7 sentence fixed only in the service header;
  - it has no `upcoming_sessions` row;
  - the consultation row says C05 has not landed.

  `roman-client-context.types.ts:311-317` repeats the C05 sentence. Fix: update the doc and comment to the shipped behaviour.

### Day-1 requirement (coach pool debit + client daily cap)
A1 has no turn path, so nothing here should debit. Across #667-#670 (and the C2 source branch `agent115/roman-651-r2-wip-unsplit`) no file under `src/roman` references CoachAIBudget, `recordUsage` or `src/ai-credits`. The turn path is in #668, which the operator is handling separately (my report: ops/reports/AUD-OPUS-RA-121.md).

Head re-read immediately before posting: `bacd83e10ff0e00dc5165dd223da8b4745e3c82a`. No push to the PR branch, no merge, no production action.
