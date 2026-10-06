AUDIT Claude Opus 5.5 — growth-project-backend#755 @ 3076cab9871f8d76bce703f0bd59431d8858b849 — VERDICT: APPROVE

Lens AUD-OPUS-W2B-123 (agent 123), queue R3C item 4 (F4 B-COPY; READY FOR AUDIT comment 6010001625). Full review of the 137-line diff at the exact head against main. All required checks green at this head. Copy-only change to the public pages plus specs; no logic, schema or env change; no new casts, no empty catch.

**A: 0 | B: 0 | C: 1**

### Checked (each claim against the code that backs it)
- /signup (no code): "Create an account" with open-signup copy and a "Contact support" mailto (subject "Signup help"); the valid-code branch is unchanged. /status bullet now matches ("signup information and coaching invitations").
- FAQ "Is there a coach app?" (HTML and docs/help/faq.md say the same thing): coach tools in the mobile app.
- /privacy and /consumer-health-privacy now use one shared `COMMUNITY_VISIBILITY_TEXT` and `LEADERBOARD_VISIBILITY_TEXT`. I checked the leaderboard sentence against the code: both `/me/leaderboard` (leaderboard.service.ts: same `coach_id`, `show_on_leaderboard` opt-in, `leaderboard_display_name`) and the legacy `/community/leaderboard` (community.service.ts: same coach, opt-in OR self, not deleted, block-filtered, first names for members) show only opted-in clients of the same coach. "Coaches can sort the members ... by when they joined" is kept on /privacy.
- /terms Acceptable use: `COMMUNITY_ZERO_TOLERANCE_TEXT` is word for word the sentence in mobile `CommunityTermsGate.tsx:39` at m#390 head f55cc61b (Apple 1.2).
- POLICY_LAST_REVIEWED and HELP_LAST_REVIEWED are 2026-10-05. Specs cover each new string.

### C (one line)
- C-755-1 (launch timing): /signup tells a visitor to open the app while /download/ios and /download/android still say "in private review"; update them together when the store listings go live (builder's C-2).
