## Tier header
- **Tier:** T4 (member content: one coach message fans out to many clients; the audience decides who receives it). Entry graded T3/T4; max-tier rule applied.
- **Why:** new coach surfaces on the backend broadcasts API (b#726-#730, deployed in deploy 6, gated by `FEATURE_COACH_BROADCASTS`, unset in production). No payment code, no auth code, no client-app change.
- **T4 trigger scan:** none of PaymentSheet, Stripe, auth, CI/workflow files, package.json/lockfile, env names, eas.json.
- **T3 trigger scan:** new request bodies to `POST /coach/broadcasts` (with `Idempotency-Key`), `POST /coach/broadcasts/preview`, `POST /coach/broadcasts/:id/{cancel,pause,resume}`; new coach copy; two new Clients-stack routes; a header entry in the coach Messages tab (legacy list and v2 inbox).
- **Bounded T1:** `CoachInboxV2.test.tsx` mocks the new header entry (one line) so its call-order assertions keep testing the inbox only.
- **Builder-owner:** M-BCAST-123 (agent 123, Claude Opus 5.5). Spec: ops/reports/B-SPLIT-BCAST-121.md (mobile day-1 gaps) and backend `src/broadcasts/*`.
- **Acceptance evidence:** first head 56c7ea7a: PR CI all green (Typecheck, lint, test; CodeQL). Second commit (before any audit) keeps the client list under Broadcasts (`initial: false`, the B-332-7 dead end) and opens the pickers in place. Targeted jest below (11 new cases, fail before: the modules do not exist on main); `CoachInboxV2.test.tsx` 10/10; eslint on the changed files (0 errors); `tsc --noEmit` over the changed files and their imports (641 src files, 0 errors). Full suite, full tsc and lint run in this PR's CI.
- **Size:** 1,318 changed lines (10 files, tests included). Under 1,500.
- **Promotion triggers:** any change to the server-side audience rules, client tags or cards.

## Server gate
- `FEATURE_COACH_BROADCASTS` off answers 503 `broadcasts.disabled` on every route; a backend without the module answers a bare 404. Both read as "off": the Messages header entry is hidden, and the screens (if reached) say "Broadcasts are not available on this account yet. One-to-one messages with clients work as usual."
- The flag stays unset in production until this PR has a lens pair and a device pass (FLAGS-D1-123 decision 3). With the flag off this PR changes nothing a coach can see.

## What the coach gets
- **Messages > Broadcasts** (header button, coach Messages tab, both inbox versions). Opens in the Clients stack with the client list kept underneath (`initial: false`), so the Clients tab never loses its root.
- **Broadcasts list:** Scheduled (one-off, later), Recurring (active series) and Sent (sent, sending, canceled, not sent), each with a count. Rows show status, audience ("All clients", "Clients tagged travel", "Clients on 1 package"), timing ("Sends Sun, Oct 11, 9:00 AM", "Every Sunday at 9:00 AM. Next: ..."), and delivery counts ("12 delivered, 5 read, 2 waiting"). Cancel (confirmed; copies already delivered stay in client threads), Pause and Resume for series and paused ones. Pull to refresh, "Show older broadcasts" paging.
- **Composer:** message up to 4,000 characters with `{first_name}`; audience All clients / Tag / Package / Program (only the kinds the coach has, from `segment-options`; multi-select values); live count "Goes to 24 of 30 clients." (and how many who blocked messages are left out); Send now or Schedule (native date and time pickers under the control that opened them, iOS inline with Done; future and within 12 months); Repeat: does not repeat / daily / weekly (weekday chips) / monthly (day 1-31) at a set time, in the phone's time zone; confirm sheet ("Send to 24 clients now?", "Repeat this for 3 clients?") before anything is sent.
- **No double send:** one `Idempotency-Key` per distinct message; a retried tap of the same message reuses it, any edit gets a new one.
- **Errors:** coded backend refusals show the backend's own sentence (for example `broadcast.active_limit`, `broadcast.no_recipients`); no connection, 429 and 5xx each say what happened and that nothing was sent.

## What clients get
- The backend dispatcher writes each copy as an ordinary `CoachMessage` in the client's own coach thread (`{first_name}` replaced), with the usual realtime ping and push (quiet hours respected). The client app renders it like any coach message: no client change.

## Not in this PR (follow-ups)
- Cards: the composer attaches none. No messaging endpoint returns `coach_message_cards`, so a card would not show to clients today; adding cards needs a backend read change first.
- Saved replies picker: no app surface creates saved replies yet, so a picker alone would always be empty. Picker plus "save as reply" is a follow-up (about 120 lines).
- Client tag editor (coach client detail): tags can be used for an audience once they exist; the editor is a follow-up.
- Editing a scheduled broadcast (PATCH): cancel and create again for now.

## Story check (owner entry)
A coach opens Messages > Broadcasts > New broadcast, types "Gym closed Monday, do the home plan", leaves All clients, taps Send now and confirms: every client gets it in their coach thread. Then New broadcast, "Sunday check-in: how did the week go, {first_name}?", Repeat Weekly, Sun, At 9:00 AM, Start repeating: the series shows under Recurring with the next Sunday send time. Both paths are covered by the composer tests.
