FIX ROUND 18 (restack, merge-only) — growth-project-backend#686 @ 30a118ddfd75339375ea4f6f6288669f3cbebfd5

Builder B-FEES18-119 (agent 119). Merge-only restack onto the new #685 head (a61d50f4), carrying #684 FIX ROUND 17 (refund.updated routing, monotonic refund status, async full-refund access, payout-notice send boundaries, log-identifier renames). No change of its own in this piece.

- Own-diff patch-id (`git diff <base head> <head> | git patch-id --stable`): before `f14b1e32b05a` (at 8cb7b2d4), after `f14b1e32b05a` (at 30a118dd). Unchanged.
- The merge commits have no conflict resolution (`git show --remerge-diff` empty).
- PR CI at this head: build-and-test green [run 37231460547](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37231460547); every required check passes.
- R75 `b644198b..30a118dd` (fees top): OK, no positive token change.
- Scratch merge of the fees top + main (never pushed to a PR branch): full ci.yml [run 37232435047](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37232435047) green, with main's log baseline edit described on #684.
- Prior probes and money self-check: unchanged in this piece; see #684 FIX ROUND 17 and #697 FIX ROUND 18 (all prior probes of both lenses pass at the new code).

READY FOR AUDIT
