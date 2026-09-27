# proof/harness — TGP PostgreSQL proof lanes on GitHub Actions (GH-LANES, EXEC-42D8C5B5)

Orphan branch. Nothing here lands on main/integration, and candidate trees are never modified.

A run is a commit on `proof/run/<label>` whose tree is this harness plus a file `PROOF_TARGET`:

```
<40-hex backend commit>            line 1, required
HARNESS_SHA=<40-hex>               required (written by trigger.sh); the run commit's only parent, diff == PROOF_TARGET only
PKG_LOCK_SHA256=<64-hex>           optional; default = accepted tree b7fed5ed...9c55 (else REFUSED)
EXPECT_TOTAL_s11=133               optional pins, exact allowlist: EXPECT_TOTAL_<s11|s10b>, EXPECT_<stage>; decimal only
STAGES=guard,s10-unseen            diagnostic subset, ONLY together with PARTIAL=1 (verdict PARTIAL, never PASS)
PARTIAL=1
```
Unknown keys, duplicates, non-decimal values, a pin for a stage that will not run (e.g. absent journey-full) and
STAGES without PARTIAL=1 are refused in preflight (and again in aggregate).

`on: push: branches: ['proof/run/**']` runs `.github/workflows/proof-lanes.yml` from the pushed commit:

1. **preflight** (no PG): SHA format, shallow fetch of that exact commit, package-lock sha256, spec files present, matrix.
   Bad SHA / unknown stage / missing required spec / lock mismatch fails here.
2. **run** (matrix, parallel, fail-fast off). The authoritative jobs are `lane s11 ALL` and `lane s10b ALL`: each runs
   its lane's stages SERIALLY on ONE cluster with ONE bootstrap, in the local runner order (lane-s11.sh / lane-s10b.sh),
   stopping at the first failure. In addition, one fast-signal job per stage — S11 `rls-g2-s11, journey-core, readiness,
   settle-redrive, journey-induction, journey-full (only if present at HEAD), guard`; S10-B `rls-s10b-s10c, s10-unseen`.
   Each job: full fetch of the target into `target/`, setup-node 20.20.1, `npm ci`, PG 17.6 (zonky 17.6.0 with the same
   sha256 pins as the local runtime) + psql 18 (PGDG), fresh cluster, lane bootstrap (`migrate deploy`) + identity
   (170006, cluster_name, DB marker, applied == migration dirs at HEAD, last == max dir), then the stage exactly as the
   local runner (`proof/lanes.sh` = the local STAGE_TABLEs; same jest config, files, env, `--runInBand --ci --runTestsByPath`,
   pass rules). Receipt `RESULT` uploaded as artifact `result-<lane>-<stage>`.
3. **aggregate**: every `needs.<job>.result` must be `success`; re-parses PROOF_TARGET, re-checks the run-commit binding,
   re-derives the manifest from the target tree; the serial lane receipts must PASS exactly the manifest (SKIP only for an
   absent optional stage), lane totals > 0, fast-signal counts equal the lane counts, one binding (TREE, pkg-lock,
   client sha, exact applied-migration set) across jobs, every pin checked. PASS (exit 0) only in FULL mode; a clean
   PARTIAL run prints PARTIAL and exits 78. Summary shows harness_sha and the run commit.

Trigger: `[HARNESS_SHA=<reviewed>] proof/trigger.sh <label> <sha> [KEY=VALUE ...]` (parents the run commit on exactly
HARNESS_SHA, which must be on proof/harness; pushes only `proof/run/<label>`). Consumers must compare the summary's
harness_sha with the reviewed SHA out of band: a run commit can carry any workflow.
Watch: `gh run list --repo BradleyGleavePortfolio/growth-project-backend --branch proof/run/<label>`.
