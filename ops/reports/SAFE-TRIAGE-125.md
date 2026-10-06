# SAFE-TRIAGE-125 — Community AI triage safety pass (Claude Opus 5.5, T4 AI, agent 125)

Started 14:59 PDT (TZ=America/Los_Angeles date). Code read at backend origin/main a233a020 and mobile origin/main d16d5c1
(both moved past the brief's 1ce430b9 / a1904f2f; the triage files are unchanged by those merges). Production backend ec12a4b3.

## VERDICT: NO-GO for the 10-07 launch. GO AFTER FIXES for a later build.

Keep `FEATURE_COMMUNITY_AI_TRIAGE` unset (off). Flip nothing now. Reasons:
1. **No UI in the 10-07 build.** eas.json `clinic` (extends `production`) does not set `EXPO_PUBLIC_FF_COMMUNITY_AI_TRIAGE`, so
   `featureFlags.communityAiTriage` is false (src/config/featureFlags.ts:250) and the triage card never mounts
   (src/screens/community/CoachCommunityInboxScreen.tsx:79, :305, :345). Turning it on needs a later build.
2. **The AI gateway is off in production.** `AI_GATEWAY_ENABLED` is unset (absent from .github/fly-env-desired-state.json;
   ops/reports/FLAGS-D1-123.md:25 "AI_GATEWAY_ENABLED being unset"; not re-verified on the machine) and `AI_GATEWAY_CAPABILITIES`
   is unset, so `community_ai_triage` resolves to the stub (src/ai/gateway/ai-gateway.config.ts:36-60, :107). The stub reply is not
   JSON, so every call ends 503 `ai_triage_unavailable` ("Triage is unavailable right now"). Flipping only the triage flag gives a
   coach an error, never a triage (and sends nothing to Anthropic).
3. **B-1 crisis routing** (below) — fixed in backend #804; needs dual T4 lenses, merge and a deploy before any flip.
4. **Scope:** SoT A6 lists FEATURE_COMMUNITY_AI_TRIAGE as "Not in clinic scope / not reachable until S-REACH decides". Owner call.

**R2b acceptance: MET.** R2b = backend #626 (AI egress consent gate in the gateway; T4 dual audit; deploy with the ledger flag on).
#626 dual APPROVE @d9be0c0d, merged 10-01 22:48 -> 7a6cfd82 (SoT ops log); `git merge-base --is-ancestor 7a6cfd82 ec12a4b3` is true
(in production); `FEATURE_AI_CONSENT_LEDGER_ENABLED: "true"` (fly-env-desired-state.json:12). Triage filters authors by live box-2
grant before the prompt and the gateway re-checks at send. The manifest note "AI paths wait for R2b acceptance" (line 102) is
satisfied; the blockers are items 1-4 above.

**Exact flags for a later GO** (after #804 is merged and deployed, an owner yes on scope, and a build that carries the mobile flag):
- backend: `FEATURE_COMMUNITY_AI_TRIAGE=true` (needs `FEATURE_COMMUNITY_API=true`, already on); `AI_GATEWAY_ENABLED=true`;
  `AI_GATEWAY_PROVIDER=anthropic`; `AI_GATEWAY_CAPABILITIES=community_ai_triage` (exactly this name, not `*`; the gateway is shared
  with MWB AI live-create, so coordinate the list with SAFE-MWBAI-125); `ANTHROPIC_API_KEY` present (it is, per FLAGS-D1-123).
- mobile: `EXPO_PUBLIC_FF_COMMUNITY_AI_TRIAGE=true` in eas.json `clinic` (and `production`), then a new store build.

## Scope traced
- Mobile: Coach > Community inbox (CoachCommunityInboxScreen) -> InboxTriageBanner -> AiTriageCard (loading / error / AI refusal /
  empty / counts by category, expand/collapse); useInboxTriage (staleTime, retry false); communityAiTriageApi (Zod mirror).
- Backend: GET /community/ai-triage -> AiTriageController (JwtAuthGuard, RolesGuard coach/owner, CommunityFeatureFlagGuard,
  AiTriageFeatureFlagGuard, throttle) -> AiTriageService.generateForCoach -> CommunityCoachInboxRepository (coachedCohortIds,
  unansweredMessages, unansweredPosts) -> AiEgressService.consentedClients -> buildInboxTriagePrompt -> AiGatewayService.invoke
  (config resolve, assertRequesterMayActOn, egress.assertMaySend, budget gate, redaction, provider, usage record) -> strict Zod
  parse + one repair -> project() -> TriageCacheService.
- Consent copy (mobile src/lib/consultation/copy.ts:36, :40) and privacy page (src/public-pages/trust-pages.html.ts:270).
- The coach report queue (m#428, AUDIT-10-125) is a separate human path: reports, including "Self-harm or suicide", go to the
  moderation queue; triage does not read or change it.

## Safety checklist (main a233a020)
| # | Item | Verdict | Evidence |
|---|---|---|---|
| 1 | Consent | PASS | ai-triage.service.ts:143-144 keeps only authors with a live box-2 grant (scope base; ledger error = no grant, ai-egress.service.ts:238-241); gateway re-checks at send (ai-gateway.service.ts:224-238), bounded re-filter on withdrawal (service:184-187). Ledger ON in prod. |
| 2 | Data minimisation | PASS (C note) | Per item: id, kind, cohort name, author display name, first 240 chars (emails/phones/credentials redacted, ai-redaction.service.ts; gateway:279), age in hours (prompt.ts:83-99). Cohort scope only, DMs and comments-as-context excluded, coach/owner text excluded (inbox repository:72-78, :110-115). Nothing from users outside the coach's coached cohorts. Disclosed field-by-field on the privacy page. |
| 3 | Tenancy | PASS (U-2) | Roles coach/owner (controller:54); coachedCohortIds (repository:34-53); gateway requires every author to be the coach's client or delegated client, else 404 (gateway:526-546). |
| 4 | Human in the loop | PASS | Classify-only: GET, no messaging/materialiser/approval provider (module.ts:28-53), capability is not `draft.*`; the UI shows only counts; the human inbox below lists every item. |
| 5 | Prompt injection | PASS after #804 | Member text is inline but whitespace-collapsed (no line forging), no action surface, strict schema, ids reconciled (service:256-262). On main an instruction in one member's text could push other items (a crisis post too) to `no_action_needed` or out of the triage; #804 adds the data-not-instructions rule, the deterministic safety pin and never-drop. |
| 6 | Output validation | PASS | `.strict()` Zod (triage-output.schema.ts:48-76), exactly five buckets, one repair then 503 (service:194-216), fabricated ids dropped, response re-parsed (controller:62), tone guard (service:75-84, :292-303). |
| 7 | Domain safety | FAIL on main -> B-1, fixed in #804 | Prompt told the model "never imply a medical or emergency situation" (prompt.ts:47) with no crisis rule; no deterministic net; skipped items vanished. Never auto-actioned: PASS. |
| 8 | Cost | PASS (U-3) | 30/hour/coach throttle (controller:55-57); metered capability (ai-credits.constants.ts:63) with pre-call budget gate and usage record (gateway:244-275, :349-372); 5-minute cache keyed by the consented item set (service:148-168); maxTokens 1200; at most 100 items x 240 chars. |
| 9 | Kill switch | PASS backend (U-4 mobile) | Flag read per call, exact 'true' (feature.ts:25-27); off = byte-identical 404 (flag guard:31-43); community master off = 503. Mobile flag is build-time; with it on and the server off the card shows an error with Retry instead of hiding. |
| 10 | Logs | PASS | Service logs coach id, counts, model, prompt version, error messages only (service:166, :185, :188-190, :205-207, :212-214, :226-228); gateway persists hashes, not bodies (gateway:303-305); flag guard logs user id only. No member text or health data in logs. |
| 11 | Store / legal (5.1.2(i)) | PASS (C note) | Box 2 is optional, unticked, names Anthropic: "I allow Roman and my coach's AI tools to use my information, processed by Anthropic." (copy.ts:40); privacy page describes inbox sorting exactly, framed "If we turn it on" (trust-pages.html.ts:270); coach card labelled "AI triage" (AiTriageCard.tsx:96-102). No false claim. |
| 12 | Mobile reachability | NOT IN 10-07 BUILD | See verdict item 1. |

## B list
- **B-1 (safety / crisis routing, on flip) — FIXED in backend #804.** A client posts in their cohort that they keep thinking about
  hurting themselves; the coach's AI triage card counts it under "No action needed" (or drops it), so a coach skimming the card sees
  nothing that needs them. Main: ai-triage.service.ts:248-285 keeps the model's category and drops skipped items; prompt.ts:47 forbids
  emergency framing. Fix: deterministic `SAFETY_PATTERNS` on the FULL text (not the 240-char preview) pin self-harm, suicide,
  eating-disorder and acute-symptom items to `urgent` ("Needs you soon") with a neutral summary; prompt v2 rule.

## U list
- **U-1 — FIXED in #804.** An item the model skips vanishes, so "N unanswered items" undercounts. Now lands in `general`.
- **U-2 — not fixed (latent, only after flip + build).** A coach who is a coach/assistant member of a cohort holding someone else's
  clients (sub-coach in the head coach's cohort, or a member who changed coach) gets "Triage is unavailable" every time: the gateway
  404s the whole prompt (gateway:545) and the service maps it to 503 (service:238-240). Smallest fix: in triageOnce, after the consent
  filter, keep only authors with `coach_id = coach` or a live SubCoachAssignment (same query as gateway:532-544); ~25 lines, T4.
- **U-3 — not fixed.** When the coach AI budget is spent the card says "Triage is unavailable right now" instead of the budget
  message: `unavailable()` (service:238-240) swallows CoachAiBudgetExhaustedException. Smallest fix: rethrow it; ~3 lines + test.
- **U-4 — not fixed (mobile, future build).** With the build flag on and the server flag off, the card shows an error with Retry
  rather than hiding (CoachCommunityInboxScreen.tsx:80-110). Smallest fix: treat 404 `community.ai_triage.disabled` as hidden.
- **U-5 — not fixed (mobile, future build).** The card title "N unanswered items" (AiTriageCard.tsx, header) counts only members
  who ticked box 2, while the inbox below lists everyone; "Nothing to triage right now" can show over a full inbox. Smallest fix:
  "N sorted" plus one line "Only members who allowed AI are sorted."

## C one-liners
- Author display names are sent although classification does not need them (disclosed on the privacy page; opaque labels later).
- Safety patterns over-match hyperbole ("going to die after leg day"): moves an item up, never down. C (accepted).
- Consent paragraph (copy.ts:36) names Roman and AI drafts, not community sorting; the checkbox covers "my coach's AI tools". Mention
  it at the next copy revision.
- Out of triage scope, for the operator: a member's own self-harm post in the community gets no crisis resources at write time
  (no 988 line, as Roman has); only the coach's inbox and member reports reach a human. Not analysed here; route to the community lane.
- Timeout (30 s) does not cancel the provider call; repair doubles a call's cost. C (edge, deferred to 10k clients).

## Covered by open PRs
- None. Stale open #605 (R8 eval harness, 10-01) edits ai-triage.service.ts with an older consent gate superseded by #626; named in
  #804's body, no functional overlap.

## PRs opened
- backend #804 https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/804 — branch agent125/safe-triage-crisis-urgent,
  head 7b54b145e068b8f1cafec50cf2078033aae9fd3b, 181 changed lines (+167 -14, 3 files, 106 of them tests). Local: ai-triage.service
  spec 32/32 (5 new), trust-pages spec 48/48. CI at this head: 15 SUCCESS, 1 SKIPPED (deploy-readiness-gate, by design),
  build-and-test green. READY FOR AUDIT posted 15:22:
  https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/804#issuecomment-6026530534

## Not fixed (needs operator)
- U-2, U-3 (backend, T4/T2, small) and U-4, U-5 (mobile, future build) as above.
- Decision: whether community AI triage is in scope at all after launch (SoT A6 says not in clinic scope). Recommended default: keep off
  through 10-07 and 1.0.1; revisit with S-REACH once #804 is deployed.
- Gateway enablement is shared with MWB AI live-create: one owner for AI_GATEWAY_ENABLED / AI_GATEWAY_CAPABILITIES (SAFE-MWBAI-125).

## HANDOFF
- DONE 15:22. #804 @ 7b54b145 CI green, READY FOR AUDIT posted. Worktree removed after push (branch agent125/safe-triage-crisis-urgent
  is on origin). No ci/* lane branches were created.
- Next (operator): dual T4 lenses on #804 at 7b54b145, merge, deploy with the next backend deploy. FEATURE_COMMUNITY_AI_TRIAGE stays off.
- Later (owner): scope decision; then U-2/U-3 backend and U-4/U-5 mobile, gateway allow-list `community_ai_triage`, mobile flag + build.
