## Tier
- **Tier:** T3
- **Why:** G12 privacy copy on the account-deletion screen. The Sign in with Apple removal steps there gave a menu Apple does not have on the iPhone, and used "Apple ID" (Apple's current name is "Apple Account").
- **T4 trigger scan:** none. No auth, deletion request, re-auth or navigation logic changes; no native module, config, dependency or lockfile change; no workflow change.
- **T3 trigger scan:** user-facing privacy and deletion copy (`DeleteAccountScreen`), which must match the published Privacy Policy (backend #611 `SIGN_IN_WITH_APPLE_DELETION_TEXT`).
- **Bounded T1:** NO (privacy copy).
- **Canonical builder:** Claude Opus 5.5 (job B-PRIV-FU-117, operator 117).
- **Parent owner:** operator 117. Follow-up named in `ops/reports/AUD-OPUS-PRIV3-117.md` ("For the operator", item 1). Companion backend PR: growth-project-backend#700 (C-611-18 qualifier on the policy text).
- **Acceptance evidence:** failing-before CI-lane run at the test-only commit `018ad155`, and the 3 required checks green at the head named in the READY comment.
- **Promotion triggers:** T4 if a later round changes the deletion request, re-auth or the `apple_revocation` handling. Re-grade if the copy is changed to claim revocation when the server did not report `revoked`.

## Problem on `main` `7fdb629a`
`src/screens/settings/DeleteAccountScreen.tsx`:
- `:87-88` `APPLE_FALLBACK`: "on your iPhone open Settings, tap your name, then Sign-In & Security, then Sign in with Apple ... stop using it with your Apple ID". On the iPhone, Sign in with Apple sits directly under Settings > your name on iOS 18 and later; Sign-In & Security is the account.apple.com menu ([Apple Support 102571](https://support.apple.com/en-us/102571)). On iOS 16 and 17 (the app supports 16.4 and later) the iPhone menu is under Password and Security ([iPhone User Guide, iOS 17.0](https://support.apple.com/guide/iphone/sign-in-with-apple-iph238921d37/17.0/ios/17.0)).
- `:450` revoked view: "no longer has access to your Apple ID".
- `:564-565` form note: "we also ask Apple to remove this app's access to your Apple ID" (first person, old name, and a claim the server does not make while the Apple key is not configured).

## Change
| Where | After |
|---|---|
| `APPLE_FALLBACK` | "You can also remove this app from your Apple Account yourself. On an iPhone with iOS 18 or later, open Settings, tap your name, then Sign in with Apple, choose this app, tap Delete and follow the steps on screen to confirm. On an earlier version of iOS, or on any other device, sign in at account.apple.com, go to Sign-In & Security, select Sign in with Apple, choose this app and stop using Sign in with Apple for it." Same steps as the backend sentence in #700. |
| Revoked view | "Apple confirmed that this app no longer has access to your Apple Account." |
| Form note (new `APPLE_FORM_NOTE`, `testID="apple-note"`) | "If you signed in with Apple, after you confirm you will see whether Apple removed this app's access to your Apple Account, and how to remove it yourself if not." True for every `apple_revocation` outcome: the status view shows either Apple's confirmation or `APPLE_FALLBACK`. |
| Header comment, `src/screens/settings/README.md` | Record the rule and the source; "can revoke" instead of "revokes". |

No logic change: when each card shows is unchanged.

## Tests (written first, commit `018ad155`)
`src/screens/settings/__tests__/DeleteAccountScreen.test.tsx`:
- `APPLE_FALLBACK` pinned word for word; "iOS 18 or later" before "open Settings"; exactly one account.apple.com sentence, for earlier versions and other devices; no "Apple ID", "Password and Security", "Apps Using", first person or exclamation mark.
- Rendered: the scheduled view for `revoked`, `not_configured` and `revoke_failed` says "your Apple Account" and never "Apple ID"; the revoked card text is pinned; the form has no "Apple ID" and its Apple note is pinned and has no first person.
- Existing test name "Apple ID settings fallback" now says "Apple Account".

## Out of scope (noted for the operator)
- "Apple ID" also appears in sign-in copy outside this screen: `CreateAccountScreen.tsx:1015`, `utils/authFailure.ts:183`, `lib/signupRoleNotice.ts:53`.
- Other first-person strings on this screen (for example the status-load error "We could not check ...") are not Apple copy and are left as they are.
- The fallback is text only; a tappable link to Apple Support 102571 could be a follow-up.

