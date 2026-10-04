# DRAFT (not posted) — FIX ROUND 11 comments for #683 / #684, restack rounds for #685 / #686
Post only after CI at the heads below is final. Content = Fix round tables already in the #683/#684 PR bodies
(updated 2026-10-04 ~04:02 UTC) plus:
- #683 @ 35a18539c8a911524c3eab5b074b33e247f80ac2: red by design build-and-test 3 suites / 9 tests
  (checkout-webhook-fee-split 2, purchase-split-handler 2, reconciliation.service 5); F4 turns them green.
  operator-keys-artifact.spec.ts timeout was a flake: failed job rerun requested (run 37174989449).
- #684 @ e9ee033d425a61bb48efe2ac2387a23e5347acb0: expect all green.
- #685 @ 7425bb935456a64a13a08ae5bcd462bdc2873a39 / #686 @ 6f1b94a91f6a2b9e8142ac85970521b9285fff6c: merge-only;
  expected red by design: 7 copy-pinned tests in test/s-fee-r5-or-111-1.spec.ts (B-F12-116's F2 payout-notice-copy
  strings, not #684's), pending a later #685 job.
- Failing-before: run 37173415148 job 111350921741 (14 failed / 2 controls passed).
- Passing-after: run 37175462104 (tsc + spec at the F4 tree).
- Copy old -> new list: see #684 PR body and /home/user/workspace/ops/reports/B-F34-116.md.
