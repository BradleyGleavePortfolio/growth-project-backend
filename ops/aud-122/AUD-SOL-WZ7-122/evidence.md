# AUD-SOL-WZ7-122 — exact-head evidence

## Clock and scope

- Started 2026-10-05 17:38:27 PDT; checkpoint 17:40:37 PDT, both from `TZ=America/Los_Angeles date`.
- Read the common 122 brief in full, only the assigned WZ7 job entry, current Source of Truth A1, A2 override items 1–11, A5 rules 11–12, and the lens contract.
- Read own prior Sol WZ6 report/verdict and the named builder report/comments; did not read the current Opus lens work.
- Repository stayed read-only; no worktree, local test/build, probe, lane, push, merge, or production access.

## GitHub and object verification

The reviewed [PR head](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/345) is `90e113bbcf9d1df530bd692a407b1c214598523f`, with tree `897fa9ea129b03f8eb4ce22d10a049f503a83b7a` and exactly parents `f7a86065bfe7e128eb4437b4124b63c1c2bb254a` and `3c315e40e83317a8ccf51431daa9ba98759df0bb`.

First parent and prior [Sol-approved #347](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/347#issuecomment-6006150588) `9c86167e81cac8b0da12aabf129d9210fc435695` both have tree `71c4f04e05d1c5888d7c634bfb5d9a74ac58e809`; `git diff --name-only` between them is empty.

`git rev-list --count f7a86065..90e113bb --not 3c315e40` returns 1, and the whole-merge `--remerge-diff --name-only` returns only the two source resolution files and four assertion files named in the [builder refresh record](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/345#issuecomment-6006513689).

## Reviewed output files

- `conflict_resolution.diff`: complete `git show --remerge-diff` for the two named source files, 940 lines.
- `refresh_vs_train.diff`: source comparison against the prior audited train.
- `refresh_vs_main.diff`: source comparison against merged main.
- `assertions_vs_train.diff`: both changed train assertion files.
- `assertions_vs_main.diff`: both changed main assertion files.
- `packagesApi.head.ts`, `CoachPackageEditScreen.head.tsx`: exact-head source snapshots with line references from the verdict.
- `git diff --check` passes on both relevant parent/source-test comparisons.

## Reviewed normal-use paths

- Package PATCH mapping keeps currency normalization, sends billing only when supplied, clears interval and count together for one-time, and preserves the train’s server-answer billing verification. [Reviewed package API](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/345).
- Editor omits unchanged billing on ordinary name/description edits, accepts main’s free one-time rule and paid floor, preserves the durable create intent path, and keeps main’s edit/publish error actions. [Reviewed editor](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/345).
- Draft publication uses a single idempotent API route, is disabled while visible terms differ from the saved row, and derives confirmed live state from the server row; live packages retain unpublish. [Reviewed source and tests](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/345).
- Four assertion deltas preserve free-name-edit, publish-header, no-unsaved-publication, saved-$199-publication, and one-time-count checks. [Reviewed test changes](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/345).

## CI evidence

- [Exact-head CI job](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37394221262/job/112046216784): completed/success, head `90e113bbcf9d1df530bd692a407b1c214598523f`, Lint/Typecheck/Test steps success.
- [CodeQL run](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37394220518): actions and javascript-typescript analyses success in the exact-head status rollup.
- [Existing targeted lane](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37393938209): completed/success, lane head `2279a588bc53912d2be6b445d837437bfbf8b3f9`.
- Lane-to-reviewed-head comparison changes only `.ci-lane-specs`, `.ci-lane-tsc`, and `.github/workflows/ci-lane.yml`; all production source and tests are identical. [Reused lane](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37393938209).

## Findings

A/B/C = 0/0/2, with no new findings and B-347-4 remaining closed. [Reviewed resolution](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/345).

C-347-1 editor owner guard; C-347-2 wizard owner rechecks — C (edge, deferred to 10k clients), carried unchanged without analysis. [Prior Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/347#issuecomment-6006150588).
