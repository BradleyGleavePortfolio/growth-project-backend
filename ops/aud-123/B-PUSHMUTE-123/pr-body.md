## Summary
Community push now honours the recipient's "Mute all notifications" switch (B-S-PUSH-1). Before this change a member who muted everything still got community push, for example when another member replied to their post: `CommunityNotificationsService.sendCommunityPush` ignored the `null` from `createNotification` (the mute gate) and called `pushToUser` directly.

The wrapper now reads the recipient's push gate (`NotificationsService.channelGate`) before the replay guard, inbox write and send, and returns with telemetry reason `muted` when the gate reports the global mute. Only the global mute is honoured: community kinds have no per-kind preference columns and the core gate maps them onto `digest` (push default off), so stopping on `createNotification() === null` or on the gate's `off` would silence every community push. The community defaults table stays the per-kind source of truth.

## Linked plan / brief
Agent 123 wave 3 fix queue F1 (B-PUSHMUTE-123); scout report S-PUSH-123 finding B-S-PUSH-1.

## Test plan
- New `test/community/notifications/community-push-mute.spec.ts` runs the real `NotificationsService` preference gate over stubbed Prisma, spying only `pushToUser`:
  - muted member, ordinary reply: no `pushToUser`, no inbox row, `community.push.skipped` with reason `muted` (fails on main: push is sent);
  - unmuted member (digest push off): the reply sends with the community title, privacy-on body and `client_bot` category;
  - no preferences row yet: the reply sends.
- Local: the new spec through heavy.sh (3/3 pass; 1/3 fails against main's service file); eslint clean on both files. Full suite and tsc in PR CI.

## Rollback plan
Revert this commit. No schema, flag or config change.

## Audit pack pointer
Report: ops/reports/B-PUSHMUTE-123.md (operator workspace).

---

## R-rule self-check (every checkbox required; N/A allowed with one-line justification)

- [x] **R23 LOC cap:** net additions ≤ 400. Actual: 133 (15 src, 119 test, 1 deletion)
- [x] **R18 lane scope:** this PR touches only the lane it was briefed against
- [x] **R100 prod-readiness:** N/A, no config or deploy surface changed
- [x] **R100 deploy-readiness board: ALL CLEAR** (PR CI)
- [x] **R75 banned cast tokens:** zero net new
- [x] **R74 test:src ratio:** ≥ 2.0. Actual: 119 / 15 ≈ 7.9
- [x] **R92 RLS impact:** no RLS change
- [x] **R98 PII statement:** this PR does not touch PII (reads the recipient's own mute flag; telemetry carries kind + enum reason only)
- [x] **R82 + R106 migration safety:** N/A, no migrations
- [x] **R83 feature flag:** existing FEATURE_COMMUNITY_PUSH gate unchanged
- [x] **R86 SLO:** N/A, no new endpoint (one indexed preference read on a fire-and-forget path)
- [x] **R90 idempotency:** N/A, no new mutation endpoint
- [x] **R3 commit identity:** Bradley Gleave <bradley@bradleytgpcoaching.com>, no AI/Co-Authored tokens
- [x] **R6 push cadence:** single small commit
- [ ] **R14 audit cycle:** pending dual audit

## Dependencies
None. Server-side only; no mobile build dependency.

## Notes for auditor
The mute check sits inside the existing try/catch, so a preference read failure is logged and skipped like any other send failure; it never throws to the comment write.
