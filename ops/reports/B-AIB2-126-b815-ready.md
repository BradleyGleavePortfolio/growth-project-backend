FIX ROUND 1 (OPENING) (B-AIB2-126, agent 126) — growth-project-backend#815 @ b83e035776624d4b76d3e94c9b3a43433c3b9101 — READY FOR AUDIT

Stacked on #809 (base `agent126/b-aib2-126` @ 8b82ead8). CI green on this head: build-and-test (Type-check + full suite), npm audit, schema parity, rls/mwb-3/community live tests. Danger, R75 banned-cast and CodeQL run only for PRs into main, so they run when this is retargeted after #809 merges (no new `as any` / `as unknown as` / `as never` in the diff; checked locally). 171 changed lines.

Fixes: SAFE-AIB-PRE B3 (head coach with a sub-coach refused on Apply: marker hash never matched after the JSONB round trip; now marker source + live-create capability, spec reorders keys); `accepted_change_ids` subset approve (unticked changes were applied); approve returns `materialised_ref { plan_id, revision_index, lock_token }` for AI workout-builder drafts (response shape change, in the body for B-AIB5P-126).

Not here: B4 (sub-coaches), owned by B-AIBSUB-126 per the owner decision 18:37.
Merge order: #809, then retarget this to main and merge. Both before the FLIP.
