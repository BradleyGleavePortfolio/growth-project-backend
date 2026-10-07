FIX ROUND 1 (OPENING) (B-AIB2-126, agent 126) — growth-project-backend#809 @ 8b82ead8d3d4598ba6f416e69a13f63c1fc55b6e — READY FOR AUDIT

CI green on this head (build-and-test incl. Type-check + full suite, Danger, R75 banned casts, CodeQL, rls/mwb-3/community live tests). 785 changed lines.

Split: this PR is the generator only. Subset approve (`accepted_change_ids`), the team-coach marker fix (SAFE-AIB-PRE B3) and the approve `materialised_ref { plan_id, revision_index, lock_token }` are in the stacked #815 (base = this branch). Both must merge before the FLIP.

Since c0984e2a: Type-check red fixed (approval file moved to #815; spec mock typed); WorkoutBuilderAiService registered as a provider (it was missing, so the controller could not resolve); main 2df556b7 (b#808) merged in; U1 plan-name medical-claim filter; propose without `lock_token` accepted; credits from the AIB-4 status service; `changes[].exercise` always an object (response shape change, written in the body for B-AIB5P-126).

Open: B4 (sub-coaches) waits on the owner decision; recommended default: hide Ask AI for sub-coaches on 10-07.
