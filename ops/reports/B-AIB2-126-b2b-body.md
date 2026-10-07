**Tier:** T4 (approval rule, who may decide an AI draft).
**Why:** AI master builder plan section 3 (`PATCH /ai/gateway/drafts/:id` with `accepted_change_ids`), SAFE-AIB-PRE-126 B3, and the m#439 approve contract (`materialised_ref { plan_id, revision_index, lock_token }`). Split out of growth-project-backend#809 to keep both PRs under the size cap.
**T4 trigger scan:** `tenantCoachMayDecideOwnDraft` gains one more yes (gateway-marked AI workout-builder draft); subset materialise (only removes ops; the materialiser re-validates and dry-runs); approve response for those drafts only.
**T3 trigger scan:** new optional body field on an existing route (validated, 400 on anything but `c<n>` ids).
**Bounded T1:** `selectAcceptedOps` (pure).
**Canonical builder:** Claude Opus 5.5 (B-AIB2-126, agent 126).
**Acceptance evidence:** CI on this head; `test/aib2b-subset-approve.spec.ts` (5) passes locally; fails on main and on #809 alone (imports and behaviour missing).

**Stacked on #809** (base `agent126/b-aib2-126`). Retarget to `main` when #809 merges. **#809 and this PR must both merge before the FLIP** (flags stay off until then, so neither is reachable in production).

## B/U it fixes
- B3 (SAFE-AIB-PRE-126): a head coach with one active sub-coach taps Apply on any Ask AI suggestion and is refused ("A draft cannot be decided by its requester"), because the old marker compared a hash of the payload JSON, and Postgres JSONB returns the keys in another order. Now: marker source + live-create capability (`ai-approval.service.ts:66-71`); only the gateway can add the marker (it strips caller provenance with that source, #809 `ai-gateway.service.ts:347`). Spec reorders the payload keys the way JSONB does.
- B (m#439 contract): a coach unticks a suggestion, taps Apply, and every change is applied anyway (the route ignored `accepted_change_ids`). Now only accepted ops are materialised and the stored payload is the applied subset (`ai-approval.service.ts:222-243, 259, 405`).
- B (m#439 contract): after Apply the builder could not adopt the new head (the response's `materialised_ref` was the plan id string; m#439 expects an object). Now workout-builder drafts return `materialised_ref: { plan_id, revision_index, lock_token }` (`ai-approval.service.ts:466-486`); `lock_token` is omitted when the autosave secret is unset (the builder then re-reads the plan).

## Response shape change (for B-AIB5P-126 / m#439)
- `PATCH /ai/gateway/drafts/:id` approve of a gateway-marked AI workout-builder draft: `materialised_ref` is `{ plan_id: string, revision_index: number, lock_token?: 16-hex }` instead of the plan id string. Every other draft is unchanged (string or null).
- New 400s: `INVALID_ACCEPTED_CHANGES` (not a list of `c<n>`), `ACCEPTED_CHANGES_UNSUPPORTED` (subset on a non-workout draft), `NO_CHANGES_ACCEPTED` (empty subset).

## SAFE checklist 1-12 (this PR's part; the rest is #809)
1-2. Consent / minimisation: no AI call, no client data read here.
3. Tenancy: unchanged tenant, roster and payload-client checks run before the marker is consulted (`ai-approval.service.ts:169-198`).
4. Human in the loop: the coach's explicit Apply decides; the marker only lets the tenant coach decide the model's own draft (`:145`); coach-authored drafts keep the no-self-approval rule (spec: no marker -> 403; marker on another capability -> 403).
5. Prompt injection: `accepted_change_ids` is validated to `c<n>` ids, max 400 (`ai-gateway.controller.ts:145-153`); it can only remove ops.
6. Output validation: the subset goes through the materialiser's schema check, base-revision check and pure-applier dry run (`:259`). A reorder applies only when every other op is accepted (`:73-77`).
7. Domain safety: subset of an already validated diff; nothing added.
8. Cost: no provider call.
9. Kill switch: the live-create materialisers re-check FEATURE_MWB_AI_LIVE_CREATE.
10. Logs: the lock-token warning logs the error name only (`:483`).
11. Store/legal: no copy change.
12. Mobile reachability: matches m#439 `aiBuilderApi.ts` DecideSchema.

## Not in this PR
- B4 (SAFE-AIB-PRE-126): sub-coaches cannot use Ask AI. Owner decision pending; recommended default for 10-07: hide Ask AI for sub-coaches.
- C (edge, deferred to 10k clients): a subset that keeps an update of a rejected add fails in the materialiser.

Size: 171 changed lines.
