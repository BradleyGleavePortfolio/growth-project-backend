| # | Where (src/connect/fees/payout-notice-copy.ts) | Old | New |
|---|---|---|---|
| 1 | heldSentence, any event, held_open_cents > 0 | `We will hold {held_open} from your next sale.` | `{held_open} is held from your next sale.` |
| 2 | refund / chargeback, coach, reversed_cents > 0 | ` We took {reversed} back from that sale's payout.` | ` {reversed} was taken back from that sale's payout.` |
| 3 | refund / chargeback, head coach, reversed_cents > 0 | ` We took {reversed} back from your share of that sale.` | ` {reversed} was taken back from your share of that sale.` |
| 4 | dispute_won, reinstated_cents > 0 | `We paid {reinstated} back to you` | `{reinstated} was paid back to you` |
| 5 | dispute_won, reinstated and released | ` ... and released the {released} hold.` | ` ... and the {released} hold was released.` |
| 6 | dispute_won, released only | ` We released the {released} hold.` | ` The {released} hold was released.` |

Unchanged (already impersonal): titles, `A client got {x} back.`, `A client's bank took back {x} in a dispute.`, `You won the dispute on a {x} charge.`, `Nothing is held from your next sale.`, the dispute_lost body, heldBreakdownLines labels.

#685 expectations a later #685 job must update (test/s-fee-r5-or-111-1.spec.ts; 7 tests red by design after this restack):
- :304 and :310 -> `A client got $100.00 back. $94.80 was taken back from that sale's payout. $5.20 is held from your next sale.`
- :401 -> `A client's bank took back $100.00 in a dispute. $94.80 was taken back from that sale's payout. $20.20 is held from your next sale.`
- :460 -> `A client got $100.00 back. $100.00 is held from your next sale.`
- :530 -> `You won the dispute on a $100.00 charge. $79.80 was paid back to you and the $20.20 hold was released. Nothing is held from your next sale.`
- :543 -> `A client got $40.00 back. $40.00 was taken back from that sale's payout. Nothing is held from your next sale.`
- :927 -> `$4.20 is held from your next sale.`
- :937, :962, :965 -> `$1.00 is held from your next sale.`
