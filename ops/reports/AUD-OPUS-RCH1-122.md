# AUD-OPUS-RCH1-122 (Claude Opus 5.5 lens, operator agent 122): Roman chats mobile m#372-#376, first full review

Status: DONE 15:59 PDT (started 15:44 PDT; time box 45 min). Verdicts posted 15:58 PDT. Times from `TZ=America/Los_Angeles date`.
Independence: the Sol lens's notes, report and comments for this round were not read before posting.

## Inputs read
- ops/lanes122/_COMMON_122.md (all), JOBS122 entry AUD-OPUS-RCH1-122 only, SoT A1, A2 overrides items 1-11, A5 rules 11-12, A6.4.
- ops/reports/B-SPLIT-ROMANCHATS-121.md; this lens's prior #331 verdicts (copies in ops/aud-121/B-SPLIT-ROMANCHATS-121/):
  5960943313 (a224e5bd, B-331-1), 5964441359 (ec2857ba, B-331-7), 5972101193 (c621770f, B-331-9).
- Backend main 5cde6253 (roman-chats.controller.ts, roman.controller.ts, roman.service.ts) for the wire contract.

## Heads (verified at start 15:44; claims touched in ops/lanes122/claims/mobile-<n>-<head8>-opus)
| PR | Head | Base | Size |
|---|---|---|---|
| #372 | 61141c05c6fe5281a7a4c61370e3240163409f9e | main (b79ca594) | +1420 -36 = 1,456 |
| #373 | 70c24e710b9c5dddc49d87e0ea3e9e84298c9a26 | split-1 | +919 -4 = 923 |
| #374 | 0ae9013fe06cbd1d5f1dbaf6ad6072f72f92358a | split-2 | 823 |
| #375 | a10123f222013416edff450b15bd1bd34952dd90 | split-3 | 1,339 |
| #376 | 6fabb1f989a985bf187552c2c8ad0f93d5486d4a | split-4 | 896 |
All under 1,500. Top tree 3a22bc53 = builder's F tree.

## Evidence reuse
- 30 of 35 feature files are byte-identical to #331 @ c621770f, which this lens audited with only B-331-9 open. Changed since:
  sessionFence.ts, secureStorage.ts, authActions.ts (main merge conflict: health-retire wrapper + opts), CoachNavigator.tsx (main only),
  2 READMEs, 2 tests. All read in full. Every piece diff read for boundaries (nothing imports a later piece; #375 screens unregistered
  until #376).

## Prior Bs of this lens
- B-331-1 closed (labels carry time, chatDateLabel). B-331-7 closed (unchanged). B-331-9 closed: runSessionWrite holds the fence while
  the native write lands and moves the generation again; refresh waits sessionWritesSettled; 401 from an older generation never refreshes
  (api.ts); tests sessionFence.refresh.test.ts:290, :309, :241, control :445; failing-before lane 37367260302 (builder). Now an edge
  under the freeze anyway.

## Findings
### B-376-1 (normal use, message flow dead end + deleted chat still shown)
- Where: #376 adds the header history button to the Roman chat (RomanChatScreen.tsx:267 -> RomanConversationsButton.tsx:22
  navigate('RomanConversations'), pushed on the same stack; RomanChat stays mounted). useRomanChat.ts:145-147 opens the session only on
  mount; nothing reloads on focus or on a delete (romanChatsEvents.emitGone is emitted only by the transcript, RomanConversationScreen.tsx:112,
  and RomanChat does not listen; list deleteOne/deleteAll emit nothing). Send goes to the old id (useRomanChat.ts:194). Backend send uses
  getOwnedSession with deleted_at: null (roman.controller.ts:123, roman.service.ts:239) -> 404 -> romanApi.ts:483 'unavailable' ->
  screen copy ROMAN_SEND_FAILED "That request did not complete. Send it once more, and I will try again." + "Send again", which repeats
  the same 404.
- Story: a client chatting with Roman taps the new history icon, deletes today's conversation (or Delete all), taps Back, still sees the
  deleted messages on screen, and every message they send fails with "That request did not complete. Send it once more" until they leave
  and reopen Roman.
- Fix rule: when the chat screen regains focus after the history screens (or on a delete event for its session / delete all), re-open the
  session (call reload/open) so the erased transcript is cleared and a live session is used. Smallest: useFocusEffect in RomanChatScreen
  that calls reload() when returning from RomanConversations, or have useRomanChats.deleteOne/deleteAll and the transcript emit an event
  that useRomanChat handles by re-opening. Add P1/P2 of the probe as tests.
- Probe: ops/aud-122/AUD-OPUS-RCH1-122/zzAudOpusRch1Probe.test.ts, lane run 37385259212
  (https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37385259212): 2 failed (P1 deleted text still shown,
  P2 send goes to s-today), 1 passed (control). Log: ops/aud-122/AUD-OPUS-RCH1-122/lane-37385259212.log. Branch deleted.
- Note: the header button and useRomanChat were already like this on #331 @ c621770f; this lens missed it there. Item-1 normal use, so B.

### Cs
- C-374-1 (copy, follow-up): the same list copy is shown on the coach's own list (coach Settings): "Your coach never sees them." and the
  signed-out path "Settings > Privacy > Roman and AI" are client wording.
- C-RC121-1 / C-RC121-2 (builder follow-ups) stand.

## Verdicts posted (15:58 PDT; heads re-verified right before posting)
| PR | Head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| #372 | 61141c05c6fe5281a7a4c61370e3240163409f9e | APPROVE | 0/0/1 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/372#issuecomment-6004925783 |
| #373 | 70c24e710b9c5dddc49d87e0ea3e9e84298c9a26 | APPROVE | 0/0/0 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/373#issuecomment-6004926253 |
| #374 | 0ae9013fe06cbd1d5f1dbaf6ad6072f72f92358a | APPROVE | 0/0/1 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/374#issuecomment-6004926619 |
| #375 | a10123f222013416edff450b15bd1bd34952dd90 | APPROVE | 0/0/0 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/375#issuecomment-6004926992 |
| #376 | 6fabb1f989a985bf187552c2c8ad0f93d5486d4a | REQUEST CHANGES | 0/1/0 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/376#issuecomment-6004927452 |
Comment bodies: ops/aud-122/AUD-OPUS-RCH1-122/comments/c372..c376.md.
C-372-1 = C (edge, deferred to 10k clients): remaining credential-fence timing windows.

## CI (15:59 PDT)
All five heads green: #372 Typecheck, lint, test + Analyze (actions, js-ts) + CodeQL success; #373-#376 Typecheck, lint, test success.

## HANDOFF
- Done: 5 verdicts posted at exact heads (table above). Probe lane run done, audit branch deleted, worktree wt/AUD-OPUS-RCH1-122-376
  removed. Claims: ops/lanes122/claims/mobile-37{2..6}-<head8>-opus.
- Open: B-376-1 (fix belongs in #376 only: RomanChatScreen.tsx / useRomanChat.ts + tests). #372-#375 need no change; the train lands
  as one after #376 is fixed and both lenses approve the delta.
- Next lens (delta re-review, 20 min): check only B-376-1 and the changed lines. Verify: after deleting today's chat (one or all) from
  the history screens and returning, RomanChat shows no erased text and the next send goes to a freshly opened session; P1/P2 adapted
  as failing-before tests; control still passes. If #372-#375 heads move only by restack/merge, apply the A5 rule 12 tree check.
- Operator decisions: (1) treat B-376-1 as a B (default: yes; ordinary taps, dead end in the Roman message flow, deleted text still
  shown); (2) C-374-1 coach-list copy as a follow-up ticket (default: yes, after launch).
