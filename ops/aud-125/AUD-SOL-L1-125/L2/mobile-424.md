AUDIT GPT-6.1 Sol — growth-project-mobile#424 @ f69f200ec84e7ed3657621f3fb8c922e80ee12a0 — VERDICT: APPROVE

A=0 B=0 C=0.

The exact production `COACH_AI_BUDGET_EXHAUSTED` code now has a separate error kind for both the pre-storage HTTP refusal and the stored-turn stream error, without reclassifying other 402 responses or consent/daily-cap failures ([romanApi.ts](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/f69f200ec84e7ed3657621f3fb8c922e80ee12a0/src%2Fapi%2FromanApi.ts)).

The client/coach-specific explanation takes precedence over generic stored-turn copy and removes the unhelpful Send again button without advertising credit-pack purchases ([RomanChatScreen.tsx](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/f69f200ec84e7ed3657621f3fb8c922e80ee12a0/src%2Fscreens%2Froman%2FRomanChatScreen.tsx), [romanVoice.ts](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/f69f200ec84e7ed3657621f3fb8c922e80ee12a0/src%2Fcomponents%2Froman%2FromanVoice.ts)).

Typecheck/lint/test is green at this head; the two CodeQL analysis jobs remain queued rather than red, and no launch-blocking code finding was identified ([mobile CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37533456763/job/112508355515), [JavaScript/TypeScript analysis](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37533456664/job/112508362877), [actions analysis](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37533456664/job/112508363079)).
