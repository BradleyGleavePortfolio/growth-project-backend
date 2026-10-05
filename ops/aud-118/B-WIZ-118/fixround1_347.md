FIX ROUND 1 (restack, merge-only) (B-WIZ-118, agent 118) — growth-project-mobile#347 @ 3beab16088b7eae1fa08851f9742041bb6e0431f

Merged the new #346 head into this piece, merge commits only, no conflicts and no content edits here:
- `5e0689e4` merges #346 `10e278b6`; `3beab160` merges #346 `2baea5b8` (which carries #345 `97c9005e`).
- This piece's own diff against its base is unchanged: 2,308+ / 284- (2,592 lines, same as `ea2c72d1`), in the 1,500-3,000 band (operator SIZE ASSESSMENT stands).

| What came in from below | Effect on W3 |
|---|---|
| #345: cadence PATCH + answer check, `isLive` / `PackageCreateStoppedError`, content-free referenced reports, legacy status and no-refresh fallbacks | none needed to compile: `isLive` is optional; W3 tests coachSetup, coachSetupRound2, CoachPackageEditScreen idempotency and lockPreview, CoachPackageContentsScreen pass locally at this head (191 tests across the coach setup and package suites) |
| #346: form and Get paid lifecycle fences, archived recovery, copy fixes | the wizard's package step uses FirstPackageForm, so it inherits the B-329-5 fences |

Not fixed here (content in this piece; listed for the operator and the W3 owner, see ops/reports/B-WIZ-118.md):
- src/screens/coach/payments/CoachPackageEditScreen.tsx:261 calls `createPackageOnce` without `isLive` (pass the editor's owner/mount check); :608 "It will not be made twice." (narrow as in W2).
- src/navigation/CoachWizardNavigator.tsx:343 "Stripe, our payments partner" (same rule as B-346-1).

Checks at this head: Typecheck, lint, test pass.

READY FOR AUDIT
