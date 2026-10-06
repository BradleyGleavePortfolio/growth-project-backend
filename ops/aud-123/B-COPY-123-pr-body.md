Public pages copy for the v1 launch (F4 B-COPY-123, agent 123). Copy only; no behaviour change outside rendered HTML.

**B-STORECOPY-2 — open signup.** `/signup` with no code said the product is invite-only. It now reads "Create an account": open the app to create a client or coach account; a coach's invite code only connects the client to that coach; no code is needed. CTA "Contact support" (subject "Signup help"). The valid-code branch is unchanged. The `/status` endpoint list now labels `/signup` "signup information and coaching invitations".

**B-STORECOPY-3 — coach app FAQ.** The FAQ answer (rendered page and `docs/help/faq.md` mirror) said the coach surface is web-only. It now says coach tools are in the mobile app (clients, messages, training programs, coaching packages, availability).

**B-PRIVACY-1 (policy part, after #747).** `/privacy` "Who can see your data" and `/consumer-health-privacy` "Categories we share" now describe community spaces (display name, posts, comments, reactions, shared wins, group messages you choose to share) and the opt-in leaderboard (display name, rank, workout counts or habit-consistency score and change; opt out hides the entry). Replaces "only the health information you choose to post there", which was false while the legacy leaderboard listed non-opted-in clients; #747 made that endpoint opt-in.

**Apple Guideline 1.2.** `/terms` Acceptable use now carries the zero-tolerance sentence the in-app Community terms sheet shows (growth-project-mobile#390), word for word.

Policy and help "Last reviewed" dates bumped to 2026-10-05.

Tests (fail on main, pass here): `test/public-pages.spec.ts` (open-signup copy, generic page headline), `test/trust-pages.spec.ts` (privacy and health sections, terms sentence, status label), `test/help-pages.spec.ts` (FAQ answer, no "web-only"). Locally green: public-pages 12/12, trust-pages 47/47, help-pages 21/21, help-delete-account 15/15, support-email.guard 7/7, privacy-owner-answers 7/7, privacy-round8-retention 15/15, privacy-restore-split 4/4; eslint on changed files clean.

Size: 7 files, +115 / -22.
