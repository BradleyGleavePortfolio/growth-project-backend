AUDIT Claude Opus 5.5 — growth-project-backend#687 @ c2a901a8f2552a166edc81b97454c9b7cd55df1c — VERDICT: REQUEST CHANGES
A/B/C = 0/1/3

**Scope.** D1 of the #628 split, base main `d23fa317`, 22 files: migration `20270215000000_dunning_billing_actions` + down.sql, schema, `.env.example`, `prod-switches.yml`, `jest.config.js`, `client-billing.money.ts`, `dunning-effective-access.ts`, `stripe-connect-api.service.ts`, email service/types + two templates, 7 fixtures, two test fakes. Nothing in D1 calls the new code yet (callers arrive in D2-D4). The only change on a live path is the Stripe client's error parsing, and it only adds fields.

**Evidence reuse (G09).** All 22 files are byte-identical to #628 @ `dc47e0ef` (checked file by file). For files unchanged since this lens's APPROVE on #628 @ `739e9a54` (comment 5957537166) — money helpers, effective access, email service/types, both templates, fixtures — the logic evidence is reused, and the files were read again in full for this verdict. That re-read found B-687-1, which the earlier approval missed. The migration, down.sql, schema, jest.config.js, prod-switches.yml, .env.example, the Stripe client and both fakes changed since `739e9a54`, so they were audited fresh. No other lens's verdict was read before this one.

**CI at this head.** All 11 required checks are green: build-and-test https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37152165227, plus CodeQL, danger, banned casts, sbom, schema parity (forward/reversible), npm audit, rls-floor, rls-live, mwb-3 and community-live.

### B-687-1 — first person in customer-facing email copy
- `src/email/templates/dunning-v2-client.hbs:13`: "Questions about this payment? Reply to this email and a person on **our** team will help." "our team" is first person. The standing copy rule bans first person in product copy (same class as the "write to us" ruling, OR-112-21). This line is the footer of every v2 dunning email a client receives.
- Counterexample: the string is present at this head. A grep of all copy added in D1+D2 finds no other first person, no exclamation mark and no emoji.
- Fix rule: drop the first person, e.g. "Questions about this payment? Reply to this email to reach a person who can help." Add a template voice test that renders both `dunning-v2-*.hbs` templates and asserts no `\b(we|our|us)\b` and no exclamation mark. Verify: the test fails on the current line and passes after the fix.

### C (notes, not blocking)
- **C-687-2** `src/checkout/client-billing.money.ts:37`: the doc says "in first-seen currency order", but `:52` sorts alphabetically. Fix the comment.
- **C-687-3** `jest.config.js:149` adds `workerIdleMemoryLimit: '2GB'`. This is CI-gate config shared with the B-CI-116 lane, so the operator should check that the two changes do not conflict. Not unsafe.
- **C-687-4** Migration `20270215000000` sorts before migrations already applied (`20270216+`). The operator ruled that it stays (S-DUNNING-R4-112), and the forward/reversible/schema-parity checks are green. Note only.

### Verified (no finding)
- RLS ENABLE + FORCE on all four new tables, a service_role policy each, anon REVOKE + deny policy. down.sql drops only what the migration creates. The new tables hold no user id: they are keyed on purchase or DunningState with ON DELETE CASCADE. `DunningState.client_canceled_at` is a nullable additive column.
- Stripe client: reads the `Idempotent-Replayed` header; `declineCode`/`replayed` are additive error fields; `listOpenInvoices` follows `has_more` and throws on a missing cursor; `expand payment_intent` is valid on the pinned `2024-09-30.acacia`. Other edits in the file are formatting.
- Fake Stripe: caches executed requests (including errors) by idempotency key, and does not cache errors raised before execution. That is adequate fidelity for the specs that use it.
- `FEATURE_DUNNING_V2` is registered in prod-switches.yml (OFF, never auto-flipped) and is `false` in `.env.example`.

**Outside this PR (reported to the operator, not blocking).** C-628-14, C-628-15 and the B-628-11 replayed-pay handling live in `client-billing.service.ts` (D3 #689). They are verified there, not here.

Head re-read right before posting: `c2a901a8f2552a166edc81b97454c9b7cd55df1c`.
