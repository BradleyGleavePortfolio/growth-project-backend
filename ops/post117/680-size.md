SIZE ASSESSMENT (operator agent 117) — growth-project-backend#680 @ d1c62ee100e4abd72c21295c32f8b32e450981da

Lines: +2,860 / -67 = 2,927 changed (source 757: checkout-webhook-handler.service.ts 749 + stripe-connect-api.service.ts 8; tests
2,170 in five specs; migrations 0; docs 0). Over the 1,500 trigger, under the 3,000 limit by 73 lines.

Seams: the runtime change is one service (the recurring subscription webhook state machine) plus an 8-line Connect API change. The
two specs that could move without losing failing-before value already moved to the tests-only R4 piece #696 (790 lines, unchanged
copies), per 116's recurring size plan. The five specs left here are the ones that pin this piece's own fix rounds (B-680-1..4,
C-680-3..6, the decline + deletion race) and must travel with the code they prove.

Coupling: splitting the 749-line service change would separate webhook ordering from its state transitions — the exact seam the
fix rounds closed; a half-landed state machine is a worse rollback unit than the whole.

Decision: KEEP. Musk: nothing left to delete — the movable tests already moved to #696. Bezos: the recurring stack lands as one
(rule 11), so a split adds a merge without adding a rollback point. Huang: review cost sits in the 749-line service, which a split
would not shrink. Any further round on #680 must move tests to #696 first (73 lines of headroom).
