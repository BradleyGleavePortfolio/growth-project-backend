# S-DEVICEPASS-123 — W3-18 owner device-pass script for the 10-07 build (writer, Claude Opus 5.5, agent 123)

Started 21:30 PDT 10-05, finished 21:42 PDT (time box 30 min). Read-only on both repos: no PRs, comments, pushes or commits.
Evidence: mobile main a727eb49 (wt/RO-mobile), backend main 5230306c = production (wt/RO-backend), SoT on tgp-agent-context main
4285917, reports FLAGS-D1-123, M-COACHLESS-123, M-INV-123, M-BCAST-123, S-PUSH-123, S-E2E-CLIENT-123 (preliminary), op-123 HANDOFF.md.

## Deliverable
/home/user/workspace/tgp-agent-context/handoffs/op-123/DEVICE_PASS_10-07.md (uncommitted; the operator commits). 323 lines,
plain words, no terminal commands, no exclamation marks, clinic partner not named.
Parts: A setup (builds, three switches, featured-coach values, Apple key, what to have, do not pay); B coach on iPhone (sign-in,
Featured coach editor if W3-06 lands, Codes screen create/QR/scan/share/rotate/turn off, coach Roman); C Google sign-in (Android) and
Apple sign-in (iPhone) creating two test clients, no-coach Home banner + Roman card, Not now, wrong code, join with the featured code;
D iOS "1:1 coaching with Bradley" screen + payment sheet (stop before paying) and the Android plan sheet; E Health Connect connect /
data check / sleep double-count check / disconnect (+ optional Apple Health); F Roman client chat, 988 / 911 / gym-talk checks,
"Your conversations with Roman"; G Community view / post / reply / report / block; H Android notification categories, coach->client
and client->coach push (generic lock-screen text), Broadcasts now + scheduled/cancel, Mute all, Who joined; I a fill-in reply form.
Every step: Tap / See / Send, with on-screen wording taken from the code.

## Things the operator must settle before the pass (each with recommended default)
1. Android build profile: only the **clinic** profile builds Health Connect in (eas.json production TGP_ANDROID_HEALTH_CONNECT=0,
   app.config.js). Part E needs the clinic-profile Android build. Default: give the owner the clinic-profile Android build for the
   pass.
2. FEATURE_COACH_CODE_TOOLS, FEATURE_COACH_BROADCASTS, FEATURE_COACHLESS_HOME are off; without them Parts B3, C3-C7, H4-H5, H7 show the
   old screens. Default: turn the three on for the pass (production holds only the owner's accounts; kill = unset). The script tells
   the owner what "switch off" looks like so the pass still produces results either way.
3. Featured-coach config must be saved before Part C (W3-06 editor if it lands, else PUT /admin/featured-coach with the owner's A3
   values). Default: operator saves it from the owner's values.

## Findings seen while writing (no new B)
- Already known and written into the script as expected results: Sign in with Apple fails until APPLE_AUDIENCES is fixed; coach app
  never asks for push permission on a fresh install (C-S-PUSH-3), so H3 may fail on a fresh iPhone install; community push ignores
  Mute all (B-S-PUSH-1, not tested); community posting may dead-end (S-E2E-CLIENT-123 B-E2E-1 candidate) - G2 captures it.
- Coach Community tab is off in both binaries (EXPO_PUBLIC_FF_COACH_COMMUNITY absent from eas.json); B1 asks the owner to confirm.
  Same root as the S-E2E-CLIENT-123 candidate; no separate finding.
- Part B2 menu path is a placeholder ("Settings, Featured coach") because W3-06 had no branch at 21:35; update once its PR lands.

## HANDOFF
- State: DONE 21:42 PDT. Script written, not committed (operator commits it with the other op-123 handoff files). Notify file:
  /home/user/workspace/ops/lanes123/notify/S-DEVICEPASS-123.txt. No worktrees, branches, claims, locks or CI runs created.
- If continuing: (1) when W3-06 lands, replace the B2 path with the real menu path and field names; (2) when W3-07 (flags PR) lands,
  delete the "switch off" fallbacks in A2; (3) when the Sign in with Apple fix (W3-04 / owner key) lands, change C2's expected result
  to a pass; (4) if S-E2E-CLIENT-123 confirms B-E2E-1 and a fix merges, drop the G2 "known risk" line; (5) if W3-05 changes what a QR
  scan opens, update B3's camera bullet.
