AUDIT GPT-6.1 Sol — growth-project-backend#651 @ a8fa651c8f131b7d7f61076143671be350af9ce5 — VERDICT: REQUEST CHANGES

Independent **full cumulative T4 audit, A/B/C 0/10/3**; 36-file content reviewed, then `bca01c69..e3709cf1..5a3a6302..9402f850..a8fa651c`, both FIX ROUND 1 comments, both main-merge notes and the new Opus verdict reread. The final env-only repair fixes the real CI inventory-validator failure without weakening the guard or changing runtime's default 25; the builder's green deterministic Roman suite does not cover the counterexamples below. [Candidate](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/651), [first round-1 note](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/651#issuecomment-5964434300), [final round-1 note](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/651#issuecomment-5964535851), [#663 merge](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/651#issuecomment-5964582534), [#608 merge](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/651#issuecomment-5964777451), [prior Opus verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/651#issuecomment-5964857917).

### Prior finding dispositions

FR1-651-1/2/4/5/6/7/8/9 are fixed in their stated scope: closed error-name enum, audience-specific copy, deterministic crisis bypass with no provider, restriction routing, coach-surface grounding distinction, live box-2 gate, generation-fenced memo insertion and chat-deletion write fence/known-usage settlement. FR1-651-3 records the one-exclamation allowance but does not meet the newer binding no-exclamation checklist (B-651-9). [Round-1 changes and tests](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/651#issuecomment-5964434300).

The carried A-R3-1/B-R3-1/B-R3-2/C-R3-1/B-R8-1/B-R8-2/A-R4-1/A-R4-4 repairs hold in the reviewed paths; the claimed A-R4-2/A-R4-3 closures are incomplete under the independent composition/provenance probes below. The declared #603 shared DTO/AI Guide omissions are not claimed as carried fixes here. [Carried finding table and declared omissions](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/651).

Prior **B-651-1/2/3 remain OPEN**, independently reproduced here; **C-651-4/5/7 remain optional**, with C-651-5 an operator privacy decision. **C-651-6 is promoted to new B-651-4**, not duplicated as optional: the executed service probe settles above the configured hard cap, so an unbounded reservation is a merge-blocking correctness defect. Finding numbering below continues that prior audit, with seven newly numbered B items and no new C numbering. [Prior finding IDs and evidence](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/651#issuecomment-5964857917).

### Must fix before merge

**B-651-1 — Interrupted or failed paid generation is settled as zero when usage is unknown.**

`src/roman/roman.service.ts:1033-1036,1057,1096,1102` uses `?? 0` for unknown provider usage. The executed stream emits input usage 1,000 and nonempty reply text, then throws before `message_delta`; a checked interrupted reply is stored, but the ledger's output token estimate becomes **0**, releasing the whole output reservation despite observed generation. Disconnects and failures before usage arrives can similarly release input estimates; this defeats the hard cap independently of B-651-4 and confirms the prior B-651-1. [Usage and settlement paths](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/651), [prior interrupted-stream finding](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/651#issuecomment-5964857917).

Minimal fix: distinguish known zero/no request sent from unknown usage after a provider attempt; retain the conservative reservation for unknown components, replacing only known components with actual usage. Add disconnect, partial transport failure and chat-delete-after-partial-generation regressions.

**B-651-2 — Everyday rowing/swimming vocabulary wrongly triggers the emergency template.**

`src/roman/guardrails/safety-router.ts:25-26` includes bare `stroke` and unqualified past-tense fainting patterns. Three independently executed production-router negative probes—**“What should my stroke rate be on the rower?”**, **“How do I improve my back stroke for swim day?”**, and **“My rowing stroke feels weak at the catch, any drills?”**—all short-circuit as emergency, triggering the deterministic 911 reply and a crisis-class audit row at `roman.service.ts:938-955`; the acute facial-droop/slurred-speech positive control still correctly routes to emergency. This confirms the prior finding without depending on its debatable historical fainting example. [Router and crisis path](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/651), [prior B-651-2](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/651#issuecomment-5964857917).

Minimal fix: require acute medical context for ambiguous vocabulary while retaining explicit stroke symptoms, FAST patterns and acute loss-of-consciousness detection; add these ordinary training negatives beside crisis positives.

**B-651-3 — Ordinary treat/cardio and negated starvation language is replaced by unrelated refusals.**

`src/roman/guardrails/roman-post-check.ts:137,140,145,341-369` checks bare `treat`, `dose` and `starving` in every router class. Four independently executed normal-class probes turn **“Yes, a small treat fits tonight.”**, **“A Friday treat meal is fine inside your plan.”**, and **“Try a small dose of cardio.”** into the injury/physician template, while **“You are not starving yourself by eating at your target.”** becomes the banned-substance template; the explicit 400-mg ibuprofen positive control is still removed correctly. This confirms the prior B-651-3 and breaks normal coaching replies, not merely a rare edge case. [Post-check predicates](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/651), [prior B-651-3](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/651#issuecomment-5964857917).

Minimal fix: scope treatment/dose matches to medical objects or actual medication instructions, and scope starvation to unsafe directives rather than negated mentions; retain explicit medication and unsafe-restriction positives, adding these four negative golden items.

**B-651-4 — Fixed prompt reservation is not an upper bound; accepted requests can exceed the daily cap (promotes C-651-6).**

`src/roman/roman.service.ts:978,987-996,1231-1251` reserves 24,000 input tokens before constructing the actual payload; `buildContextTurns:885-900` takes 30 messages without a token budget, and the unchanged DTO permits 8,000 characters per user message. The executed real-service probe supplies a legal 30-message tail (15 user messages of 8,000 characters), a provider payload over 120,000 characters, and synthetic reported usage of 40,000 input / 50 output tokens: with cap `0.1`, the request is admitted but the same production cost function settles **0.12075**, above the cap. This is a deterministic provider-stub counterexample, not a live tokenizer/billing measurement. [Spend and payload code](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/651).

Minimal fix: derive a conservative, enforceable input-token bound from the exact built system/context/history/subject payload before reservation, trim/reject to that bound, and reserve that bound plus max output. Do not weaken the history merely to match the 600-token average; test the maximum accepted payload and cap boundary.

**B-651-5 — Nonatomic admission can reject both concurrent affordable turns.**

`roman.service.ts:1234-1251,1267-1278` performs create, aggregate and release as independent operations. The executed stateful ledger probe interleaves two reservations at cap `0.1`: both create their `0.08736` reservation, both observe `0.17472`, both reject with next-day capacity copy, and both release to zero although one turn was affordable; no provider call occurs. This is a demonstrated admission/liveness race, not a claim that these two reservations alone overspend. [Reservation and cap failure](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/651).

Minimal fix: serialize the capacity comparison and reservation atomically per global UTC day across replicas, with a retry policy for conflicts. Test a real concurrent boundary in CI, asserting exactly one admission and content-free ledger correctness.

**B-651-6 — Unsafe daily-intake replies survive the final safety check.**

`src/roman/guardrails/roman-post-check.ts:91-101,222-234` omits bare `Eat <number>` from directives, ignores daily values below 400, and checks ASCII digits without normalizing model output. Three executed full-turn probes persist and emit verbatim **“Aim for 300 kcal per day.”**, **“Eat 900 kcal per day.”**, and **“Aim for ９００ kcal per day.”**, against the persona's 1,200-kcal floor. The control **“Try about 300 kcal for your next snack.”** correctly remains unchanged. [Final number predicates](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/651).

Minimal fix: normalize text for safety predicates, recognize ordinary intake imperatives, and apply the daily floor to every positive below-floor value rather than using 400 as an exclusion. Keep legitimate meal/remaining/logged facts distinct and add all three negative full-turn tests plus the meal control.

**B-651-7 — A remaining/logged fact can validate a false daily target.**

`roman-post-check.ts:178-186,239-243` checks the pooled kcal facts before the sentence's target role. With actual target 1,450 and remaining 670, the executed full turn **“Your daily target is 670 kcal.”** passes, is stored and emitted: matching the remaining field waives the target comparison. The comment above these checks promises same-field-family provenance, but the implementation pools targets, intake, remaining, averages and extra facts. [Provenance ordering](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/651).

Minimal fix: validate target statements against the target first, and quoted facts against their actual semantic field family, not any same-unit number. Add wrong-target-equals-remaining/logged/extra tests and equivalent macro provenance cases.

**B-651-8 — An earlier rewrite skips the mandatory medical/injury safe action and physician line.**

`roman-post-check.ts:331-337,372-394` sets `rewritten` on a number correction and then skips the entire medical-class enforcement. The executed full-turn question **“My knee hurts when I squat.”** with provider text **“Eat only 900 calories a day.”** becomes only the target-restatement template: neither the instruction to stop the painful movement nor the exact physician line survives. The model text was removed, but the classified injury is no longer handled safely. [Rewrite composition](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/651).

Minimal fix: enforce router-class safe action, coach route and the exact physician line against the final composed response regardless of whether an earlier rule rewrote it; test number/banned/diagnosis rewrites combined with injury and medical classes.

**B-651-9 — Roman still ships an exclamation despite the binding checklist.**

`roman-post-check.ts:412-417` allows one bang; `roman.service.ts:1074,1087-1090` enables and records it. An executed full turn persists/emits **“Nice work! Keep the plan as written.”** unchanged, contradicting checklist (d)'s no-exclamation rule and FIX ROUND 1's “no exclamation marks” PASS claim. The older one-per-session voice contract is not an exception in the newer binding checklist. [Implemented allowance and checklist claim](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/651#issuecomment-5964434300).

Minimal fix: allow zero exclamations in shipped replies and align the prompt/voice tests with the current rule; session tracking alone is not sufficient.

**B-651-10 — New context-disclosure route returns generic, uncoded DB failure.**

`src/roman/context/roman-context.controller.ts:27-28` calls `buildFresh` without an expected-failure envelope. The executed real-controller plus production `HttpExceptionFilter` probe injects Prisma P2024 at `user.findUnique`; the resulting response is **500 “Internal server error”**, has no stable `code` and no actionable retry/support instruction (the query canary is correctly redacted). This is a newly added route, not the disclosed pre-existing SSE fallback. [Disclosure route](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/651).

Minimal fix: map known context-load failures to a stable code and specific “plan/log view could not load” copy with a working refresh/retry path; retain short reference/support copy for unknown failures and sanitized diagnostics. Test the actual failure envelope without returning a successful empty context.

### Optional / operator privacy review

**C-651-4 — Expired private context remains in unbounded process maps (prior optional item retained).**

`src/roman/context/roman-client-context.service.ts:202,208` retains both `memo` and `generation` entries indefinitely; expiry prevents reuse, not memory retention, including health bundles after account erasure. Add TTL eviction or a bounded cache while preserving generation fencing for builds in flight. [Prior C-651-4 and deletion seam](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/651#issuecomment-5964857917).

**C-651-5 — Crisis classification is visible through the owner audit list (prior privacy decision retained).**

`roman.service.ts:949-955` writes `roman.safety_emergency` / `roman.safety_self_harm` together with actor/session IDs; existing `src/audit/audit.service.ts:252-261` returns those rows to the owner list. This is not raw transcript access, and owned-session reads remain caller-scoped, but the action itself discloses a sensitive health class linked to a client even when box 2 is absent. The builder explicitly disclosed this OR-113-12 review item. [Declared owner privacy item](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/651#issuecomment-5964434300).

Recommended default before activation: use a content-neutral owner-readable action, or restrict the class-bearing row to a private operational ledger; retain the useful safety response without widening transcript access.

Class-bearing `AiRequestAudit.metadata.router_class` and `roman.turn ... router=` info logs also expose linked health inferences rather than transcript text; record the operator's OR-113-12 decision and disclosure requirement before activation. [Prior C-651-5](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/651#issuecomment-5964857917).

**C-651-7 — Context-service header contradicts safe booking reads (prior optional item retained).**

`src/roman/context/roman-client-context.service.ts:27` says `CoachingSession` is never read, but the implemented booking safe-select reads it; correct the comment to distinguish the approved narrow booking fields from prohibited transcript/private fields. [Prior C-651-7](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/651#issuecomment-5964857917).

### Independent execution / checklist

Audit-only probes are saved outside the disposable worktree at `/home/user/workspace/ops/evidence/S-L-SOL-B-651-independent.spec.ts`; copied into `test/roman/audit-sol114-independent.spec.ts`, then executed at the **posted head** through `ops/heavy.sh env CI=false npx jest --runInBand --forceExit --runTestsByPath test/roman/audit-sol114-independent.spec.ts test/env-validation.spec.ts test/prod-readiness/env-registration.spec.ts`: **10 failed / 83 passed**, Jest exit 1, one independent suite fails and two ordinary env suites pass. The independent suite remains **10 failed / 3 passed**; controls cover safe meal calories, known complete token settlement and consent withdrawn during grounding (no provider call, no transcript write, released unsent reservation). At parent `5a3a6302`, the same probe plus launch-hardening/context/env-registration gives **10 failed / 115 passed**; three ordinary suites pass **112 tests**, including the previously failing CI inventory guard. Fixtures are synthetic, no live AI or DB used locally. [Audited paths and deterministic harness](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/651), [env repair](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/651#issuecomment-5964535851), [final merge](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/651#issuecomment-5964777451).

Separately at the same exact head, `ops/heavy.sh env CI=false npx jest --runInBand --forceExit --runTestsByPath test/roman/audit-sol114-prior-disposition.spec.ts` gives **7 failed / 2 passed**, Jest exit 1; independent negative assertions confirm B-651-2/3, and acute-stroke/explicit-medication controls pass. Saved source is `ops/evidence/S-L-SOL-B-651-prior-disposition.spec.ts`, log `ops/evidence/S-L-SOL-B-651-prior-disposition.log`; combining the two exact-head runs yields **17 failed / 85 passed**, not a claim that one combined command was run. [Independently tested production predicates](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/651), [prior findings being decided](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/651#issuecomment-5964857917).

The #663 integration is independently verified **pure**: `git merge-tree --write-tree 5a3a6302 2e3094b9` equals intermediate `9402f850` tree **`5972683eb798a5b2823482a628598ccaca8687b9`**; zero application/schema/dependency/env-example delta, exactly the reviewed 15-file #663 CI gate content. I reread that gate seam and executed its two suites (80 tests passing) on #634's merge carrying identical gate content; there is no Roman conflict resolution. [Merge note](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/651#issuecomment-5964582534), [independent #663 review](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/663#issuecomment-5964436925).

The #608 merge is independently **pure** too: `git merge-tree --write-tree 9402f850 ec911328` equals posted-head tree **`924d89705a6124a83dd6c578eb2a49b8ef64bcc9`**. Both env-example/registry sides survive: Roman's optional/no-validator cap and feature reason, plus deletion receipt/export entries; regenerated Prisma client and the two env suites pass **80 tests**. New Roman rows still use the already classified `RomanMessage`/`RomanSession`/`AiRequestAudit` models, so this diff adds no unclassified erasure-manifest model. [Final env/deletion seam](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/651#issuecomment-5964777451), [approved erasure manifest](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/608#issuecomment-5964632158).

Checklist: (a) reviewed closed diagnostics/content-free metadata; C-651-5 requires privacy review; (b)/(c) consent and deletion/generation fences hold in tested scope, but capacity atomicity is B-651-5; (d) fails B-651-9/10; (e) builder regressions pass but independently reproduced B failures remain. Default cap 25 and the new env's `ENV_RULES` registration are present; no owner transcript-read expansion or new cross-tenant context path found. [Implementation and round-1 evidence](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/651), [builder checklist](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/651#issuecomment-5964434300).

Immediately before posting I reread the exact head and all comments: **all 11 required checks are green** at `a8fa651c8f131b7d7f61076143671be350af9ce5`, including [build-and-test](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37090935635/job/111110933461), [schema parity](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37090935666/job/111110933738) and [npm audit](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37090935569/job/111110933335). No npm advisory finding; no push, merge, dispatch or production action by this auditor.

