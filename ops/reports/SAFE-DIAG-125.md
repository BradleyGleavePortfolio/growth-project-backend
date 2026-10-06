# SAFE-DIAG-125 — Diagnostic AI safety pass (DIAGNOSTIC_AI_ENABLED, DIAGNOSTIC_RATE_LIMIT_PER_HOUR)

Status: DONE 15:07 PDT 10-06 (started 14:59). Claude Opus 5.5, T4 AI, read-only. No PR opened. No flag, config or production change.
Code read: backend origin/main a233a020 (RO-backend fetched; checkout itself at 1ce430b9), production ec12a4b3; mobile origin/main d16d5c15.

## Verdict: NO-GO for any flip — and nothing needs flipping. NOT ON in production (no URGENT).

- `DIAGNOSTIC_AI_ENABLED` does nothing in this backend. It is not a route kill switch. It only decides, inside
  `AiRoadmapService.generateAndPersist`, whether a mounted diagnostic submit calls Perplexity (src/diagnostic/ai-roadmap.service.ts:139,
  code default `'true'`). The module that holds it, `DiagnosticModule`, is deliberately NOT imported by AppModule
  (src/app.module.ts:72-77 and :340-341), so `/api/diagnostic/*` is not mounted and the AI call cannot run, whatever the Fly value is.
  Same in production: the switch-off commit 5d1f224a (b#644, B-QUIZ-OFF, 2026-10-02) is an ancestor of production ec12a4b3.
- Owner ruling 10-01 15:25 PDT (SoT C1 line ~7873 and the operator log "OWNER RULING — diagnostic quiz is another product's"): "the income
  quiz is for tgp-finance - TOTALLY UNRELATED - Doesnt go with tgp-fitness". The quiz (Income / Body / Lifestyle) belongs to another
  product. Turning it on would mean re-importing the module (a code change plus a deploy), which goes against that ruling and fails
  test/diagnostic-quiz-off.spec.ts (:87, :95, :125, :133). It is not a flag decision.
- Mobile: the 10-07 clinic build has no diagnostic UI and no `EXPO_PUBLIC_FF_*` for it (no match in src/, eas.json or
  src/config/featureFlags.ts on mobile main d16d5c15). Nothing a client or coach can reach.
- Flags to flip: NONE. `DIAGNOSTIC_RATE_LIMIT_PER_HOUR`: inert for the same reason (src/throttler/throttler.config.ts:208, :361 only
  configure an unused named throttler). It is not in the manifest, which is correct.

## Production probe (read-only, no auth, 15:01 PDT 10-06, https://api.trygrowthproject.com)
| Request | Status | Body (message) | Reading |
|---|---|---|---|
| GET /health | 200 | ok | app is up |
| GET /readyz | 200 | db up | app is up |
| GET /api/me/timeline (mounted, needs auth) | 401 | "No authentication token provided" | mounted routes answer 401 without a token; the global prefix is /api |
| GET /api/this-route-does-not-exist-safe-diag (control) | 404 | "Cannot GET /api/this-route-does-not-exist-safe-diag" | Express no-route 404 |
| GET /api/diagnostic/questions | 404 | "Cannot GET /api/diagnostic/questions" | NOT mounted. If mounted it is `@Public()` (diagnostic.controller.ts:42) and would answer 200 with the catalog |
| GET /api/diagnostic/00000000-0000-4000-8000-000000000000 | 404 | "Cannot GET /api/diagnostic/…" | NOT mounted (a mounted route would say `submission_not_found`, diagnostic.service.ts:153) |
| POST /api/diagnostic/submit with body `{}` | 404 | "Cannot POST /api/diagnostic/submit" | NOT mounted (a mounted route would answer 400 from DTO validation before any write; nothing was written) |
| GET /diagnostic/questions (no prefix) | 404 | "Cannot GET /diagnostic/questions" | not mounted at root either |

Conclusion: the diagnostic routes give the same router-level 404 as a path that does not exist. They do not give a guard 404, a 401 or a
200. These routes have no flag guard; they are either mounted or absent, and they are absent. The unknown Fly value of
`DIAGNOSTIC_AI_ENABLED` therefore does not matter. (OPTIONS on submit gave 204: CORS preflight middleware answers every path, so it
tells us nothing.)

## "R2b acceptance" (named in .github/fly-env-desired-state.json:166 "ledger: stays off until R2b")
- What it was: R2b = backend #626, "feat(ai-egress): R2b single AI egress gate enforcing the live box-2 AI consent grant (T4)". It is one
  gateway (src/ai-egress) that reads the client's live box-2 grant on every send and refuses with 403 ai_consent_required, blocks
  non-Anthropic client-data egress, and has a guard test stopping direct AI SDK use outside src/ai-egress (SoT operator log 10-01 14:45 and
  A7 day-1 table: gate "R2b dual-approved"; stay-OFF row "DIAGNOSTIC_AI_ENABLED … R2b AI enforcement not accepted yet").
- Met? YES. #626 was merged 2026-10-02 05:49Z (merge 7a6cfd82), which is an ancestor of production ec12a4b3, and
  `FEATURE_AI_CONSENT_LEDGER_ENABLED` = "true" (fly-env-desired-state.json:12). The diagnostic path goes through the gate with the
  no-client-data exemption `deidentified_prospect_scores` (ai-roadmap.service.ts:151-154; ai-egress.types.ts:40-41, :48;
  ai-egress.service.ts:185-190 returns without a consent read for exemptions).
- An owner question was open under R2b: "public diagnostic sends de-identified prospect scores to Perplexity without box 2: owner call
  (recommendation keep exemption and disclose Perplexity in the privacy policy)". The B-QUIZ-OFF ruling 45 minutes later replaced it.
  So the manifest note "stays off until R2b" is stale: R2b is met, and the real gate is the owner ruling plus the unmounted module.

## Safety checklist (verdict per item; "current" = production / main as they are; "if re-mounted" = what a future re-enable must fix)
| # | Item | Current | If re-mounted (hypothetical) | Evidence |
|---|---|---|---|---|
| 1 | Consent (ledger + box 2) | PASS (no call can run) | PASS by design: anonymous pre-signup lead, no client account, so box 2 does not apply; R2b exemption `deidentified_prospect_scores` | ai-roadmap.service.ts:85-88, :153; ai-egress.service.ts:185-190 |
| 2 | Data minimisation | PASS (no call) | PASS: the prompt holds only section scores, buckets, server-owned question text, integer answers 1-5 and today's date. No email, name, age, IP or user id. Other users' data never included | ai-roadmap.service.ts:91-131. Stored with email/name/age/IP/user agent in the DB only: diagnostic.service.ts:113-124 |
| 3 | Tenancy | PASS / N/A | N/A (no coach or community). The public `GET /:submissionId` uses the uuid as an access token and returns only scores, buckets and roadmap, not email | diagnostic.service.ts:172-181; README.md:106-109 |
| 4 | Human in the loop | PASS (nothing generated) | FAIL by checklist wording: the AI roadmap goes straight to the visitor with no coach review (fire-and-forget) | diagnostic.service.ts:131; ai-roadmap.service.ts:170-172 |
| 5 | Prompt injection | PASS | PASS: no visitor free text reaches the prompt (`name`/`source`/`email` are not used); answers are DTO-validated integers | diagnostic.dto.ts (IsInt/Min/Max on answers); ai-roadmap.service.ts:103-129 |
| 6 | Output validation | PASS (no output) | FAIL: no schema and no refusal check. Free text is split on blank lines, saved and served as-is; only max_tokens 700 bounds it | ai-roadmap.service.ts:165-172, :186-197 |
| 7 | Domain safety | PASS (no output) | FAIL: the Body Protocol section asks about weight, nutrition, sleep and body fat (seed-diagnostic.json Q16-27), but the system prompt has no medical, eating-disorder or crisis rules. `sonar-pro` is a web-search model | ai-roadmap.service.ts:35-50, :156 |
| 8 | Cost / rate limit | PASS (no call) | Partial: 5/hour per IP, keyed on the trusted Fly-Client-IP header, but no global or daily cap on an anonymous Perplexity spend. Not metered to any coach pool (no coach exists) | diagnostic.controller.ts:63-68; user-throttler.guard.ts:129-133; throttler.config.ts:208 |
| 9 | Kill switch | PASS: the real kill switch is "module not imported", proven live (probe above) and by test/diagnostic-quiz-off.spec.ts | FAIL as a kill switch: `DIAGNOSTIC_AI_ENABLED` defaults to on (`?? 'true'`); `false` only swaps in a placeholder roadmap, while routes stay up and still collect emails | ai-roadmap.service.ts:139-143, :224-235 |
| 10 | Logs | PASS | PASS: only provider error messages are logged (`err.message`), never the prompt or answers; the egress gate logs surface and reason only | ai-roadmap.service.ts:175; diagnostic.service.ts:132-135; ai-egress.service.ts:187-208 |
| 11 | Store / legal | PASS (no UI, no processing) | FAIL: the trust pages list Perplexity only for "generic milestone messages, if enabled"; the diagnostic text was taken out of the privacy policy by #611. Re-mounting would process lead emails and answers that the policy does not disclose | src/public-pages/trust-pages.html.ts:284; SoT #611 row |
| 12 | Mobile reachability | No UI in the 10-07 clinic build; no mobile flag. Turning it on would need a new build and a funnel (the other product has its own backend) | — | mobile origin/main d16d5c15: no match for diagnostic routes/screens in src/, eas.json or featureFlags.ts |

## B list
None. No normal user can reach the diagnostic: the routes are not mounted in production (probe) or on main, and there is no mobile UI.
The "if re-mounted" FAILs (items 4, 6, 7, 9, 11) are not Bs today. They are the entry list for any future re-enable, which the owner
ruling rules out for TGP Fitness.

## U list
None.

## C one-liners
- C: fly-env-desired-state.json:166 still says "stays off until R2b". R2b has been met since 10-02; the true reason is B-QUIZ-OFF
  (module unmounted, another product). Suggested note text (operator, manifest-only PR, no Fly change): "Inert: DiagnosticModule not
  mounted (B-QUIZ-OFF, owner 10-01 15:25); value irrelevant; leave excluded." env-validation.ts:476-484 and prod-switches.yml:485-496 say
  "Defaults to true" without the inert note that README.md:278-279 already has.
- C: soc2-evidence.service.ts:66-71 still lists DIAGNOSTIC_AI_ENABLED as a feature flag in the SOC2 snapshot. This is harmless, and it is
  also the one in-machine way to read the Fly value (admin-only `admin/soc2` controller) if the operator ever wants to settle the
  manifest's "unread value".
- C: production may still hold `diagnostic_submissions` lead rows from before 10-02. They are covered by account deletion (by user_id and
  by email: account-deletion.manifest.ts:236-237) and by export, per README.md:7-8. No action for launch.
- C (edge, deferred to 10k clients): diagnostic.controller.ts:83-84 records the client-supplied X-Forwarded-For as the stored IP. The
  throttle itself uses Fly-Client-IP. Unmounted anyway.

## Covered by open PRs
None needed. I checked all 45 open backend PRs: none touches src/diagnostic or re-imports DiagnosticModule. #427/#428 touch
src/app.module.ts for custom exercises only. #803 touches ai-egress.service.ts for the Anthropic thinking param only; the Perplexity path is
unchanged. There were 15 open mobile PRs: none has a diagnostic title.

## PRs opened
None (read-only pass; no blocker that needs a fix).

## Not fixed (needs operator)
Nothing blocks launch. Optional and non-urgent: a manifest note refresh at .github/fly-env-desired-state.json:166 (text above). It is
documentation only; `fly-env-sync` must not be run for it.

## HANDOFF
Complete. A fresh agent needs to do nothing more. If the owner ever asks to bring the diagnostic back to TGP Fitness: re-import
`DiagnosticModule` in src/app.module.ts, delete test/diagnostic-quiz-off.spec.ts, and first fix items 4/6/7/9/11 above (coach review or a
clear "general information" framing, output checks, medical/ED/crisis prompt rules, a real route flag that defaults off, and privacy
policy disclosure of Perplexity and lead-email storage), then run a fresh T4 dual audit.
