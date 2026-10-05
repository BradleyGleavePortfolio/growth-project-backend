# AUD-OPUS-D5-121 (Claude Opus 5.5 lens, agent 121) — delta verdicts: messaging FR3 (b#709-#711) + scheduling #653 FR1

Started 14:23 PDT 10-05. Verdicts posted 14:30 PDT. Read-only, no CI lane, no heavy.sh. Applied _COMMON_121 items 13 and 14
(ruthless scope, 14:29). Claims: ops/lanes121/claims/growth-project-backend-{709-8d3cf36c,710-654b048a,711-3d0a615e,653-c48adb9f}-opus.
Comment bodies: ops/aud-121/AUD-OPUS-D5-121/c{709,710,711,653,714}.md (posted.txt has the URLs).

## Heads (re-verified just before posting)
#708 07d16d82 (unchanged), #709 8d3cf36c, #710 654b048a, #711 3d0a615e, #653 c48adb9f, #714 55dfbdce.

## Verdicts
- #709 @ 8d3cf36c20bb5cb2b8619b1c0fc5d74ba98de6ee: APPROVE 0/0/0. https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/709#issuecomment-6003334584
  B-709-1 fixed: realtime payload is {}, the payload type was removed, and the test asserts the exact send.
- #710 @ 654b048a911d952ec2467e2adda893923783ef6f: APPROVE 0/0/1. https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/710#issuecomment-6003334907
  Merge 1b9a2d8a equals merge-tree(3572b209, 8d3cf36c) plus the one test-file conflict, with both sides kept. B-710-1 fixed: the
  actor (sub-coach)/client pair is checked on edit and pin. B-710-2 fixed: the client inbox filters blocked senders in both the
  preview and the count, and the coach inbox nulls the preview when the sender is blocked.
- #711 @ 3d0a615e2611cde6f502d65c8e6ef10c76df92ed: APPROVE 0/0/0. https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/711#issuecomment-6003335257
  Merge 071ccda2 equals merge-tree(db7fa3bf, 654b048a) plus the import conflict, with both sides kept. The README change is true.
- #653 @ c48adb9f8239d3de00a5a56de6ff1e6a19c8b921: REQUEST CHANGES 0/1/1. https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/653#issuecomment-6003335592
  B-653-1 and B-714-1 fixed. Prior B-653-2 and Sol's B-653-1/2 accepted as edge C per the operator ruling.
  NEW B-653-4: the move-request push uses kind BOOKING_RESCHEDULED, so the coach's lock screen says "Session moved. A session has a
  new time." while the move is only requested (booking.emitter.ts:342-361 -> :639-641; lifecycle :465/:533; pinned by
  test/booking-lock-screen-push.spec.ts:191). Normal day: a client reschedules a coach-approval session, the coach believes it already
  moved, and the request lapses.
  Fix: a lock-copy variant from emitMoveRequested ("Session move request" / "There is a request to move a session. Open the app to
  see it."), keeping the same kind, plus an updated test line 191. The routing follow-up must carry the same variant, because the push
  stack's lock-screen-copy.ts:46-49 keys only on kind.
- #714 note: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/714#issuecomment-6003335936 (B-714-1 verified fixed in #653 @ c48adb9f).

## Follow-ups (C)
- C-710-D5-1: messaging.service.ts:1227-1257 unreadCountForClient (bell badge) still counts a blocked sub-coach's unread messages.
  Fix: the same visibleSender filter.
- C-653-D5-1: booking.emitter.ts:472-477 the reminder push dropped the "no call link" hint (the inbox row and BOOKING_LINK_NEEDED
  still have it). Optional fixed variant.

## CI (14:28 PDT)
All four heads: Schema parity and size-label green. build-and-test and most live lanes queued or running (runner incident), not
blocking. #653: migrations, npm audit, community-live-tests and test-deploy-readiness also green.

## HANDOFF
Done. No worktrees or branches created. Temporary refs refs/aud121/* deleted. Next step for a fresh lens: re-review #653 once B-653-4
is fixed (changed lines only).
