# Findings list from another model (owner pasted 10-06 14:42). Verify each against CURRENT main.
Highest priority:
- backend issue #662 database restore can resurrect deleted accounts, erased Roman chats, withdrawn AI consent, cancelled deletion schedules
- backend issue #732 rewritten Health Connect records create duplicate rows and double-count health totals
- backend issue #468 failed-email resend uses fuzzy recipient/body matching instead of a durable message id
- backend issue #407 first-payment push dedup can suppress a legitimate retry after transaction rollback
- mobile issue #275 concurrent cold-start auth bootstraps can race refresh-token rotation
- mobile issue #274 out-of-range macro values silently clamped by server, mobile shows the entered value
- mobile issue #260 workout-builder undo: two P1 failures (deletion markers, server-id adoption)
- backend PR #797 coach search / client profile scope can reach clients outside the coach's ownership (fix unmerged)
- backend PR #791 free package later priced can still be given away via old invite path (fix unmerged)
- backend PR #795 benign gym talk misclassified as emergency -> 911 (fix unmerged)
Backend backlog: #419 legacy RLS retirement; #404 wearable-prompt UUID migration (tables must be empty or backfilled); #260 free-tier
classification of 13 surfaces; #261 default-deny entitlement guard; #144 finance_eod_gap alert has no emitter; #406 push package
contents (dispatcher claim race P1, bulk-write throttle, strict schema, audit event); #408 community classroom (6 findings); #409 community
voice notes (2 findings); #410 coach review markers (5 findings); #422 named-regimes split; #429 + #495 migration-guard debt; #467 eslint
floors; #469 marketplace moderation hygiene.
Mobile backlog: #273 duplicate entitlement refresh (StrictMode, dev only); #255 community-search launch gate; #256 voice notes; #257 Roman
competence pill; #259 onboarding-polish components; #261 coach three-arc router (zero/error part in PR m#433); #271 flaky test; #272
over-broad error type. Mobile PR #302 import flow no_usable_result.
Claimed excluded/stale: mobile #190 already fixed on main (authActions.ts wipes onboarding_data + purges caches); mobile #258 obsolete;
backend #261 mostly superseded by PR #259 + #260; backend #369 omnibus should be closed/rewritten; backend #424 is an epic, not a defect.
