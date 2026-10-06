Tier: T2 (client display and copy only; no auth, money, tenancy, PII routing, credentials or destructive data paths)
Why: AUDIT-12-125 (Settings and account) found three happy-path defects every iOS client sees on the 10-07 build.
T4 trigger scan: none. No auth, RLS/tenancy, PII exposure, money, credentials or deletion code touched. Reads fields the client already receives about itself.
T3 trigger scan: none. No API, schema, payload, navigation-route or flag change. The Preferences route stays registered; only its Settings entry row is removed.
Bounded T1: n/a.
Canonical builder: AUDIT-12-125 (agent 125, Claude Opus 5.5).
Acceptance evidence: new cases in `src/lib/__tests__/profileCompletion.test.ts` fail on main (`resolveProfileFields` missing; a completed server-named profile reports 7 of 11 fields missing) and pass here. Full Jest, typecheck and lint come from this PR's CI.

## What it fixes

- **U-12-1 (Home nudge + Edit Profile blanks).** A client finishes onboarding, signs in again, and Home keeps saying "Finish your profile: Date of birth, Target weight, and 5 more". Edit Profile then opens with their date of birth, weights, diet, gym, goal and allergies blank. Cause: sign-in and `/auth/me` return the stored `UserProfile` row (`date_of_birth`, `current_weight_lbs`, `target_weight_lbs`, `dietary_pattern`, `has_gym_membership`, `goal_type`, `dietary_restrictions`), but `getProfileCompletion` and `EditProfileScreen.profileToForm` only read the older app names (`dob`, `current_weight`, ...). Fix: `resolveProfileFields()` reads the app name first, then the server column, mapped back to the Edit Profile choices. An empty server restrictions list still counts as unanswered, so the allergy safety prompt stays. Works against the current production backend because the backend already sends these columns.
- **U-12-2 (dead controls).** A client opens Settings > Personalization, picks Notifications "Off", hides the Community Feed, or switches units, and nothing changes. Nothing in the app or on the backend reads `UserPreferences`; only the Preferences screen itself does (HeroAction even ignores the tone). Fix: remove the Settings row that opens it. The real Notification preferences row stays, now under "Notification settings".
- **U-12-3 (copy rule).** Settings > Privacy > Roman and AI said "I could not reach the server..." (first person). It now says "The app could not reach the server...", the wording used elsewhere in the app.

## Size

6 files, +110 / -22 (132 lines including tests).

No overlap with open PRs (m#409 touches `authActions.ts`; m#414/#415 touch coach settings only).
