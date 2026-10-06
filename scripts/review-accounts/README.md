# Store review accounts

This operator tool populates **two dedicated, already-confirmed accounts** with synthetic review data through the same public HTTP API the mobile app uses. It does not create accounts, change roles, use a database or service key, change flags, or make payments. Node 20 or newer is sufficient; the script has no npm dependencies.

## Before running

1. Obtain owner approval for the exact destination and the two review accounts before any remote execution. Do not use a real client's or working coach's account.
2. Confirm one account is a coach and the other is a client (`student` in the API). The client must be unpaired or already paired with this coach. The tool refuses a different coach.
3. Complete the ordinary client onboarding agreement in the app. The tool does not accept legal terms or optional AI permission on anyone's behalf. If the free grant returns pending consent, complete that agreement and rerun.
4. Confirm Programs and Community are enabled for these accounts. The tool never enables them. Food and exercise search must return existing catalog entries.
5. Store the account credentials in the operator's private environment, not in this repository, a command argument, shell history, PR, report, screenshot, or saved plan. Never provide database, payment or service-role credentials to this tool.

Set these environment variables privately:

| Variable | Meaning |
| --- | --- |
| `REVIEW_API_BASE_URL` | Approved backend origin, optionally ending in `/api`. HTTPS is required except for loopback. No query, credentials or other path. |
| `REVIEW_COACH_EMAIL` | Confirmed synthetic coach login email. |
| `REVIEW_COACH_PASSWORD` | That coach account's password. |
| `REVIEW_CLIENT_EMAIL` | Confirmed synthetic client login email. |
| `REVIEW_CLIENT_PASSWORD` | That client account's password. |
| `REVIEW_END_DATE` | Last sample-log date, `YYYY-MM-DD`. Use the current date from `TZ=America/Los_Angeles date +%F` on the first run, and keep it unchanged for reruns. |
| `REVIEW_CONFIRM_SYNTHETIC` | `yes` only after confirming these are dedicated synthetic accounts. |
| `REVIEW_OWNER_APPROVED` | `yes` only after owner approval; required for all non-loopback URLs. |
| `REVIEW_EXPECTED_ORIGIN` | The exact approved HTTPS origin, without `/api`; required for non-loopback URLs. |

From the backend repository root, the **operator**, not the account owner, runs:

```sh
node scripts/review-accounts/review.js --plan
```

This default mode is offline: no login or HTTP request and no passwords in its output. Inspect its destination, dates and steps first. It needs only the API base URL and end date.

After the owner-approved destination, accounts and prerequisites are checked:

```sh
node scripts/review-accounts/review.js --apply
```

The approval flags are a deliberate operator acknowledgement, not a way to obtain approval. Do not run this on a remote endpoint merely to test it.

## What appears in the accounts

- Client-to-coach pairing through the coach's invite code, unless already paired.
- A published **$0 one-time review package**, claimed as the client and verified through the entitlement API. Free recurring offers are not supported by the package rules; this synthetic free grant is not a paid subscription or a trial. Existing paid and recurring offers are left alone.
- An editable one-week Programs entry, three workouts with catalog exercises, and the program assigned to the client.
- Seven days of training logs, including sets/reps, and 21 meal entries: breakfast, lunch and dinner for each day. Existing food catalog results are reused; no shared food catalog item is created.
- One client check-in, unless a check-in already exists on that date.
- One clearly labeled synthetic message from each account.
- A 30-minute session type, a client booking selected from the API's actual open slots, and coach approval. Existing availability is retained. Only an empty availability calendar is initialized to daily 09:00–17:00, in the backend's coach-calendar interpretation.
- Active membership in the review coach's Community, created by its ordinary first-open bootstrap.

No meeting link is invented and no video or calendar provider is called by the script. A confirmed session can be `pending_provider` until the coach adds a genuine call link in the app. For a video-session demonstration, the operator must arrange that real link with the review coach before submission.

## Rerunning and checking the result

Use the same accounts and `REVIEW_END_DATE`. Stable account-pair markers and server idempotency keys identify this dataset. Lists are checked before writes; existing packages, program days, assignment, dated logs, meals, check-in, messages, availability and booking are skipped. The output contains created/skipped counts and sample resource IDs, not credentials, tokens or private account records.

A failure stops the run. It does not roll back prior steps or delete anything. Fix the named prerequisite in the app and rerun. Do not reassign a real client, undo a ban, or use an admin bypass to make it pass. A later fresh review dataset may need a deliberate new end date; changing that date adds a new week of logs instead of replacing the old week.

After a successful run, sign in to **both accounts in the submitted mobile binary**. Check the roster, active plan, Programs, seven dated logs, meals, check-in, both messages, Calendar/Booking Inbox, available times and Community. Put credentials only in the private store review-access fields. The script's success is not a device pass, a payment-subscription proof, or an attestation that paid offers qualify for store payment exceptions.

## Offline proof

`test/review-accounts.spec.ts` runs the request planner against an in-memory public-API double and validates emitted writes with the controllers' actual class-validator DTOs. It covers a first pass, a second pass that skips sample writes, consent refusal, role/pairing refusal, and destination/secret-output safeguards. It never contacts a live backend.

The CI lane runs only that test file. A real local backend integration was not used because ordinary password login requires confirmed authentication-provider identities and the lane has no such local accounts. No database seed or service-key workaround is part of this tool.
