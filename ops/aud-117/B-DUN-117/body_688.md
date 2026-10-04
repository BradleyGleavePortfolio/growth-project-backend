**Tier: T4 (money path).** Current head: `6718d211` after FIX ROUND 1 (B-D12-116). The stack lands as one: D1 -> D2 -> D3 -> D4 -> D5, deployed only after D5 together with mobile #322.

Split of #628 (dunning v2 live: card update, lockout, recovery; 12,334 lines at FIX ROUND 8 `dc47e0ef`, already current with main `d23fa317`) under the owner's PR size rule: over 3,000 changed lines is an automatic fail (MODEL_ROUTING.md 8.2, tgp-agent-context). Cut with an import-order check (no piece imports a later piece). Stack: D1 -> D2 -> D3 -> D4 -> D5, merged back to back; deploy only after D5, together with mobile #322. At split time the tree at D5 equalled #628's head (git diff); fix rounds change it from there. Behaviour notes for the owner from FIX ROUND 8 carry over: third-party-paid invoices settle one reconcile run later, and a dispute that arrives mid-cycle keeps the cycle open. No verdicts existed at dc47e0ef; each piece needs Opus 5.5 and Sol audits at its exact head (T4, money path). `tsc --noEmit` passes at every piece.

**D2 (base D1, 2,926 lines after FIX ROUND 1):** dunning v2 service and legacy dunning hooks, with the service spec, the fix-round spec, and existing specs that import these files. FIX ROUND 1 moved the cadence and dispatcher to D1, where the D1 title already placed them.

**Link change (Opus C-688-2):** the v1 dunning email `billing_portal_url` default changed from `https://thegrowthproject.app/billing` to `DUNNING_UPDATE_CARD_URL` (`https://app.trygrowthproject.com/billing/update-card`). The default is not flag-gated, and `BILLING_PORTAL_URL` is unset in production, so every v1 dunning email links to the card-update page. That page exists only from D4 (#690). This is one more reason the stack deploys only after D5.

## Fix rounds
| Round | Job | Head | Closed | Comment |
|---|---|---|---|---|
| 1 | B-D12-116 (agent 116) | `6718d211` | Sol B-688-1..B-688-5; Opus B-688-1, C-688-2, C-688-3, C-688-4, C-688-5 | [FIX ROUND 1](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/688#issuecomment-5976393847) |

