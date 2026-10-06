**Tier: T3** (coach-facing copy in the approve-to-adjust card). B-FLAGS-123, agent 123. Fixes Opus C-337 (FLAGS-D1-123 blocker 2). Merge before the 10-07 build; FEATURE_ROMAN_ADJUST_ENABLED flips only after this is merged.

`changeSummary` printed "18 to 21 sets, -17% less volume" when a coach edit raised sets: the server's `volume_pct` is `(before - after) / before * 100`, negative for a raise (`roman-adjust.rules.ts`). It now says:
- cut: "18 to 15 sets, 15% less volume" (unchanged)
- raise: "18 to 21 sets, 17% more volume"
- no change: "18 to 18 sets, same volume"

Other callers checked: `RomanAdjustmentCard.tsx` uses `changeSummary` for the summary text, its accessibility label and the Approve button label (all fixed by this one function); the edit chips print fixed 5-50% cut presets (always positive); `appliedLine` prints sets only. No other mobile string formats `volume_pct`.

Test: `src/components/roman/adjust/__tests__/romanAdjustCopy.test.ts` (cut, raise, no change). Before the fix: 2 failed (raise, no change), 1 passed. After: 3/3. `RomanAdjustmentCard.test.tsx` 34/34; eslint clean. 2 files, 31 changed lines.
