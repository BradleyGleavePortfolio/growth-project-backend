# Deploy Readiness Runbook (R100)

**Who this is for:** Bradley (and any operator managing The Growth Project backend).

**Plain-English summary:** Before this product takes real money from real users, every integration has to be genuinely wired up, every safety switch has to be set correctly, and no placeholder code can sneak into production. Keeping that list in your head does not scale. This runbook explains the one automated board that checks all of it for you, how to read it, and what to do when it says do not deploy.

---

## What the board is

There is a single test, `test/deploy-readiness.spec.ts`, that runs seven checks and prints one board. Each check came from an earlier piece of work (labelled H4.A through H4.G); the board ties them together so you get one yes-or-no answer instead of seven separate reports.

The seven sections are:

| Section | Question it answers |
| --- | --- |
| STUB VALUES | Are there any leftover placeholder or stub values in production code that must be removed before launch |
| PROD SWITCHES | Is every production safety switch declared coherently in the registry, and is every must-set switch actually set |
| WIRING | Is every third-party integration (Stripe, Mux, SendGrid, Supabase, OpenAI, Twilio, Cloudflare, AWS S3, Fly, Sentry) actually credentialed rather than stubbed |
| ENV DISCOVERY | Is every environment variable referenced in the code also registered in the switch registry |
| AUTO-FLIPPER | Which switches would automatically flip to their production value on a production deploy (informational, never blocks) |
| OPERATOR KEYS | Which keys and secrets you, the operator, still need to provide |
| AGGREGATE EXIT | The single tally of red lines across every blocking section |

The board ends with one of two lines:

- `EXIT: ALL CLEAR -> SAFE TO DEPLOY` when there are no blocking red lines.
- `EXIT: N STUB + N PROD SWITCHES WRONG + N WIRING GAPS + N ENV GAPS + N KEY GAPS -> DO NOT DEPLOY` when there is at least one.

---

## The two ways the board runs

The same test runs on two surfaces, and it behaves differently on each. This is deliberate.

### On every pull request: informational

The `test-deploy-readiness` job runs on each pull request. It is informational: it posts the board as a comment on the pull request and does not block the merge during the pre-launch burn-down.

On a pull request it gates only the two checks that depend purely on the committed code: STUB VALUES and PROD SWITCHES. The other three blocking checks (WIRING, ENV DISCOVERY, OPERATOR KEYS) depend on which secrets are loaded into the environment. A pull request runner has no production secrets, so it would always see every integration as un-credentialed. Failing the pull request on that would be a false alarm, so those sections are printed for your awareness but do not block.

### On a production deploy: hard block

The `deploy-readiness-gate` job runs when you trigger a production deploy (manually via workflow dispatch, or by pushing to a `release/*` branch). It sets `DEPLOY_READINESS_STRICT=1`, which turns on strict mode: now every blocking section counts, including wiring, env discovery, and operator keys. If any section has a red line, the job exits non-zero and the deploy stops.

Because the production deploy environment is where the real secrets live, a genuinely ready build shows ALL CLEAR there and the deploy proceeds.

---

## How to run it yourself

From the backend repository root:

```
# Full board, informational (the pull-request view).
npm run test -- test/deploy-readiness.spec.ts

# Fast stub-only scan (what the pre-commit hook runs).
DEPLOY_READINESS_MODE=quick npm run test -- test/deploy-readiness.spec.ts

# Strict prod-deploy gate (what the deploy job runs). Requires the production
# secrets to be present in the environment to come back ALL CLEAR.
DEPLOY_READINESS_STRICT=1 npm run test -- test/deploy-readiness.spec.ts
```

The board is printed to the test log in all modes.

---

## What to do when it says DO NOT DEPLOY

Read the exit line. It tells you exactly which bucket has the problem and how many.

1. **STUB N** — open the STUB VALUES section. Each `[BLOCK]` line names a file and line with a leftover placeholder. Either finish the implementation, or, if it is a known and intentional placeholder, record it as tracked debt in the learning ledger at `test/prod-readiness/__fixtures__/learning-ledger.json` with a rationale. Tracked debt is downgraded from blocking to a warning automatically.

2. **PROD SWITCHES WRONG N** — open the PROD SWITCHES section. A coherence error means the registry itself disagrees with itself (for example a switch declared two different ways). Fix the registry at `prod-switches.yml`.

3. **WIRING GAPS N** — open the WIRING section. Each `[STUB]` line names an integration and which environment variables are missing or still placeholders. Provide the real credentials as Fly secrets.

4. **ENV GAPS N** — open the ENV DISCOVERY section. Each `[GAP]` line names an environment variable the code reads but the registry does not declare. Add it to `prod-switches.yml`.

5. **KEY GAPS N** — open the OPERATOR KEYS section. It lists, as ready-to-run `fly secrets set` lines, every secret you still owe. Run them.

After any fix, re-run the board until the exit line reads ALL CLEAR.

---

## Operator setup after this lands

Two one-time actions are yours to do once this is merged. Neither is done automatically and neither is part of the pull request that introduces the board.

1. Add `deploy-readiness-gate` to the production-deploy required status checks by re-running `scripts/setup-branch-protection.sh`. This is what makes the hard block actually enforced on production deploys.

2. Once the pull-request board has been stable for a while, promote `test-deploy-readiness` from informational to a required check so it blocks merges too.

---

## Where the pieces live

| Piece | Path |
| --- | --- |
| The orchestrator board and its tests | `test/deploy-readiness.spec.ts` |
| The section registry (which scanners run, in what order, gating or informational) | `test/prod-readiness.config.ts` |
| The seven sub-scanners | `test/prod-readiness/` |
| The switch registry | `prod-switches.yml` |
| The learning ledger (false positives and tracked debt) | `test/prod-readiness/__fixtures__/learning-ledger.json` |
| The CI workflow with both jobs | `.github/workflows/h4-readiness.yml` |
