# S-PRIVACY-123 — public policy excerpts and scope evidence

Collected by public page-content reads and read-only local/GitHub source inspection. No authenticated production data or user action was used.

## Public pages

The three public pages were fetched without a fetch error; each returned a last-reviewed date of 2026-10-03. ([Privacy](https://app.trygrowthproject.com/privacy), [Consumer health privacy](https://app.trygrowthproject.com/consumer-health-privacy), [Terms](https://app.trygrowthproject.com/terms))

The Privacy Policy says: “Only your own data is used — never another client’s, and never your coach’s private notes about you.” ([Privacy Policy](https://app.trygrowthproject.com/privacy))

The Privacy Policy says: “Roman conversations are kept until you delete them or your account. You can delete a conversation at any time in the app, which removes its messages from our database straight away.” ([Privacy Policy](https://app.trygrowthproject.com/privacy))

The Consumer Health Data Privacy Policy says: “Other members of community spaces you join — only the health information you choose to post there.” ([Consumer Health Data Privacy Policy](https://app.trygrowthproject.com/consumer-health-privacy))

The Privacy Policy says: “We do not sell personal data. We do not use health data for advertising or marketing, we do not show third-party ads, and we do not track you across other companies’ apps or websites. We do not use your data to train AI models.” ([Privacy Policy](https://app.trygrowthproject.com/privacy))

The Privacy Policy lists: “Expo, with Apple and Google push services — delivery of push notifications.” ([Privacy Policy](https://app.trygrowthproject.com/privacy))

The health policy lists Anthropic's consented processing and says Resend and Expo receive the content of emails and notifications. ([Consumer Health Data Privacy Policy](https://app.trygrowthproject.com/consumer-health-privacy))

The Terms identify Roman as an Anthropic-powered assistant, state that its replies can be wrong, and incorporate both privacy policies. ([Terms of Service](https://app.trygrowthproject.com/terms))

## Static distinction: day 1 versus v1.1

A6.4 requires that Roman's sourced notes survive chat deletion and that the privacy policy disclose this. ([Source of truth](https://github.com/BradleyGleavePortfolio/tgp-agent-context/blob/42859172cef880c4d50fac70518a19c36223053b/TGP_SOURCE_OF_TRUTH.md))

The v1.1 plan says: “Nothing here changes day 1. Day 1 ships the upgrades already built (section 1).” It describes saved Roman notes and rolling summaries in section 2, and private-session-note learning in sections 2 and 4. ([Roman v1.1 plan](https://github.com/BradleyGleavePortfolio/tgp-agent-context/blob/42859172cef880c4d50fac70518a19c36223053b/planning/ROMAN_V1_1_PLAN.md))

At backend head 5230306cb63df7290459bb362340a42f385f39d5, chat erasure clears `subject_context_json` and deletes `RomanMessage` rows; a new turn loads account context again. ([Roman service, lines 555–598 and 992–1020](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/roman/roman.service.ts))

The day-1 client context's booking select reads title, start/end time and status, not `coach_notes_md`. ([Client context, lines 654–667](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/roman/context/roman-client-context.service.ts))

## Confirmed leaderboard mismatch

The legacy service selects all students of the coach, calculates their workout counts, and returns account ID, first name and count without checking leaderboard opt-in. ([Community service, lines 390–423](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/community/community.service.ts))

The controller exposes this route to entitled students. ([Community controller, lines 93–101](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/community/community.controller.ts))

The separate habit leaderboard skips members without `show_on_leaderboard` and returns ranks, combined scores and score changes for those who opt in. ([Leaderboard service, lines 145–190](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/leaderboard/leaderboard.service.ts))

The mobile settings copy promises that opting out removes the row immediately and describes the off state as “Hidden from all leaderboards.” ([Leaderboard settings, lines 76–80 and 183–185](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/a727eb495a0ce381a22c4ac40370c0c69f53a656/src/screens/client/LeaderboardSettingsScreen.tsx))

## Platform requirements used

Apple requires clear collection/use and retention/deletion disclosures, explicit permission before third-party AI sharing, and health-data use limits. ([Apple App Review Guidelines 5.1.1–5.1.3](https://developer.apple.com/app-store/review/guidelines/))

Cloudflare distinguishes TLS client-server transport encryption from end-to-end encryption that prevents the messaging service from reading messages. ([Cloudflare encryption explanation](https://www.cloudflare.com/learning/privacy/what-is-end-to-end-encryption/))
