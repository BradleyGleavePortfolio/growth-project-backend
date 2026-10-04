# B-WIZ-118 — builder (Claude Opus 5.5, T4), agent 118: mobile coach setup W1 #345 + W2 #346 (+ W3 #347 merge-only restack)

Started 2026-10-04 09:46 PDT (from `date`). Notes/logs: ops/aud-118/B-WIZ-118/.

## Status (10:30 PDT): DONE — READY FOR AUDIT posted on #345, #346, #347 at green heads
- #345 @ 97c9005e: FIX ROUND 1 https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/345#issuecomment-5982572052
  (Typecheck, lint, test; Analyze js-ts; Analyze actions; CodeQL: all pass)
- #346 @ 2baea5b8: FIX ROUND 1 https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/346#issuecomment-5982579141
  (Typecheck, lint, test: pass)
- #347 @ 3beab160: FIX ROUND 1 (restack, merge-only) https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/347#issuecomment-5982583482
  (Typecheck, lint, test: pass)
- PR bodies: tier header + Fix rounds table added on all three.

## Heads
| PR | start head | new head | base | size (adds+dels, lockfiles excl.) |
|---|---|---|---|---|
| #345 W1 | a4e4958820053b5aaa0f2d4a8c14f140816541b2 | 97c9005e644ebc13731d1477bfecc270a10552fd | main 7fdb629a | 1878 -> 2580 (2573+/7-; band: SIZE ASSESSMENT needed) |
| #346 W2 | 4522eb8e550119a5cb770b93b9525290b4ffb03f | 2baea5b82a2d0e0a22bac21e8fdb5e074bec9d60 | W1 | 1922 -> 2609 (band) |
| #347 W3 | ea2c72d1b37b33ecf418c3ff1e198ebb2566c622 | 3beab16088b7eae1fa08851f9742041bb6e0431f | W2 | 2592 unchanged (merge-only) |

Commits (all Bradley Gleave identity, no trailer):
- #345: 48c34822 merge main 7fdb629a (clean, PR diff unchanged) -> 089e8527 tests (failing-before) -> d197ea9c fix -> 97c9005e
  one-time answer checked by billing type + price only.
- #346: bc2442a5 merge #345 d197ea9c -> d6ff125d tests (failing-before) -> 10e278b6 fix -> 2baea5b8 merge #345 97c9005e.
- #347: 5e0689e4 merge #346 10e278b6 -> 3beab160 merge #346 2baea5b8 (both clean; 2308+/284- unchanged).

## Findings closed
| Finding | Change | Commit | Failing-before |
|---|---|---|---|
| B-345-1 (Opus) = B-345-2 (Sol) cadence change dropped | `toBackendUpdate` maps billing_type/billing_interval/billing_interval_count (one-time sends nulls); `coachPackagesApi.update` checks the answer row when billing was sent (price + billing type; recurring also cadence) and fails closed with PACKAGE_UPDATE_NOT_APPLIED (specific copy); `fromBackend` reads raw `interval` | d197ea9c, 97c9005e | lane 37219210136 |
| B-329-5 helper (Opus) = B-345-1 (Sol) | `createPackageOnce({ isLive })`: checked before start and after every await; `PackageCreateStoppedError`; no request/callback/storage write after retire; a fresh never-sent intent is removed | d197ea9c | lane 37219210136 |
| B-345-3 (Sol) diagnostics | `describeError` reports a fixed `CoachSetupFailure` + closed fields (area, action, kind, status, machine-shaped code, transport, reference); reference = server id, else sent X-Request-Id, else fresh id; same value shown (short form for client ids) | d197ea9c | lane 37219210136 |
| B-329-5 caller (Opus) = B-346-1 (Sol) | FirstPackageForm: `isLive: stillOwner` (mount + owner + generation); checks after publish, invite read, binding, final clear; account change bumps generation and resets form/intent/busy; finally only for same generation | 10e278b6 | lane 37219889067 |
| B-346-2 (Sol) Get paid lifecycle | GetPaidPanel: epoch fence for load/open/check; unmount or any auth change retires work and dismisses an open sheet (`WebBrowser.dismissAuthSession`); Retry repeats the failed action (C-346-1 Sol, same lines) | 10e278b6 | lane 37219889067 |
| B-346-1 (Opus) first-person copy | CoachSetupChecklist "This ticks when your first client payment arrives."; CoachSetupScreen "Stripe, the payments provider TGP uses, ..."; guard test over all checklist states + rendered setup screen | 10e278b6 | lane 37219889067 |
| C-346-2 archived remembered package | publish/update PACKAGE_ARCHIVED or PACKAGE_NOT_FOUND (codes only) for a remembered intent -> clear it, one fresh create + publish in the same tap | 10e278b6 | lane 37219889067 |
| C-345-1 copy truth (money list) | resumed copy narrowed to "saved on this device ... finish that same package"; helper doc states the guarantee is per account per device (sign-out wipes) | d197ea9c / 10e278b6 | - |

## Lanes
- Failing-before: #345 https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37219210136 (14F/3P, 3 controls);
  #346 https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37219889067 (13F/6P; 5 unchanged durability +
  form-level cadence, already green from the merged #345 fix).
- Probe replay: #345 https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37220301571 — Opus helper 4/4 pass;
  Sol diagnostics 4/5 (changed-retry one-time fails closed by design: double answers the old recurring row; applied-row variant 5/5).
  #346 https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37220273057 — Opus form 7/7 pass; Sol v3 and v2
  4/6 each (2 Stripe cases each are harness errors: UNSAFE_getByType / props.onPress not functions in RNTL 14); v3 with
  testID press (346-lifecycle-v3-hostpress) 6/6 pass.
- Locks: coach lock taken/released twice (10:18, 10:21 PDT); notify lines in ops/lanes118/notify/coach.txt (latest:
  #347 @ 3beab16088b7eae1fa08851f9742041bb6e0431f, 10:21 PDT).

## Production backend today (643817b3): capability notes
- Package create/PATCH/publish/binding: all exist; the cadence fix works today (controller maps billing_interval -> interval;
  B-629-4 clears interval on one_time).
- No POST /coach/connect/status/refresh: 404/405 falls back to GET status, now marked `refreshUnavailable`; the panel says
  "This shows the last update Stripe sent to TGP..." instead of "Stripe did not answer just now".
- Legacy GET /coach/connect/status (`requirements_due` = currently ∪ past ∪ eventually, no state): an account with charges and
  payouts on is shown as ready (no false "update needed" from eventually_due items); not-enabled accounts still list items.
- No /v1/coach/money/charges: first payment tick falls back to the device gate (never a false tick; may lag on a new device).
- Onboarding return URL is env STRIPE_CONNECT_RETURN_URL (not the tgp:// landing from #676): the sheet may stay open until the
  coach closes it; status is re-read either way. Header comment says so; no copy claims an automatic return.

## Follow-ups (C)
- C-346-1 (Opus) async guards: src/components/coach/setup/CoachSetupChecklist.tsx:140-158 (`load` sets state after await with no
  owner/mount check) and src/components/coach/setup/InviteShareCard.tsx:61-96 (`load`/`share`/`copy`). Fix rule: capture
  owner + mount at start, re-check after every await before setState/markShared.
- C-346-1 (Sol, rest): src/components/coach/setup/InviteShareCard.tsx:79-80 "Join my coaching ..." is the coach's own share
  message (coach voice, not app voice); left as is. Owner call if app rule should also cover coach-voice share text.
- W3 (#347, not editable in a merge-only restack): src/navigation/CoachWizardNavigator.tsx:343 "Stripe, our payments partner"
  (same B-346-1 rule); src/screens/coach/payments/CoachPackageEditScreen.tsx:261 `createPackageOnce` without `isLive` (pass
  the editor's owner/mount check); :608 "It will not be made twice." (narrow like W2); Sol caution
  CoachWizardNavigator.tsx:130-140, 622-629 async without owner re-check.
- C-346-3 (Opus): land #345-#351 together (B-332-7 in #349, C-332-1 in #348, A-329-1 in #348-#351).
- C-345-2: covered (W1 now has its own tests). C-345-3: PR body tier header added.

## Operator decisions (recommended default first)
1. W3 follow-ups above: give to the W3 owner as a normal fix round (default), or let a builder edit #347 content.
2. Share-message wording "Join my coaching": keep (default) or change to third person.
3. Size: #345 (2,580), #346 (2,609) and #347 (2,592) are in the 1,500-3,000 band: operator SIZE ASSESSMENT (default: accept; tests are about half of each new round).

## HANDOFF
- Ended 10:30 PDT. READY FOR AUDIT on #345 @ 97c9005e644ebc13731d1477bfecc270a10552fd, #346 @
  2baea5b82a2d0e0a22bac21e8fdb5e074bec9d60, #347 @ 3beab16088b7eae1fa08851f9742041bb6e0431f; all required checks green.
- Next: Opus 5.5 + Sol audits at these heads; operator SIZE ASSESSMENT for #345 (2,580), #346 (2,609), #347 (2,592).
- Open for the operator: W3 follow-ups (CoachPackageEditScreen.tsx:261 isLive, :608 copy; CoachWizardNavigator.tsx:343 copy),
  C-346-1 async guards in CoachSetupChecklist/InviteShareCard, land #345-#351 as one.
- Cleanup done: own ci/B-WIZ-118-* branches deleted; worktrees wt/B-WIZ-118-{345,346,347} removed (node_modules unlinked first);
  no locks held. Comment drafts and PR bodies: ops/aud-118/B-WIZ-118/.
