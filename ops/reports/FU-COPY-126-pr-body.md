Tier: T2 mobile UI, navigation and customer-facing copy.
Why: remove controls with no consumer and give coaches/clients a working, truthful next step on the assigned screens.
T4 trigger scan: no auth, tenancy/RLS, PII collection/disclosure, credentials, money rules, destructive data behavior, migrations or backend changes; existing CoachCodeSheet and ClientPackages are reused unchanged.
T3 trigger scan: no AI, entitlement, core messaging protocol, onboarding, or payment state-machine changes; only existing screen entry points and presentation.
Bounded T1: not applicable.
Canonical builder: existing BulkInvite screen, CoachCodeSheet and ClientPackages; existing production endpoints and guards remain canonical.
Acceptance evidence: [main plus regression tests](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37555490180) failed in all six suites (17 failed / 44 passed); [fixed targeted CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37555731169) passed all eight suites / 70 tests; [full PR CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37555724890/job/112581382146) passed guards, lint, typecheck and the full test suite. All CodeQL checks are green at `48348a628a40b5323a99cb1a547e5e2c92baae57`.

## U list (B=0, U=6)

- U-17-5: a coach opening Settings sees two bulk-invite entries for the same task and cannot find emailed-invite history from Codes; retain BulkInvite only and add Emailed invites -> CoachInvites.
- U-17-6: a coach opening history for a missing invite is told the live route is coming soon; show Invite code unavailable, match Who joined, and offer safe history retry copy.
- U-17-7: a coach whose invite preview/send fails sees Please try again or raw exception text; identify the failed action, preserve the entered list, and give a specific next step.
- U-03-3: a coachless client opening Messages is sent to support instead of entering a valid coach code; open the existing code sheet when the existing server capability is enabled, retain support, refresh the thread on attachment, and preserve the sheet welcome while it refreshes.
- U-08-7: a client whose grocery/shopping/prep/bookmark action or recipe fetch fails sees Error or a false missing-recipe claim; name the action, separate 404 from transport/server errors, and add recipe retry.
- U-12-4: a client changes Units or Calorie Display but nothing in the app uses the selection; remove only these inert rows and their unused mapping entries, preserving meals/water and real settings.

## Scope / compatibility

- No changes to production flags; coachless entry uses the existing `coachless_home` capability, with support fallback when unavailable.
- No new endpoint or dependency; compatible with current production backend.
- No overlap with open m#439, m#302, m#265 or m#264 file sets.
- The earlier stopped job's branch is not reused; this PR starts in a fresh worktree from origin/main.
- Meals/water profile synchronization and unrelated historical findings are not reopened.
