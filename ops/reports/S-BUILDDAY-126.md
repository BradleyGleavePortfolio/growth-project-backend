# S-BUILDDAY-126 — build-day sheets

## Scope traced (screens + routes)
- DOCS / T0 only. Refresh the owner's two October 07 sheets and the mobile merge list; no code PR, commit, build, production action or store submission.
- Start: 2026-10-06 18:00:19 PDT (from `TZ=America/Los_Angeles date`).
- Checked baselines: [mobile main 950689af696f993d6bb2b361ca6b5d07bab1328e](https://github.com/BradleyGleavePortfolio/growth-project-mobile/commit/950689af696f993d6bb2b361ca6b5d07bab1328e) and [backend main f71bb9a4c973fbd7d3f3bcd555dbcd0cd491e199](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f71bb9a4c973fbd7d3f3bcd555dbcd0cd491e199).
- Traced account entry, client/coach navigation, AI workout review and assignment, builder availability, package media, Community leaderboard, health connections, support reporting, food/workout logging, payments, messaging and push through the [client navigator](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/950689af696f993d6bb2b361ca6b5d07bab1328e/src/navigation/ClientNavigator.tsx) and [coach navigator](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/950689af696f993d6bb2b361ca6b5d07bab1328e/src/navigation/CoachNavigator.tsx).
- Key contracts checked: `/coach/ai/workout-program`, `/coach/ai/drafts/:id/approve`, `/ai/gateway/workout-builder/status`, `/me/leaderboard`, `/me/leaderboard/opt-in`, `/v1/coach/media`, package content/drops, support email actions, and phone health permission/sync screens. [Coach AI entry](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/950689af696f993d6bb2b361ca6b5d07bab1328e/src/components/coach/CoachAiSection.tsx) [Actual assignment, backend #806](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/806) [Builder status, backend #808](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/808) [Leaderboard, #438](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/438) [Media and deliverables, #437](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/437) [Support](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/950689af696f993d6bb2b361ca6b5d07bab1328e/src/screens/support/SupportInboxScreen.tsx)
- Final repository check: mobile remains [950689af696f993d6bb2b361ca6b5d07bab1328e](https://github.com/BradleyGleavePortfolio/growth-project-mobile/commit/950689af696f993d6bb2b361ca6b5d07bab1328e); backend advanced to [2df556b7eeaf00cd8ec571b30f830933461cd8e5](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2df556b7eeaf00cd8ec571b30f830933461cd8e5) when #808 merged, and the drafts were refreshed accordingly.

## B list
- None newly established; documentation task, not a code audit.

## U list
- None newly established; stale wording is being refreshed in the requested sheets.

## C one-liners
- None investigated.

## Covered by open PRs
- Ask AI is not on inspected mobile main; [mobile #439](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/439) and [backend #809](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/809) remain open, while [backend #808](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/808) merged during this task.
- The drafts distinguish status support, generator/UI availability, actual live enablement, paused behavior and the unsupported-backend fallback; the latest [desired-state manifest](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/2df556b7eeaf00cd8ec571b30f830933461cd8e5/.github/fly-env-desired-state.json) still leaves live builder/gateway settings unset.

## PRs opened (number, head, lines, CI)
- None by design. CI not applicable.

## Not fixed (needs operator)
- No new issue requiring an operator-routed fix or owner decision. Normal release follow-up only: the operator commits the requested Markdown drafts, confirms the final binary and applied settings, and supplies/validates private review access.
- Recommended default: retain conditional Ask AI checks and no public Ask AI claim until the final binary/backend are confirmed; describe PDFs/videos as included human-coaching package content, not standalone store purchases. [Pending mobile UI, #439](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/439) [Purchase-surface policy](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/950689af696f993d6bb2b361ca6b5d07bab1328e/src/config/purchaseSurfaces.ts)

## Deliverables and acceptance evidence
- Requested drafts:
  - `/home/user/workspace/ops/reports/S-BUILDDAY-126/DEVICE_PASS_10-07.md`
  - `/home/user/workspace/ops/reports/S-BUILDDAY-126/STORE_TEXT_10-07.md`
  - `/home/user/workspace/ops/reports/S-BUILDDAY-126/WHATS_IN_THE_BUILD.md`
- Editable Word mirrors are alongside the drafts: `Device_Pass_October_07.docx`, `Store_Text_October_07.docx`, `Whats_In_The_October_07_Build.docx`.
- The device draft includes client/coach account labels, iPhone/Android checks, actual tap labels, conditional Ask AI with paused state, AI approve-and-assign verified from the client, package PDF/video upload and access, Community leaderboard, phone health, Apple sign-in and support reporting.
- The store draft has 17 changed-claim rows and retains a clear boundary between listing text, private review notes and evidence.
- `buildday_validation.json` confirms 103/103 merged mobile PRs listed, zero missing, extra or duplicated entries; character counts excluding citation links: subtitle 27, Play short description 57, Play release notes 331, App Store release notes 441.
- Word files rendered successfully to PDF previews; all-page contact sheets and a full-size claim-table page were visually inspected for spacing, clipping and readability.
- All three Word files passed the share-time Office quality check and were shared as editable deliverables. The store draft's first validation caught a missing table-shading `val` attribute; that was corrected in the generator and the subsequent validation passed.
- Final Markdown line counts: device pass 157, store text 162, build inventory 123; total 442. Application code changed lines: 0; no PR heads or PR CI apply.
- Shared Word asset IDs: device `d808a9c9-8fa2-4786-ad39-5ffebe77766b`, store `649a2fa4-2406-4abd-bafe-e1b50a4d3f2d`, build inventory `6cea76a6-7bf3-459a-8bc5-a300dc9d28f4`.
- Raw initial/latest inventories, flag snapshots, initial/latest #439 diffs, #808/#809 diffs and selected source URLs are retained in `/home/user/workspace/ops/reports/`; no repository files were changed.

## HANDOFF
- Complete. Requested Markdown drafts and editable Word mirrors are in `/home/user/workspace/ops/reports/S-BUILDDAY-126/`.
- Completed 2026-10-06 18:23:32 PDT, within the 60-minute job time box.
- Current draft snapshot: 2026-10-06 18:16:19 PDT. GitHub mains were rechecked unchanged at 18:19:06 PDT.
- Future updater: after any additional merges, update the snapshot and current desired-state references, rerun the merge-list completeness check, and regenerate the Word mirrors with `create_buildday_docx.js`.
- Keep review passwords outside these files and public GitHub.
- No worktree, application code changes, production/store actions, PR comments or retained locks.
- Notify record: `done | PRs: none | B=0 U=0 | needs operator: 0` (no newly discovered issue requiring routing; standard final-build/review-access checks remain in the handoff).
