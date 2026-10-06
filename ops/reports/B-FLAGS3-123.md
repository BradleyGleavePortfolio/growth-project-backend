# B-FLAGS3-123 — W3-07 server flags for Codes, Broadcasts, coachless (builder, Claude Opus 5.5, agent 123)

Started 21:30 PDT 10-05. Time box 30 min (ends 22:00). Base: backend main 5230306cb63df7290459bb362340a42f385f39d5 (= production, deploy 8).
Worktree: /home/user/workspace/wt/B-FLAGS3-123 (branch agent123/w3-flags-codes-broadcasts-coachless). PR body: ops/aud-123/B-FLAGS3-123/body.md.

## PR
growth-project-backend#743 chore(flags): coach Codes, Broadcasts and coachless Home on for day 1
- Head 3493baaa23f7155b1ee6b1f0ad25f5fb5acb1d27, 1 file +6/-6 (.github/fly-env-desired-state.json).
- FEATURE_COACH_CODE_TOOLS, FEATURE_COACH_BROADCASTS, FEATURE_COACHLESS_HOME: unset -> "true". The 3 gate texts are rewritten (deployed PRs,
  merged mobile PRs, ff6bd4b effect, and the kill for each). "Apply only after the owner says go" is in each gate.
- Closed value sets were already in ENV_RULES (values ['true','false'], unsetIs 'off'), so env-validation.ts did not change.
- Runbook table: I regenerated it with `fly-env-manifest.js kill-switches` and it matches docs/runbooks/launch-flags.md exactly (the kill is
  `unset` whatever the current value), so the doc did not change.
- `validate` OK (manifest sha256 9ad9cd50...). Local runs through heavy.sh, one file at a time: fly-env-manifest 67/67,
  fly-env-sync-behavior 54/54, fly-env-workflows 15/15.

## Proof 1: no change for the store build ff6bd4b
- ff6bd4b src/ has no coach/codes, /coach/broadcasts, saved-replies, client-tags, cards/validate, /coachless or coachless_home (checked
  with git grep at ff6bd4b).
- Code tools gate only `@Controller('coach/codes')` (coach-code-tools.controller.ts:57-114). ff6bd4b uses the ungated legacy
  /coach/invite-codes routes.
- Broadcasts gate the A4 `coach/*` controller (broadcasts.controller.ts:46) and the dispatcher. The one shared path:
  messaging.service.ts:635 adds a `card` include on thread reads, which is null on ordinary messages. ff6bd4b reads messages as plain
  JSON (no strict schema), so it ignores the extra key. Cards and broadcasts can only be created through A4 routes, and ff6bd4b has no
  screen for those.
- Coachless gates `@Controller('coachless')` only. /me/feature-flags `coachless_home` changes from false to true for students.
  ff6bd4b validates that response as record<string, boolean> and reads only its 4 community keys, so the change has no effect there.

## Proof 2: coachless clients before the featured config exists (banner hidden? NO)
- With no featured_coach_config row: resolveRow(null) returns accepting_clients false, code null, offer_text null, roman_enabled false,
  and the default title "Enter coach code for coaching and programs" (featured-coach.service.ts:130-143).
- /coachless/home returns a banner with the default title, offer_text null, code null, roman_card null, featured_coach null.
- On the 10-07 build (mobile a727eb49 CoachlessHomeSlot), a client with no coach sees a quiet banner: the title plus an
  "Enter a coach code" link. There is no offer line, featured-coach card, "Use code" button or Roman card. Clients with a coach, coaches
  and the owner see nothing.
- The code sheet resolves any real coach link or invite code (CoachCodeLookupService). It does not depend on FEATURE_COACH_CODE_TOOLS.
- So turning the flag on before the config is saved shows the designed coachless entry point (owner 10-01 13:34 "a simple banner at
  top of homepage"). It does not show an empty or broken offer.

## A/B/C
- 0 B. Cs: none found. Mobile screens are server-gated (no EXPO_PUBLIC flag), so the 10-07 build shows the Codes, Broadcasts and
  coachless surfaces as soon as the flags are applied on Fly.

## Operator decisions
1. Apply timing: apply only after the owner says go (entry rule). Recommended default: apply all three together after the owner's device
   pass on the 10-07 build, then run Fly Env Sync plan (expect 3 to set, 0 to unset).
2. Coachless banner before the featured offer exists. Recommended default: have the owner save the offer first (W3-06 editor or
   PUT /admin/featured-coach), so the first coachless Home shows his offer. Applying earlier is safe: the client sees only the quiet
   code-entry banner.

## Status (21:48 PDT, done)
- PR CI: all checks SUCCESS at 3493baaa (build-and-test
  https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37414570468/job/112110223031; deploy-readiness-gate skipped
  as usual; danger, R75 cast guard, schema parity, rls, community and mwb live tests green). mergeState CLEAN.
- OPENING comment (head verified right before posting), READY FOR AUDIT:
  https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/743#issuecomment-6009542524
- Worktree removed at 21:48. Its only change was pushed; nothing was unsaved. No ci/* or audit/* branches, locks or claims.
  Nothing merged, deployed or applied. No Fly workflow or env sync was run.

## HANDOFF
- State: builder finished at 21:48 PDT, about 18 min into the 30-min box. b#743 is open at 3493baaa23f7155b1ee6b1f0ad25f5fb5acb1d27 with
  CI green and READY FOR AUDIT.
- Next (operator): run the lens pair on b#743 (manifest-only, +6/-6). After the owner says go, run Fly Env Sync plan (expect
  FEATURE_COACH_CODE_TOOLS, FEATURE_COACH_BROADCASTS and FEATURE_COACHLESS_HOME to set, 0 to unset), then apply.
  Recommended: the owner saves the featured-coach offer first.
- If a fix round is needed: `git -C /home/user/workspace/growth-project-backend worktree add /home/user/workspace/wt/B-FLAGS3-123
  agent123/w3-flags-codes-broadcasts-coachless` (absolute path). Edit only .github/fly-env-desired-state.json, rerun
  `node scripts/fly-env/fly-env-manifest.js validate|kill-switches .github/fly-env-desired-state.json src/common/env-validation.ts`,
  push once, then post `FIX ROUND 2 (B-FLAGS3-123, agent 123) — growth-project-backend#743 @ <sha>`.
