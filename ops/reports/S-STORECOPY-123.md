# S-STORECOPY-123 — store text and false-claim sweep

Operator: agent 123. Writer: GPT-6.1 Sol. Job: W3-19.

Started Monday, October 05, 2026, 21:30:59 PDT. Time box ends 22:00:59 PDT.

Status: COMPLETE. Read-only repository inspection; no PRs, comments, pushes, commits, builds, production access or spend.

Deliverable: `/home/user/workspace/tgp-agent-context/handoffs/op-123/STORE_TEXT_10-07.md`.

Evidence baseline: mobile `a727eb495a0ce381a22c4ac40370c0c69f53a656` and backend `5230306cb63df7290459bb362340a42f385f39d5`, verified against GitHub main. [Mobile baseline](https://github.com/BradleyGleavePortfolio/growth-project-mobile/commit/a727eb495a0ce381a22c4ac40370c0c69f53a656), [backend baseline](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/5230306cb63df7290459bb362340a42f385f39d5).

## Scope

Draft App Store What's New, App Review notes and Play What's new; inspect user-facing claims, public help/privacy copy, store readiness metadata and off-feature copy.

## Result

Delivered the owner-ready store packet to `/home/user/workspace/tgp-agent-context/handoffs/op-123/STORE_TEXT_10-07.md` without committing it.

- App Store What's New: 460 Unicode characters.
- Play What's new: 336 Unicode characters.
- App Review notes: 3,114 Unicode characters, with real-time 1:1 payment basis, review paths and health/AI disclosures.
- Additional Play full-description health disclaimer, review-account checklist and exact replacement copy for the visible false claims.
- Static payload check: no first-person copy, emojis or exclamation marks in any of the four store/review blocks.

**Disposition: report only. A/B/C = 0/4/2.** The four findings and two documentation follow-ups are detailed below; no fix or submission is claimed.

## Bs — ordinary-use claim failures

| ID | Exact location | Normal-user story | Smallest correction |
| --- | --- | --- | --- |
| B-STORECOPY-1 | Mobile `src/screens/TrustCenterScreen.tsx:459,544-546` | A client opens Trust & Privacy and receives universal TLS 1.3/AES-256/secure-enclave guarantees that do not match the narrower public security statement and actual storage APIs. [Trust Center](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/a727eb495a0ce381a22c4ac40370c0c69f53a656/src/screens/TrustCenterScreen.tsx), [public security](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/public-pages/trust-pages.html.ts), [token storage](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/a727eb495a0ce381a22c4ac40370c0c69f53a656/src/services/secureStorage.ts). | Replace the universal protocol/algorithm/hardware wording with encrypted server transport, accurate Keychain/Keystore token storage and a device-cache disclosure; exact copy is in the packet. No storage redesign requested. |
| B-STORECOPY-2 | Backend `src/public-pages/public-pages.html.ts:135-142`; `src/public-pages/trust-pages.html.ts:665` | A new client or coach visits `/signup` without a code and is wrongly told that the product is invite-only, contrary to the owner-approved open signup. [Signup copy](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/public-pages/public-pages.html.ts), [owner open-signup decision](https://github.com/BradleyGleavePortfolio/tgp-agent-context/blob/42859172cef880c4d50fac70518a19c36223053b/TGP_SOURCE_OF_TRUTH.md). | Replace only the no-code headline/body and public status label; preserve valid-code handling. If an intentional live invitation gate differs, use gate-aware wording rather than an unconditional claim. |
| B-STORECOPY-3 | Backend `src/public-pages/help-pages.html.ts:466-468`; mirror `docs/help/faq.md:105-108` | A coach reads the public FAQ and is told the coach surface is web-only even though the launch app offers mobile Clients, Programs, Messages and Settings. [Rendered FAQ](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/public-pages/help-pages.html.ts), [coach navigator](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/a727eb495a0ce381a22c4ac40370c0c69f53a656/src/navigation/CoachNavigator.tsx). | Replace the answer in the renderer and Markdown mirror with the actual mobile coach tools; exact copy is in the packet. |
| B-STORECOPY-4 | Mobile `PLAY_STORE_READINESS.md:44-64`; `docs/PLAY_INTERNAL_TESTING_PACKAGE.md:118-152` | The owner follows the explicit copy-paste store worksheet and submits stale data/permission answers that omit messages and client AI processing and call diagnostics optional without establishing user choice. [Readiness worksheet](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/a727eb495a0ce381a22c4ac40370c0c69f53a656/PLAY_STORE_READINESS.md), [submission package](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/a727eb495a0ce381a22c4ac40370c0c69f53a656/docs/PLAY_INTERNAL_TESTING_PACKAGE.md), [current privacy categories](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/public-pages/trust-pages.html.ts), [Google optional-collection definition](https://support.google.com/googleplay/android-developer/answer/10787469?hl=en). | Mark old declaration rows superseded, then use the review-readiness/privacy inventory for the actual binary and all other Play-distributed versions. Keep collected/shared classifications separate and distinguish production Android from Health Connect-enabled profiles. |

Recommended assignment: one small mobile copy correction for B1; one backend public-copy slice for B2/B3; coordinate B4 with W3 store-readiness/privacy outputs rather than inventing a separate declaration.

## Cs — documentation follow-ups only

- C-STORECOPY-1: backend `docs/help/faq.md:98-101` still describes 30-day deletion, although the rendered FAQ already says 14 days; synchronize the historical mirror, not the deletion system. [Markdown mirror](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/docs/help/faq.md), [rendered FAQ](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/public-pages/help-pages.html.ts).
- C-STORECOPY-2: mobile `app.json:30,191` and `docs/mobile/HEALTH_NATIVE_MODULES.md:3,61` describe writing logged workouts to Apple Health, but `src/services/health/healthkit/healthKitClient.ts:318` requests `write: []`; do not announce Health write-back, and align dormant metadata/docs in build-config work. [Health metadata](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/a727eb495a0ce381a22c4ac40370c0c69f53a656/app.json), [native-module notes](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/a727eb495a0ce381a22c4ac40370c0c69f53a656/docs/mobile/HEALTH_NATIVE_MODULES.md), [read-only connector](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/a727eb495a0ce381a22c4ac40370c0c69f53a656/src/services/health/healthkit/healthKitClient.ts).

## Store-copy boundaries

The production profile enables Roman chat, Community core, Calendar and Programs but disables Android Health Connect; the backend manifest keeps new coach Code tools, Broadcasts, coachless Home, dunning v2, community DMs and voice notes off at this inspected baseline. [Build profile](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/a727eb495a0ce381a22c4ac40370c0c69f53a656/eas.json), [backend launch gates](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/.github/fly-env-desired-state.json).

No positive medical-diagnosis/cure or HIPAA/audit-certification claim was found in the inspected visible training/health/security copy; existing training consent and public security language limit those claims. [Training consent](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/a727eb495a0ce381a22c4ac40370c0c69f53a656/src/lib/consultation/copy.ts), [public privacy/security copy](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/public-pages/trust-pages.html.ts).

App Review wording is explicitly conditional on the owner verifying real-time human coaching offers and working synthetic-data demo accounts; 3.1.3(d) is not an exemption for asynchronous-only plans, standalone content, AI or group sales. [Apple payment/access requirements](https://developer.apple.com/app-store/review/guidelines/), [catalog limitation documented in the iOS purchase policy](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/a727eb495a0ce381a22c4ac40370c0c69f53a656/src/config/purchaseSurfaces.ts).

## Verification and handoff instructions

- GitHub main was rechecked after drafting and still matched mobile `a727eb495a0ce381a22c4ac40370c0c69f53a656` and backend `5230306cb63df7290459bb362340a42f385f39d5`. [Mobile main baseline](https://github.com/BradleyGleavePortfolio/growth-project-mobile/commit/a727eb495a0ce381a22c4ac40370c0c69f53a656), [backend main baseline](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/5230306cb63df7290459bb362340a42f385f39d5).
- Both read-only worktrees were clean. No branches, worktrees, claims or locks were created; nothing to release.
- CI: not run; this was read-only writing and source inspection. Character/style checks were a lightweight Node text check, not an app build/test.
- No live catalog, production data, credentials, store console or submitted binary was accessed. Published store descriptions and screenshots are not certified by this sweep.
- Operator decisions needed: provision two working synthetic-data review accounts; confirm every paid iOS client offer is genuine real-time 1:1 coaching. Recommended default: do both before pasting the conditional App Review notes.
- Operator next step: assign the three small copy/declaration correction slices, reconcile wave-3 flag changes against the final October 07 artifact, and use the packet after the ordinary device pass.
- Notify: `/home/user/workspace/ops/lanes123/notify/S-STORECOPY-123.txt`.

## HANDOFF
