**Tier:** T4 (access: who may decide an AI draft; tenancy roster checks)
**Why:** A coach can never approve or reject a gateway draft they requested (AUDIT-14-125 U2; SAFE-MWBAI-125 blocker 3), so every coach-side AI draft dead-ends unless the owner decides it. Before that rule is relaxed, `SendNotificationMaterializer` needed its roster check and `materialised_ref` write (AUDIT-14-125 "C"/"Not fixed" 3).
**T4 trigger scan:** access/tenancy — yes (decide rule, roster check, null-tenant drafts). Money/PII/credentials/destructive: no. No migration, no flag, no dependency.
**T3 trigger scan:** materialiser now writes `materialised_at` / `materialised_ref` on the draft row (same columns the other materialisers use).
**Bounded T1:** `src/ai/gateway/ai-approval.service.ts`, `src/ai/gateway/materialisers/send-notification.materialiser.ts`, two existing specs.
**Canonical builder:** B-AIB1-125 (Claude Opus 5.5, agent 125).
**Acceptance evidence:** `test/ai-approval.service.spec.ts` 14/14 and `test/ai-execution-stream2.spec.ts` 47/47 pass locally. The new cases fail on main (the coach self-decide cases 403 "cannot be decided by its requester"; the roster cases create a Notification; no `aiActionDraft.updateMany` call).

## Decide rule (AiApprovalService.decide)
1. Tenant boundary first (moved above the requester rule): a coach may decide only when `draft.tenant_coach_id === decider.id` (a draft with no tenant is now refused for coaches; it was allowed) AND, when the draft names a subject, that subject's `coach_id` is the deciding coach, re-read now. Owners unchanged.
2. Requester rule: the requester may still not decide their own draft, EXCEPT a tenant coach (role `coach`, own tenant, roster check passed) when (a) the payload was written by the model (the gateway default `{ reply: <model text> }`, matched against the stored rationale; `isModelAuthoredPayload`), or (b) the tenant has no active sub-coach (`TeamSubCoachAssignment` with `archived_at: null`), i.e. the coach is the tenant's only human. Human-written drafts in multi-coach tenants keep the rule. Owners stay bound by it.

## SendNotificationMaterializer
- Roster check before the Notification insert: the payload recipient must exist, have `coach_id === draft.tenant_coach_id`, and equal `draft.subject_user_id` when set; else 403 `AI_DRAFT_RECIPIENT_NOT_IN_ROSTER`, nothing sent.
- Writes `materialised_at` + `materialised_ref` on the draft (sent and P2002 race paths), so the decide gate (`materialised_ref IS NOT NULL`) no longer 409s after the push row exists.

## Fixes
- U (AUDIT-14 U2): a coach approves an AI draft for their own client and gets a 403 because they asked for it; now the tenant coach can decide it.
- B-guard (AUDIT-14 C, prerequisite): with self-decide open, a draft naming another coach's client could have pushed to that client once approved; the materialiser and decide now both refuse it.

## Reachability on the 10-07 build
- Pending AI drafts screen is unreachable after m#425 (Ask AI pill hidden), so no user-visible change at launch; this unblocks re-showing it and MWB-5 approvals later. No flags touched.

## Overlap
- b#593 (old, stacked on #587) touches `ai-approval.service.ts`; not rebased here. B-AIASSIGN-125 does not touch `src/ai/gateway`.
