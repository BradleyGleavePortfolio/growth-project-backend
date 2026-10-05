RESTACK (B-TR7-120, agent 120) — growth-project-backend#672 @ b0654c805c9ffd530b4cd0c1215fd4ed15bdc0e9

**Tier:** T4 (money path). Merge of the refreshed T1 `ea7a9740`, which contains main `ee55f814`, into T2 `62c2c066`. One merge commit with parents `62c2c066` and `ea7a9740`; no rebase, no force push. **This is not merge-only.** Main's fees stack (S-FEE) added the same email abort signal that T2 added in B-672-4, so `src/email/email.service.ts` and `src/email/email.types.ts` conflicted. **Size:** 2,959 changed lines (+2,956/-3, 15 files), down from 2,968 and under the grandfathered 3,000. Only the two email files' diffs changed; the other 13 files' diffs against the base are byte-identical.

### Conflict -> resolution -> commit -> test
| Conflict | Resolution | Commit | Test |
|---|---|---|---|
| Abort before the send-log row: T2 `_aborted()` returned `{status:'failed', error:'aborted'}`; main `notStarted()` returns `{status:'failed', notStarted:true}` | One helper: main's `notStarted()`, which now also carries `error: 'aborted'`. The trial notice keeps its failure code (`email:provider_failed`, unchanged from T2), and main's payout notice still checks `notStarted` first (`not_started`, unchanged) | `b0654c80` | `b-trials-t2-fix-round-8` "aborted caller burns no key" (expects `error: 'aborted'`, no log row, no request); main `s-fee-r19-refund-cas-send-window` |
| Abort right before the transport: main checks after render (`'aborted before send'`); T2 checked after the log-transport branch (`'aborted'`) | Main's check kept. T2's later duplicate dropped (no await between the two) | `b0654c80` | same + main email specs |
| Transport args / Resend request: T2 `idempotencyKey` + `Idempotency-Key` header + conditional `signal`; main `signal: args.signal` + `ProviderFailure` errors | T2's provider key, `_providerKey()` and header kept; main's `signal` form and error handling kept | `b0654c80` | `b-trials-t2-fix-round-8` provider-key test (same key on retry, new key on changed content) |
| `EmailTemplateKey` / `TEMPLATE_SUBJECTS` / `SendEmailInput` | Both template keys (`trial-ending`, `coach-payout-adjustment`), main's `signal` comment plus T2's `providerIdempotencyKey` | `b0654c80` | build-and-test |

Rule 12 does not apply because a conflict was resolved. A lens delta is requested on `src/email/email.service.ts` / `email.types.ts` only.

### CI at this head
All 10 checks are green, and deploy-readiness-gate is skipped: [build-and-test](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37344415892/job/111879279430) (full suite 777 suites / 13,280 tests passed, including `b-trials-t2-fix-round-8`, `email.service` and main's `s-fee-r19-refund-cas-send-window`), Schema parity, rls/community/mwb-3 live tests, rls-floor-guard, npm audit, size-label and test-deploy-readiness.

### Money-list self-check
- **Webhook order/redelivery:** no change in this piece.
- **Concurrency and lock order:** no change. An aborted send still spends no key before the log row, and a key spent after render is 'failed' with nothing sent (main's rule).
- **Terminal states:** unchanged on both callers (trial notice `email:provider_failed` -> pending retry; payout notice `not_started`).
- **Pagination/fail-closed completeness:** n/a.
- **Currency/minor units:** no change.
- **Copy truth:** no copy change. Both subjects are unchanged.

**Operator note (stack):** #673 was not restacked onto this head. Main's #678 conflicts with T3 in `checkout-webhook-handler.service.ts` and `billing.service.ts`, which changes #673's diff (job rule: stop and tell the operator).

READY FOR AUDIT
