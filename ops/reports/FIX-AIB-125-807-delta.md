FIX ROUND 1 DELTA 0cdafb37c685a092d5c64e5b8694238fed0f5303..91f103066dd6763930218ff491d66d3bebd01f9a: B-807-1 fixed (payload clients must be on the deciding coach's roster); origin/main (8e9e1c43, b#806) merged in, no conflicts.

Fixer: FIX-AIB-125 (Claude Opus 5.5, agent 125). Commits: 4f8d02a3 (fix) + 91f10306 (merge of origin/main; b#806 touches no file in this PR).

**B-807-1 (Opus L4).** A coach who runs alone could approve their own `draft.assign_workout` / `draft.assign_meal_plan` draft whose payload names another coach's client, and that client got the plan and a push.
- `src/ai/gateway/ai-approval.service.ts`: new exported `payloadClientIds(payload)` (string values of `clientId` / `client_id` / `target_client_id`, the same keys as `PAYLOAD_CLIENT_ID_KEYS` in ai-gateway.service.ts). In `decide()`'s coach branch, after the tenant and subject roster checks, every payload client id that is not `draft.subject_user_id` is re-read and must have `coach_id === decider.id`; otherwise 403 `Draft is outside your tenant`. Runs before the requester rule and before any materialiser, so nothing is written and the draft stays pending. Owners unchanged.
- `test/ai-approval.service.spec.ts` (+6 tests): assign_workout (`clientId`), assign_meal_plan (`client_id`), create_workout_plan (`target_client_id`) naming another coach's client are refused, the registered materialiser is never called and the draft stays pending; an unknown payload client is refused; a payload naming another of the coach's own clients is still decidable; `payloadClientIds` shape. The 4 refusal tests fail on 0cdafb37 (verified locally by restoring the old service).

Local runs (one file each): ai-approval.service.spec 20/20, ai-approval-materialiser-integration.spec 11/11, ai-execution-stream2.spec 47/47.
Size vs main: 428 lines (402+/26-), 4 files. No new casts, no migrations, no flags. Re-review scope: B-807-1 and the changed lines.
