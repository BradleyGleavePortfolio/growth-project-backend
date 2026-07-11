# ADR — Danger Lockfile-Relevance Policy: Require a Lockfile Only on Dependency-Field Changes, Fail Closed on Uncertainty

- **Status:** Accepted
- **Date:** 2026-07-11
- **Decision owner:** Bradley Gleave (repo owner)
- **Implementation PR:** #505 — `ci/governance-hardening-r100-danger-fly`
- **Audit finding resolved:** O-1 (Lens B re-audit, R68 — doctrine-guard change lands without an ADR)
- **Affected files:** `dangerfile.js` (§3), `scripts/lockfile-relevance.js`, `test/ci/lockfile-relevance.spec.ts`

## Context

Danger's §3 lockfile check previously hard-failed on **any** `package.json`
change that did not also touch `package-lock.json`. That is a false blocker:
`package-lock.json` only encodes the resolved dependency graph, so a
scripts-, metadata-, or `version`-only edit cannot desync the lockfile and does
not need one. The importer work on **#504** legitimately edited non-dependency
fields of `package.json` and was blocked by this false positive, forcing either
a no-op lockfile churn or a Danger override — neither honest.

## Problem

The relevance check must distinguish a dependency-manifest change (which _does_
require a matching lockfile update) from a non-dependency edit (which does not),
**without** ever silently clearing a case it does not understand. A naive
"diff `package.json`, look for a dependency key" check degrades **open**: on an
unexpected Danger `JSONDiffForFile` shape or a read error it would fall through
to "no dependency change" and print a green ✅, masking a real dependency drift
(an R109 fake-green — the failure mode the quality doctrine forbids most).

## Options considered

- **(A) Keep the blanket hard-fail.** Simple, but a standing false blocker for
  every non-dependency `package.json` edit (the #504 class). Rejected.
- **(B) Relevance check that degrades open.** Clears when it cannot positively
  confirm a dependency change. Rejected — an unknown diff shape or read error
  would fake-green past a real dependency drift (R109 violation).
- **(C) Relevance check that fails CLOSED (SHIPPED).** Classifies the diff as
  `changed` / `unchanged` / `unrecognized`; requires the lockfile on `changed`,
  `unrecognized`, or a read error, and clears (with the ✅) **only** on a
  positively-confirmed `unchanged`.

## Decision

**Adopt Option (C).** The policy, implemented in `scripts/lockfile-relevance.js`
and wired into `dangerfile.js` §3:

1. **Dependency-field change ⇒ lockfile required.** A change to any of
   `dependencies`, `devDependencies`, `optionalDependencies`,
   `peerDependencies`, `overrides`, `bundledDependencies`,
   `bundleDependencies` fails the check until `package-lock.json` is updated.
2. **Non-dependency edit ⇒ no lockfile needed.** A scripts/metadata/version-only
   change clears with an explicit ✅.
3. **Uncertainty ⇒ fail closed.** An unrecognized diff shape or a diff-read
   error returns `required: true` with a named reason
   (`unrecognized-diff-shape` / `diff-read-failed`) and **never** emits the ✅.
   The success message is reachable only on the positively-confirmed
   no-dependency-change path, so an unexpected shape cannot produce a
   fake-green (R109).

## Consequences

- **Positive:** Removes the #504-class false blocker; the check is now a genuine
  dependency-**integrity** gate rather than a blanket nag. The fail-closed
  design means the relaxation cannot be exploited to slip a real dependency
  drift past review. The logic is a standalone CommonJS module, unit-tested
  (`test/ci/lockfile-relevance.spec.ts`) against hostile/degenerate diff shapes
  and the async provider seam — independent of the Danger DSL.
- **Negative / trade-off:** On an unrecognized diff shape the check is
  conservatively strict (asks for a lockfile that may not be needed). This is
  the intended safe default and is rare; the named reason tells the author why.
- **Safety / rollback:** Danger is non-gating on this repo: as of 2026-07-11
  `main` has no branch-protection rule or ruleset and no required status checks
  (verified via the GitHub branch-protection and rulesets APIs), so a Danger
  `fail(...)` annotates the PR but cannot block a merge — this change adjusts a
  soft signal, not a merge gate. (If required-check protection is later added,
  re-evaluate this statement.) Reverting is a single-file change: restore the
  prior blanket `fail(...)` in `dangerfile.js` §3 and drop the module + spec. No
  data or migration impact.

## Status of the audit finding

O-1 is resolved by this ADR: the lockfile-policy relaxation — the one genuine
policy _decision_ in #505 (the R100 pathspec/scope edits are corrective
bug-fixes) — is now recorded under `docs/decisions/` per R68, with its rationale,
the #504 blocker it unblocks, the alternatives weighed, and the fail-closed
safety/rollback posture.
