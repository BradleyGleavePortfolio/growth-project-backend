**Tier:** T4
**Why:** tests only, but they are the acceptance evidence for the money path of R2 (#679): native Stripe subscription checkout, trial attempts, retire and cancel of unpaid attempts, and the client HTTP surface. No runtime code changes.
**T4 trigger scan:** money yes (specs for Stripe subscription create/cancel and attempt lifecycle; no runtime change); auth/tenancy: specs cover client-scoped purchase rows, no code change; privacy: specs assert log lines carry ids and allow-listed labels only; health data no; deletion no; migrations none; CI gate files no.
**T3 trigger scan:** n/a (T4).
**Bounded T1:** none.
**Canonical builder:** B-RECUR3-117 (agent 117); spec authors B-RECUR-116 (agent 116), B-RECUR-3 (agent 115), B-RECUR-BE (agent 114).
**Parent owner:** operator agent 117.
**Acceptance evidence:** the two files are byte-for-byte the ones removed from #680 in `1753f176` (as of `693015fa`); `git diff 693015fa <R4 head> -- <both files>` is empty. Local targeted jest on #680's tree: 14 recurring suites 223/223 (both files included). Required checks: build-and-test pending a green rerun (runner flakes only, see the Fix rounds row).
**Promotion triggers:** n/a (already T4).

Split R4 of the native recurring stack, cut under the owner's PR size rule (over 3,000 changed lines is an automatic fail, MODEL_ROUTING.md 8.2, tgp-agent-context) and operator 116's size ruling: #680 (R3) reached 3,717 changed lines after fix round 4, so the two specs that exercise R2's `SubscriptionCheckoutService` and HTTP surface move here. Stack: #686 (fees top) -> #678 (R1) -> #679 (R2) -> #680 (R3) -> this PR (R4). Merge back to back; deploy only after R4 together with mobile #334.

**R4 (base R3, 790 lines, tests only):**
- `test/b-recur-116-fix-round-3.spec.ts` (433 lines): R2 attempt lifecycle, resend and cancel races, log hygiene (B-654-9 / C-654-10). In fix round 4 of #680 one assertion follows the current one-trial rule (B-679-1): a failed stale-trial read reuses the open attempt (`sub_1`) instead of opening a second subscription.
- `test/b-recur-fix-round-1-http.spec.ts` (357 lines): the subscription-intent HTTP surface (unchanged).

Each piece needs fresh Opus 5.5 and Sol audits at its exact head (T4, money path).

### Fix rounds
| Round | Head | Findings | Comment |
|---|---|---|---|
| 0 (B-RECUR3-117, opened) | 48e690cd | split only; contents moved byte-for-byte from #680 693015fa; restack on #680 @ d1c62ee1 | [5976947082](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/696#issuecomment-5976947082) (not ready: build-and-test flakes) |
