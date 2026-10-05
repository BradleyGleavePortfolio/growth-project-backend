FIX ROUND (B-TR11-122, agent 122) — growth-project-backend#672 @ 0b55832e9198b167bf947fcba3220849dc01bea7

What changed since the dual-approved head 193c6f9ac3f57a10b8ff87fa3874ee0f190dd9b7 (two commits):
- 0dca5e39e93183a818ffd7520646241e9675c3a8: merge of the refreshed #671 (6bf110fb, which carries main 5cde6253). One conflict, resolved below.
- 0b55832e9198b167bf947fcba3220849dc01bea7: typing fix in the new test only (the first PR run's type-check flagged `mockResolvedValue` on an untyped spy). No source change.

Conflict hunks (the only one): `src/notifications/notifications.service.ts`, `_kindToPrefsPrefix` (~line 1051).
- Ours (#672 at 193c6f9a): the full inline kind-to-prefix mapping, plus this PR's one addition `if (kind.startsWith('trial_ending')) return 'trial_ending';` (with 3 comment lines).
- Theirs (main #692, B-NOTIF-6): the mapping moved to `src/notifications/push/push-preferences.ts` `notificationPrefsPrefix()`, shared with the push worker; `_kindToPrefsPrefix` only delegates.
- Resolution: main's side taken as is (the file is now byte-identical to the refreshed #671, so this PR no longer changes it), and the trial_ending line moved to main's shared mapping.

push-preferences line (`src/notifications/push/push-preferences.ts`, after `first_payment`):
```ts
  // B-TRIALS (OR-113-2) — TRIAL_ENDING is a billing notice with no prefs
  // columns (same reasoning as FIRST_PAYMENT): a dedicated prefix keeps it
  // off the 'digest' false defaults so the notice is always written and sent.
  if (kind.startsWith('trial_ending')) return 'trial_ending';
```
Without it, trial_ending falls to the 'digest' prefix, whose in-app and push defaults are off, so the notice three days before the first charge would not be written to the inbox (and the push worker gate would drop it).

Test (new, 35 lines): `test/b-trials-trial-ending-push-prefs.spec.ts`
1. `notificationPrefsPrefix('trial_ending')` is 'trial_ending' and main's push gate `pushAllowedByPreferences` lets it through with `digest_push: false`.
2. Main's real NotificationsService, with digest in-app and push off: `createNotification` writes the trial_ending in-app row, and `pushToUser` (the sender TrialNoticeService uses) delivers to Expo.
Failed before (both red with main's push-preferences.ts unchanged), passes after (heavy.sh single spec, 2/2).

Everything else in the PR: the other 14 files have the same per-file `git patch-id` before and after (old base 565893b5, new base 6bf110fb).
Size: 2,993 changed lines (2,990 + / 3 -), under the grandfathered 3,000.

CI at 0b55832e: all checks green (10 success, deploy-readiness-gate skipped), including build-and-test (type-check, tests). https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/672/checks (the first run at 0dca5e39 failed type-check on the new test only; fixed by 0b55832e)
Lane at the stack top (#707): run https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37386217121 at 92f48a5a: tsc green, 57 suites / 916 tests green, including this test

Prior verdicts at 193c6f9a: Sol APPROVE https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/672#issuecomment-6004660960, Opus APPROVE https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/672#issuecomment-6004665581 (Opus C-672-L1 is what this round resolves).

READY FOR AUDIT
