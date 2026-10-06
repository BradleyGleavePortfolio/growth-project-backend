AUDIT Claude Opus 5.5 — growth-project-mobile#337 @ c37add1c37dd47fb6d5ade587b320b84e64854db — VERDICT: APPROVE

AUD-OPUS-ADJ2-122, agent 122. Delta re-review (T4, RUTHLESS SCOPE): prior Opus Bs plus the changed lines (romanAdjustCopy.ts, RomanAdjustmentCard.test.tsx, node_modules untracked). The main merge 36fffd6 is clean: every PR file is byte-identical across it. Size 1,204 lines (grandfathered 3,000).

A/B/C = 0/0/3

Prior Bs, all closed:
- B-337-1 CI red. The node_modules link is no longer tracked (git ls-tree at this head shows nothing), and .gitignore:4 `node_modules` now also matches a symlink. Every render/fireEvent/act in the card test is awaited (RNTL 14). PR CI "Typecheck, lint, test" is green: https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37391538418/job/112039305987 Attempt 1 failed only on the unrelated wearables ConnectProviderSheet.attemptFence spec and passed on a rerun with no push. CodeQL is green.
- B-337-2 a lost reply no longer reads as "unchanged". Approve, edit and undo with no status, a ZodError or a 5xx now say the result is not certain (romanAdjustCopy.ts:81-87, :122, :131, :152) and return refresh: true. The card then calls onSettled({ refresh: true }), and the Section drops the card and reloads (RomanAdjustmentsSection.tsx:81-85). The server's applied-in-undo-window row then shows the real state. Coded refusals, 4xx and dismiss keep their true "unchanged" copy. The load copy no longer says "unchanged" (romanAdjustCopy.ts:110).
- B-655-2 mirror: the ADJUSTMENT_WORKOUT_CHANGED fallback equals the backend sentence and promises no new suggestion (romanAdjustCopy.ts:33-34).

Changed lines: nothing from the item list. Sentry now gets a fresh Error and an allowlisted code, never response text (romanAdjustCopy.ts:121, :150). The copy has no first person, no exclamation marks and no generic errors.

Builders' proposed Cs: agree with all of them, no normal-user story. Sol B-337-4 is a callback after unmount, where the parent still gets the server's state. Opus C-337-1..5 and Sol C-337-1/2 cover a countdown dropped on leaving, a server Undo button with no timer, a hidden section when the Action Queue fetch fails, the weekday (now in roman_text), and a cancelled draft that is kept.

C (one line each):
- C-ADJ2-337-1: an upward stepper edit shows "-N% less volume", because b#655 now sends the realized volume_pct (z.number() accepts it, so nothing breaks). This is C-337-1. Do a small changeSummary follow-up before FEATURE_ROMAN_ADJUST_ENABLED turns on.
- C-ADJ2-337-2: if the reload after an unconfirmed change hits a coded 503, the server's "Your workouts are unchanged" shows (backend constants.ts:69). This needs two failures in a row. C (edge, deferred to 10k clients).
- C-ADJ2-337-3: the flaky wearables attemptFence spec is unrelated. Note it for the wearables owner.

Lands with growth-project-backend#655. Flag stays off.
