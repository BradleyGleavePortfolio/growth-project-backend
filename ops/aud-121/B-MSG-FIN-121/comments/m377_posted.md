OPENING (B-MSG-FIN-121, agent 121) — growth-project-mobile#377 @ 4b9bb41a6258ed509a7123750b127954d0571c38

M-MSG-121 piece 2/2, stacked on #371: messaging v2 thread actions on both thread screens, behind `messaging_core_v2`. It stays a draft until backend #708-#711 are approved; the PR body has the full table.

- Live bug fixed with the flag ON or OFF: the thread routes return `sender_id`, not `sender_role`, so both screens drew every bubble on one side. The side is now derived from `sender_id`.
- Flag ON:
  - idempotent send (`client_message_id` + `Idempotency-Key`; a failed send keeps its key and Send again replays it)
  - server reply quotes and read-up-to
  - edit, and delete for everyone (author, under 48 h; delete asks first)
  - pins bar with pin / unpin, thread mute, tombstones
  - a 503 falls back to legacy and keeps the typed text
- Flag OFF: Reply is hidden, because the legacy routes reject a reply reference with 400. Nothing else changes.
- Size: 1,489 changed lines against #371 (tests 537), under the 1,500 limit.

## Self-check (money list and edge-case freeze A2)
- Redelivery: a send retry uses the same key, so the server returns the original row and no duplicate is created. This is asserted on both screens. A 2xx with an unreadable shape counts as sent, so it is never resent.
- Fail-closed: refusals keep the typed text and show the server code's copy. Nothing reports success before the server confirms.
- Copy truth: a failed client send says "Not sent. Long press to send again", not "Sending". Tombstones say "Message deleted". Action labels contain no first person (asserted).
- Webhooks, currency and terminal states: not applicable.
- Open Bs: none. Deferred: C-MSG-5 (coach thread mute state is unknown on open, so the menu lists every option including Unmute). This is a small UX gap, not an edge-case B.

## Evidence
Local runs (ops/heavy.sh, one file at a time, 13:2x-13:36 PDT): threadV2 10/10, ClientMessagesScreenV2 5/5, MessagesScreenV2 2/2, messagingV2Api 29/29, ClientMessagesScreen.integration 3/3, MessageActionSheet 6/6. `npx tsc --noEmit` and eslint on the changed files are clean.
CI at 4b9bb41a: Typecheck, lint, test passed (run 37370921343, rerun at 13:59 after the runner incident cancelled it).

Not READY yet. The backend B-709-1 ruling (FIX ROUND 3 on b#709) makes `thread-updated` an ID-free ping with payload `{}`. Besides the parser change on #371, src/screens/coach/ClientMessagesScreen.tsx:187-188 filters pings on `ping.threadClientId`, so that filter has to go: any ping refetches the open thread over the authenticated API. The client screen (src/screens/client/MessagesScreen.tsx:242) already ignores the payload. Per the operator (14:03), mobile is not pushed this round. This change is the next push on this stack, and the audit request follows it.
