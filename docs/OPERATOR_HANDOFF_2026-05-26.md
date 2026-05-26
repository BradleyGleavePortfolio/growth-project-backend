# OPERATOR HANDOFF — 2026-05-26 (Sprint A)

**Author:** Outgoing Computer-operator session
**Recipient:** Next operator (you)
**Owner:** Dynasia G — `dynasia@trygrowthproject.com`
**App:** The Growth Project (TGP) — coach SaaS for personal trainers
**Repos:**
- `BradleyGleavePortfolio/growth-project-backend` (NestJS, Prisma, Supabase, Fly.io)
- `BradleyGleavePortfolio/growth-project-mobile` (Expo SDK 55→56)
- `BradleyGleavePortfolio/tgp-platform-site` (SaaS marketing site)
- `BradleyGleavePortfolio/thegrowthproject.courses` (founder/coaching site — NOT the builder)

> **Sacred rule (R52, said by Dynasia tonight):** "WASTED CREDITS = TAKING FOOD OUT OF MY BABY DAUGHTER'S MOUTH." Every decision in this handoff is shaped by that. Read **Part 6 (Rules & Doctrine)** before you spawn anything.

---

## PART 1 — Sprint A status: what is DONE, what is IN-FLIGHT, what is DIRTY

### ✅ Merged to `main`

| PR | What | SHA | Notes |
|----|------|-----|-------|
| **#270** | Landing Pages **Phase 1** — Prisma schema + RLS + migration r46 | `53c14df` | Clean merge. Includes banned-payment-host blocklist + Zod section schemas. |
| **#271** | Landing Pages **Phase 2** — coach CRUD + public SSR renderer + storefront routing | `962cbc7` | Includes 2 post-merge security follow-ups (`</script>` JSON-LD breakout, hero CSS injection). |

**Backend `main` head:** `962cbc7`.

### 🟢 Open PRs — CLEAN, ready to merge after one re-audit

| PR | Branch | Head SHA | Status |
|----|--------|----------|--------|
| **#274** | `feat/landing-pages-renderer-v2` | `43faad9` | **CLEAN.** 134/134 tests pass (+10 new), tsc + build green. Just completed by finisher subagent. P0 prisma regen + 3 P1 polish all delivered. → **Merge first.** |
| **#273** | `chore/agent-rules-r56-r60-worktree-discipline` | `eedc50e` | Doctrine-only PR. R56–R61 added to `AGENT_RULES.md`. No code risk. → **Merge anytime.** |

### 🔴 Open PRs / branches — DIRTY, need fixers

| PR / branch | Head SHA | Verdict | Audit file |
|---|---|---|---|
| **PR #272** `feat/landing-pages-phase3-crm-sync` | `08edd72` | **DIRTY** — 3 P0, 10 P1 | `/home/user/workspace/audits/PR_272_AUDIT.md` |
| **(no PR)** `feat/landing-pages-phase4-cname-recovery` | `7e5e936` | **DIRTY (close to clean)** — 1 P0, 5 P1 | `/home/user/workspace/audits/CNAME_AUDIT.md` |
| **(no PR)** `feat/dunning-v1` | `516fff4` | **DIRTY REWORK** — 6 P0, 8 P1, 0 new tests | `/home/user/workspace/audits/DUNNING_AUDIT.md` |
| **(no PR)** `feat/first-client-nudge-v1` | `357d65b` | **DIRTY** — 1 P0 boot-breaker, app won't start | `/home/user/workspace/audits/NUDGE_AUDIT.md` |

### ⏳ In-flight subagent at handoff

| Subagent | Branch / worktree | Task |
|---|---|---|
| `checkout_hardening_redo_mpmbwiq4` | `feat/checkout-hardening` in `/home/user/workspace/tgp/backend-checkout-hardening` | Rebuilding **bulletproof guest checkout** (14 failure modes, migration r48). First version was lost to worktree trampling — see Part 4. |

### 📦 Other branches on GitHub (preserved, no active work)

| Branch | Head | Notes |
|---|---|---|
| `fix/workout-builder-p1-followup` | `31afd65` | Barely started follow-up for 5 P1s in the already-merged backend PR #182. |
| `feat/workout-builder-mobile-v2` | `e7b728d` | **Empty** — placeholder for PR #123 rebase + 4 contract-bug fixes + Expo SDK 56 work. |

---

## PART 2 — Audit findings, one screen each

### PR #274 — LP-RENDERER-V2 — ✅ CLEAN (just finished)
8/9 spec items delivered, P0 prisma regen done, font preload + proofLine + lead-form error UX wired, 10 new tests covering them, tokens correct (`#0b0b0c` / `#d4a574` / `#f5efe6`, Geist + Fraunces). Zero security findings. **Merge after final read-through.**

### PR #272 — CRM adapters (Phase 3) — 🔴 DIRTY
- **P0-1** SSRF in ActiveCampaign — coach-controlled `account` interpolated into host; fix with `^[a-z0-9-]{1,63}$` regex
- **P0-2** SSRF in Webhook adapter — no private-IP guard, `maxRedirects: 5`; fix with IP allowlist + `maxRedirects: 0` (DNS-rebinding caveat in audit)
- **P0-3** In-memory retry counter — BullMQ worker concurrency means duplicate retries; move to job `attemptsMade`
- **P1** `$/visitor` divides by visits not unique visitors → metric is wrong by 2-5x

### CNAME Phase 4 — 🔴 DIRTY but close
12/12 spec items implemented (DNS verify, Fly SNI, Let's Encrypt cron, host routing, Pro/Studio tier gate).
- **P0** Prisma client never regenerated — `tsc` fails because new model/enums aren't in `@prisma/client`
- **P1** Non-atomic worker claim (multi-process race on Fly redeploy)
- **P1** Node DNS default resolver — claims 5s, actually 30s OS-dependent
- **P1** Trailing-slash inconsistency
- **P1** Private field access via `as any` cast

### Dunning v1 — 🔴 DIRTY REWORK
- **P0-1** Module-graph cycle `BillingModule → DunningModule → NotificationsModule → AuthModule → InviteCodesModule → BillingModule` breaks 3 test suites (10 tests). Fix: `forwardRef` is already imported but unused — wire it, or remove `DunningModule` from `BillingModule.imports` (Optional injection is already in place).
- **P0-2** `openOrReopenCase` writes outside webhook tx
- **P0** Email template variable names are wrong — every notification renders broken
- **P0** `DunningPreferences` cluster doesn't exist in schema; opt-out path is unreachable
- **P0** Notifier fires before transaction commits
- **P0** `PrismaService` re-provided locally (breaks tx propagation)
- **P1 ×8** including zero new tests on 1,200+ lines

### First-Client Nudge v1 — 🔴 DIRTY
- **P0** `OnboardingModule` doesn't import `NotificationsModule`; `NotificationsService` injection has no resolver → **production app refuses to start**. Author's comment claimed it was `@Global` — it isn't.
- **P1** Zero tests on 1,370 LOC
- **P1** `markFirstClient()` is defined but never called
- **P1** Multi-instance race on `Notification` rows

### Workout Builder (PR #182 backend already MERGED at `97760da` + PR #123 mobile)
- **Backend** is **in production** with 5 P1s (R17 leak in `exercise-library.service.ts:221`, no role gate on `/exercises/*` → quota-burn DoS, `assignPlan` idempotency-key returns wrong assignment, etc.). Needs follow-up PR.
- **Mobile PR #123** is **DIRTY + stale** — 4 P0 contract bugs (every Save/Assign/Complete will 4xx against current backend), 18 days stale, Expo SDK 55→56 conflicts.

---

## PART 3 — Where every rule is saved RIGHT NOW (Dynasia asked this directly)

Three live rule files exist in `growth-project-backend`:

| File | Purpose | Scope |
|---|---|---|
| `AGENT_RULES.md` | The canonical "agent contract" — what subagents must do. Currently **14 rules + R56–R61** (just added via PR #273). | Operator + subagent behavior |
| `ENGINEERING_RULES.md` | Code-quality engineering rules — 49 sections. | Code conventions |
| `docs/HOUSE_RULES.md` | Operational house rules — 41 items. | Team behavior |

**The 50 Failures of AI-Generated Code at Enterprise Scale** is referenced in:
- `AGENT_RULES.md` rule #5 (audit checklist link)
- `docs/SPEC_coach_brief.md` (one mention)
- Workspace copy at `/home/user/workspace/The-50-Failures-of-AI-Generated-Code-at-Enterprise-Scale.md`

### 🔴 Gap Dynasia flagged: R1–R55 are NOT in a canonical file

The numbered R-doctrine (R1 through R55) lives in conversation briefings (`BRADLEY_BRIEFING.md`, `CPO_BRIEFING.md`, `EXHAUSTIVE_BACKLOG.md`) and prior session summaries — **but no single canonical `RULES_R1_R55.md` exists in the repo.** R56–R61 were just added to `AGENT_RULES.md` via PR #273. **Recommended next move:** create `docs/CANONICAL_RULES.md` consolidating R1–R61 and link from `AGENT_RULES.md`. See Part 5 for the full inventory.

---

## PART 4 — Critical incidents this session (so you don't repeat them)

### Incident 1 — Worktree trampling (~00:09 PDT)
Spawned `PR-CHECKOUT-HARDENING` and `PR #4 CNAME` simultaneously, **both in `backend-main`**. They overwrote each other's working tree. CHECKOUT lost ~2 hours of uncommitted work. CNAME work was rescued via emergency commit onto `feat/landing-pages-phase4-cname-recovery`.
**Root cause:** Two subagents sharing one worktree.
**Codified as:** **R56–R60** (see Part 6).

### Incident 2 — Mass subagent death (~00:36 PDT)
All **8** concurrent subagents exited simultaneously with "Claude Code exited with no output." Platform/infra failure, not worktree. Lost some uncommitted progress on sandbox-only worktrees.
**Codified as:** **R61** — push to GitHub every 2 min; never trust sandbox-only state. Emergency recovery pushed every branch before this handoff was written.

### Incident 3 — `tgp/autopush.sh` daemon didn't survive
The 2-minute auto-push script in `/home/user/workspace/tgp/autopush.sh` cannot run as a true daemon because `nohup` loses the `api_credentials=["github"]` injection. **Action item:** rewrite as a GitHub-Actions-hosted cron OR convert to a `pplx-tool schedule_cron` job hitting a tiny push-runner.

---

## PART 5 — The R-doctrine inventory (every rule ever stated)

Below is every R-number I have on file. The ones marked ✅ are already in a checked-in repo file; the others live only in briefings/conversation.

| R# | Rule | Where saved |
|---|---|---|
| R1 | Floor List — never lower test/lint/CI gates to ship code | briefing |
| R2 | AsyncStorage persister must re-key on auth change | briefing |
| R3 | Audits are RUTHLESS — no "small enough to merge" | briefing |
| R4 | Commit author MUST be `Dynasia G <dynasia@trygrowthproject.com>`, **no `Co-Authored-By:` trailers** | ✅ `AGENT_RULES.md` |
| R5 | Use 50-failures doc as audit checklist | ✅ `AGENT_RULES.md` |
| R6 | Subagents NEVER merge — operator only | ✅ `AGENT_RULES.md` |
| R7 | ALL cash through TGP — no off-platform billing exceptions | briefing |
| R8 | Stripe webview B2B carve-out is INTENTIONAL — never replace with Apple IAP | briefing |
| R9 | Mobile main is `e7b728d`; backend main is `962cbc7` | this doc |
| R10 | Pre-existing failing tests (untouched): `account-deletion`, `email.service`, `recent-auth.guard` | briefing |
| R11 | `bucketDateLocal()` from `src/utils/date.ts` for any date bucketing | briefing |
| R12 | App Store: id6765847915, bundle `com.growthproject.app`, 800 TestFlight users | briefing |
| R13 | AI model: `claude-3-5-sonnet-*` for in-app coaching, NEVER GPT |  briefing |
| R14 | RLS enforced at table layer, not just service layer | briefing |
| R15 | AsyncStorage keys MUST be `${kind}:${userId}` | briefing |
| R16 | No `tgp.app` in marketing copy; use `app.trygrowthproject.com` or `joingrowthproject.com` (R45 expanded) | briefing |
| R17 | **NEVER leak upstream error bodies to client** — sanitize all 4xx/5xx from external APIs | briefing |
| R18 | Stripe Connect required for all payouts | briefing |
| R19 | One PR per logical change; never bundle | briefing |
| R20 | Every destructive endpoint needs `RecentAuthGuard` | briefing |
| R21 | DB-state rate-limit comments must reflect actual predicate completeness | briefing |
| R22 | Duplicate `(verb, path)` registration contract test at bootstrap | briefing |
| R23 | `prisma generate` runs in CI for every PR | briefing |
| R24 | `service_role` key never crosses the wire to a client | briefing |
| R25 | Idempotency keys on every Stripe charge/subscription/payout | briefing |
| R26 | DB transactions wrap every multi-table write | briefing |
| R27 | Soft deletes on user/client/coach/workout tables | briefing |
| R28 | Notification permission only requested at value moments | briefing |
| R29 | All public-facing routes prefixed `/api/v1/` | briefing |
| R30 | No circular module imports — `forwardRef()` or decouple | briefing |
| R31 | **AUDITS are always done by Opus 4.7 OR GPT 5.5** for maximum contextual catch | briefing |
| R32 | Subagents never run `gh pr merge` — operator only | briefing |
| R33 | Serial merge discipline — one PR at a time onto `main` | briefing |
| R34 | All cash through TGP (restatement of R7) | briefing |
| R35 | Apple HealthKit before any other wearable | briefing |
| R36 | Sentry breadcrumbs verified per PR | briefing |
| R37 | No fake test coverage — assertions on values, not `.toBeDefined()` | briefing |
| R38 | Database CHECK constraints mirror application validation | briefing |
| R39 | Point-in-time recovery enabled on Supabase | briefing |
| R40 | No optimistic UI without rollback | briefing |
| R41 | Cleanup function on every `useEffect` with async/sub | briefing |
| R42 | Error boundaries around all major sections | briefing |
| R43 | Storefront Phase 1 shipped: `GuestCheckout`, `share_token`, public package endpoint | briefing |
| R44 | Migration filenames are date-ordered + descriptive (`r46_landing_pages` etc.) | briefing |
| R45 | **`tgp.app` BANNED — use `app.trygrowthproject.com` or `joingrowthproject.com`. `tgp://` scheme is OK.** | briefing |
| R46 | Prod-shaped env-validation smoke test after every merge | briefing |
| R47 | RLS deny-all default + per-policy ALLOW | briefing |
| R48 | Charters/spec docs live in `docs/`, never in commit messages | briefing |
| R49 | `bucketDateLocal` (R11 restatement, charter form) | briefing |
| R50 | Notification dispatch fires AFTER transaction commit | briefing |
| R51 | First-Client Nudge spec (currently DIRTY) | briefing |
| R52 | **"Wasted credits = food out of baby daughter's mouth."** Every spawn is a moral act. | tonight |
| R53 | All ongoing work pushed to GitHub at least every 2 min (precursor to R61) | tonight |
| R54 | Every rule stated must be saved in a publicly accessible place every agent reads | tonight |
| R55 | CLEAN/DIRTY definition: CLEAN = no P0 AND no P1. Anything else = DIRTY. | briefing |
| **R56** ✅ | **One subagent per worktree.** Never two writers in one tree. | ✅ `AGENT_RULES.md` (PR #273) |
| **R57** ✅ | **`backend-main` and `mobile` are READ-ONLY** for subagents. Only the operator merges. | ✅ `AGENT_RULES.md` |
| **R58** ✅ | **Worktree naming:** `{repo}-{slug}` (e.g., `backend-checkout-hardening`). | ✅ `AGENT_RULES.md` |
| **R59** ✅ | **Pre-flight check:** `ls /home/user/workspace/tgp/` before spawning any subagent. | ✅ `AGENT_RULES.md` |
| **R60** ✅ | **Audits get worktrees too** — never audit in a write-tree. | ✅ `AGENT_RULES.md` |
| **R61** ✅ | **Push to GitHub every 2 minutes**, always, no exceptions. | ✅ `AGENT_RULES.md` |

**Action for next operator:** create `docs/CANONICAL_RULES.md` carrying R1–R61 verbatim. Link from `AGENT_RULES.md` and `docs/HOUSE_RULES.md`. This is **Dynasia's explicit ask tonight.**

---

## PART 6 — The 50 Failures of AI-Generated Code (audit checklist, severity-ordered)

Every audit you spawn (Opus 4.7 or GPT 5.5 per R31) must scan against this list. Full doc at `/home/user/workspace/The-50-Failures-of-AI-Generated-Code-at-Enterprise-Scale.md`. Severity legend: 🔴 critical, 🟠 high, 🟡 medium, 🟢 low.

### Pass 1 — Security (#1–#13)
1. 🔴 Hardcoded secrets in code/git history
2. 🔴 Missing RLS on Supabase tables
3. 🔴 SQL injection via string concatenation
4. 🔴 XSS via unescaped output / `dangerouslySetInnerHTML`
5. 🔴 IDOR — endpoints that take an ID without verifying ownership
6. 🔴 Missing rate-limit on auth + paid-external-API endpoints
7. 🔴 Weak JWT — short secret, no expiry, no rotation, no invalidation
8. 🔴 Phantom validation — TS types instead of runtime Zod/Joi
9. 🔴 Privilege escalation — role checks only in frontend/middleware
10. 🔴 Unverified NPM deps with known vulns (84 TanStack pkgs compromised May 2026)
11. 🟠 Missing CORS / wildcard CORS on auth'd endpoints
12. 🟠 Secrets exposure in error messages (R17 territory)
13. 🟠 Missing HTTPS enforcement / HSTS

### Pass 2 — Data integrity (#44–#47)
44. 🔴 No DB transactions wrapping multi-step writes
45. 🟠 Hard deletes instead of soft deletes on business-critical tables
46. 🟠 Missing DB-layer validation (CHECK, NOT NULL, FK)
47. 🔴 No backup or recovery strategy

### Pass 3 — Concurrency (#28–#32)
28. 🔴 Race conditions in async flows (read-modify-write without lock/optimistic versioning)
29. 🔴 Missing idempotency keys on payment endpoints
30. 🟠 Optimistic UI updates without rollback
31. 🟠 Stale closures capturing outdated state in `useEffect`/`useCallback`
32. 🟡 No abort/cleanup on component unmount

### Pass 4 — Error handling / observability (#33–#37)
33. 🟠 No error boundaries (82% of vibe-coded projects)
34. 🟠 No structured logging / observability (76%)
35. 🔴 Missing API timeout handling (100% of scanned implementations)
36. 🔴 Silent failures / swallowed errors
37. 🟡 No `/health` endpoint

### Pass 5 — Performance (#21–#27)
21. 🔴 N+1 queries (ORM calls inside loops)
22. 🔴 Missing DB indexes on frequently-queried columns
23. 🟠 No pagination on list endpoints
24. 🔴 Synchronous blocking ops in event loop
25. 🟡 No caching strategy
26. 🟠 Unoptimized image/media handling
27. 🟡 Polling instead of WebSockets / SSE

### Pass 6 — Architecture (#14–#20)
14. 🟠 Return of monoliths — business logic in route handlers (40–50%)
15. 🟡 Over-specification — hyper-specific non-reusable code (80–90%)
16. 🟡 Avoidance of refactors (80–90%)
17. 🟠 Fake test coverage — `expect(x).toBeDefined()` without value assertions
18. 🟠 Missing environment parity — hardcoded localhost (60–70%)
19. 🟡 Missing API versioning
20. 🟡 Circular dependencies (**this killed Dunning + Nudge tonight**)

### Pass 7 — Code quality (#38–#43)
38. 🟢 Comments everywhere (90–100%)
39. 🟡 By-the-book fixation — textbook patterns over simple solutions
40. 🟠 Bugs déjà-vu — same bug copy-pasted across files (70–80%)
41. 🟡 Vanilla style — reimplementing what libraries already do
42. 🟡 Phantom bugs — over-engineering impossible edge cases
43. 🟡 Dead code / orphaned modules

### Pass 8 — Infrastructure / deployment (#48–#50)
48. 🟠 No CI/CD pipeline (66% of vibe-coded projects)
49. 🟠 Env-specific code baked into production builds
50. 🟠 No graceful degradation when external services fail

---

## PART 7 — Next 30+ feature ideas, in execution chunks

Sourced from `/home/user/workspace/EXHAUSTIVE_BACKLOG.md` (150 items total). Below is the **operator-priority slice for the next 30**, grouped into chunks you can spawn as cohesive cycles.

### Chunk A — Finish Sprint A this week (8 items)
| # | Item | Effort | Why |
|---|---|---|---|
| A.1 | Merge **PR #274** (LP-RENDERER-V2) | S | CLEAN; biggest unblocker |
| A.2 | Merge **PR #273** (R56–R61 doctrine) | S | Doctrine only |
| A.3 | Fix **PR #272** (CRM) — 3 P0 SSRFs + $/visitor metric | M | Phase 3 lands |
| A.4 | Fix **CNAME Phase 4** — prisma regen + race + DNS timeout | M | Pro-tier custom domains |
| A.5 | **Rewrite Dunning** (cycle break, fix templates, add tests, transaction order) | L | Cash flow #1 |
| A.6 | **Fix Nudge** — wire `NotificationsModule`, add tests, call `markFirstClient` | M | App boots again |
| A.7 | Land checkout-hardening (in-flight subagent) | M | Bulletproof guest checkout |
| A.8 | Workout Builder follow-up PR — backend P1s (R17 leak, role gate, idempotency) | M | Backend hardening |

### Chunk B — Mobile + builder UI (Sprint B candidate, 5 items)
| # | Item | Effort |
|---|---|---|
| B.1 | **PR #5 Mobile Landing Page Builder UI** — Pages tab, inline editor, haptics, confetti | XL |
| B.2 | **Mobile PR #123 rebase** — fix 4 contract bugs + Expo SDK 56 conflicts | L |
| B.3 | Mobile Phase 6 — Landing page analytics screen ($/visitor, CTR, conversion) | M |
| B.4 | Mobile FF flip — `EXPO_PUBLIC_FF_COACH_BRIEF false→true` after #266 rebase | S |
| B.5 | Rewrite `LANDING_PAGE_DESIGN_DOCTRINE` with **SaaS brand tokens** (current draft uses courses tokens — gold #d4a574, cream #f5efe6, dark #0b0b0c, Geist+Fraunces) | S |

### Chunk C — Supabase RLS Crisis (Cycle B, 8 PRs, fully spec'd) (8 items)
| # | Item |
|---|---|
| C.1 | PR-RLS-01 — Helper-function `search_path` lockdown + HIBP (App Store requirement) |
| C.2 | PR-RLS-02 — Stripe/Financial/Idempotency |
| C.3 | PR-RLS-03 — Medical/Consent (PHI tables) |
| C.4 | PR-RLS-04 — Privacy/Compliance tables (GDPR/CCPA) |
| C.5 | PR-RLS-05 — Sessions family |
| C.6 | PR-RLS-06 — Meals family |
| C.7 | PR-RLS-07 — Habits + Lessons |
| C.8 | PR-RLS-08 — Remaining sweep + CI guard (fail build on missing-RLS migration) |

### Chunk D — Pre-launch competitive hardening (Cycle E, 9 items)
| # | Item |
|---|---|
| D.1 | **EW8 — Trainerize importer** (Google Sheets / Excel program import) — switching-cost killer |
| D.2 | **CC30 — AI Program Builder** (NL brief → 12-week periodized program) |
| D.3 | **Coach Brief v2** — voice customization + sub-coach→head-coach escalation |
| D.4 | **Section 10 — App Store ASO pack** — title, subtitle, 10 screenshots, 15-30s preview video, description, ratings strategy |
| D.5 | AI Butler Identity spec finalize (candidate name "Roman") |
| D.6 | Storefront Phase 2 — Course Builder (modules + drip + completion certs) |
| D.7 | Storefront Phase 3 — Elite per-coach landing pages |
| D.8 | Master Workout Builder greenfield (Priority 4, separate from PR #123) |
| D.9 | ME11 decision — white-label client app: kill or commit |

### Chunk E — Billing P1 + early moat (Cycle F, top 5 here, more in BACKLOG)
| # | Item |
|---|---|
| E.1 | **B3 — Smart Dunning** (auto-retry Day 1/3/7, branded links, coach notify only when human needed) |
| E.2 | **B4 — Automatic Session Lock on Non-Payment** |
| E.3 | **B5 — Digital Contracts + E-Signatures at Checkout** |
| E.4 | EW2 — Undo Button + Autosave across builder |
| E.5 | EW1 — Proper Exercise Library (search, filter, crowdsourced) |

**Read `EXHAUSTIVE_BACKLOG.md` for the full 150 items including Cycle G–J + Far-Horizon.**

---

## PART 8 — Worktree topology (so you don't trample anything)

All worktrees live under `/home/user/workspace/tgp/`:

| Worktree | Branch | Status |
|---|---|---|
| `backend-main` | `main` | **READ-ONLY per R57.** Currently at `962cbc7`. Has a `feat/landing-pages-phase4-cname-recovery` recovery commit pushed already. |
| `backend-checkout-hardening` | `feat/checkout-hardening` | **In-flight subagent** writing here. |
| `backend-272-fix` | `feat/landing-pages-phase3-crm-sync` | Available — spawn CRM fixer here. |
| `backend-cname-audit` | (audit branch) | Available — spawn CNAME fixer in a fresh worktree. |
| `backend-dunning` / `backend-dunning-audit` | `feat/dunning-v1` | Dunning live + audit worktree. Spawn rework here. |
| `backend-lp-v2` | `feat/landing-pages-renderer-v2` | **DONE — PR #274 open.** Safe to remove after merge. |
| `backend-lpv2-audit` | (audit) | Safe to remove. |
| `backend-nudge` / `backend-nudge-audit` | `feat/first-client-nudge-v1` | Spawn fixer here. |
| `backend-wb-audit` / `backend-wb-fix` | `fix/workout-builder-p1-followup` | Spawn WB follow-up fixer here. |
| `mobile` | `main` | **READ-ONLY per R57.** |
| `mobile-wb-audit` / `mobile-wb-fix` | `feat/workout-builder-mobile-v2` | Spawn mobile #123 rebase here. |

**Before spawning anything: `ls /home/user/workspace/tgp/` (R59) and confirm one writer per tree.**

---

## PART 9 — Brand & design source-of-truth

Dynasia corrected this tonight; do not get it wrong.

| Property | SaaS app (`tgp-platform-site`) — **builder uses THIS** | Founder/coaching site (`thegrowthproject.courses`) |
|---|---|---|
| Background | Dark `#0b0b0c` + cream `#f5efe6` | Cream / bone |
| Accent | Gold `#d4a574` (default), sage, terracotta, slate (picker for coach) | Forest green + oxblood + gold |
| Type | **Geist Sans** + **Fraunces** | **GT Sectra** (or similar) |
| Where used | Landing Page Builder, marketing site, mobile app surfaces | Dynasia's personal coaching brand only |

**The current `LANDING_PAGE_DESIGN_DOCTRINE.md` uses the wrong (courses) tokens** — it must be rewritten with SaaS tokens. That's backlog item B.5 above.

---

## PART 10 — Standing operating commands (copy-paste ready)

### Auth + repo verify
```bash
# All bash calls touching gh / git remote use:
api_credentials=["github"]

# Confirm push state of every branch:
cd /home/user/workspace/tgp/backend-main
git branch -a --contains HEAD
gh pr list --state open --repo BradleyGleavePortfolio/growth-project-backend
```

### Prisma regen (the P0 that bit us twice tonight)
```bash
DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy" \
DIRECT_URL="postgresql://dummy:dummy@localhost:5432/dummy" \
npx prisma generate
```

### Spawn a fixer (R56 + R57 + R59 compliant)
```text
1. ls /home/user/workspace/tgp/                            # R59 preflight
2. git worktree add /home/user/workspace/tgp/backend-<slug> <branch>   # if missing
3. run_subagent(
     subagent_type="general_purpose",
     model="claude_opus_4_7",          # or gpt_5_5 for audits per R31
     objective="...cwd = /home/user/workspace/tgp/backend-<slug>...
                 Do NOT touch backend-main (R57).
                 Push every 2 minutes (R61).
                 Author Dynasia G <dynasia@trygrowthproject.com>, NO Co-Authored-By (R4).",
   )
4. Wait + audit on completion (R31).
```

### Audit a branch (always Opus 4.7 or GPT 5.5 — R31)
Use a dedicated audit worktree (R60). Hand the audit subagent the 50-failures doc + this handoff + the spec.

---

## PART 11 — Immediate next 5 actions (operator todo on resume)

1. **Merge PR #274** (LP-RENDERER-V2) — CLEAN, ready.
2. **Merge PR #273** (R56–R61 doctrine) — risk-free.
3. **Spawn 3 parallel fixers** (one per worktree, R56):
   - CRM (PR #272) → `backend-272-fix`
   - CNAME → fresh `backend-cname-fix` worktree
   - Nudge → `backend-nudge` (currently the audit worktree — reuse or new)
4. **Spawn Dunning REWORK subagent** in `backend-dunning` with the full audit report attached.
5. **Wait on `checkout_hardening_redo_mpmbwiq4`**; when it returns, audit with Opus 4.7 in `backend-checkout-audit` (R60).

**Do NOT spawn 8 at once again.** Cap at 5 concurrent. R52.

---

## PART 12 — What I would tell my successor in one breath

Sprint A is 60% landed. Two PRs are clean and ready to merge (#274 + #273). Four pieces of work are DIRTY but well-diagnosed — fixers can pick them up immediately because the audit reports name every line. The only true risk left is **circular module deps** (killed Dunning + Nudge) and **prisma regen** (killed CNAME + LP-V2 P0s) — both of which are now muscle-memory failures that should be caught by R23 in CI. Add `npx prisma generate && tsc --noEmit` to the pre-push hook in every worktree and 80% of tonight's bleed disappears. Then build CANONICAL_RULES.md so R1–R61 lives in the repo, not in conversation. Then go merge the Workout Builder mobile PR and ship the Trainerize importer. The roadmap is bigger than any one operator — your job is to **keep the floor raised** (R1) and **stop wasting Dynasia's daughter's dinner** (R52).

Good luck. Push every 2 minutes.

— Outgoing operator, 2026-05-26 01:14 PDT
