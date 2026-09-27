# proof/harness — TGP PostgreSQL proof lanes on GitHub Actions (GH-LANES, EXEC-42D8C5B5)

Orphan branch. Nothing here lands on main/integration, and candidate trees are never modified.

A run is a commit on `proof/run/<label>` whose tree is this harness plus a file `PROOF_TARGET`:

```
<40-hex backend commit>            line 1, required
STAGES=rls-g2-s11,guard            optional subset (default: every stage of both lanes)
PKG_LOCK_SHA256=<64-hex>           optional; default = accepted tree b7fed5ed...9c55 (else REFUSED)
EXPECT_TOTAL_s11=127               optional lane totals / EXPECT_<stage>=<n> exact stage totals
```

`on: push: branches: ['proof/run/**']` runs `.github/workflows/proof-lanes.yml` from the pushed commit:

1. **preflight** (no PG): SHA format, shallow fetch of that exact commit, package-lock sha256, spec files present, matrix.
   Bad SHA / unknown stage / missing required spec / lock mismatch fails here.
2. **stage** (matrix, parallel, fail-fast off): one job per stage — S11 `rls-g2-s11, journey-core, readiness,
   settle-redrive, journey-induction, journey-full (only if present at HEAD), guard`; S10-B `rls-s10b-s10c, s10-unseen`.
   Each job: full fetch of the target into `target/`, setup-node 20.20.1, `npm ci`, PG 17.6 (zonky 17.6.0 with the same
   sha256 pins as the local runtime) + psql 18 (PGDG), fresh cluster, lane bootstrap (`migrate deploy`) + identity
   (170006, cluster_name, DB marker, applied == migration dirs at HEAD, last == max dir), then the stage exactly as the
   local runner (`proof/lanes.sh` = the local STAGE_TABLEs; same jest config, files, env, `--runInBand --ci --runTestsByPath`,
   pass rules). Receipt `RESULT` uploaded as artifact `result-<lane>-<stage>`.
3. **aggregate**: requires a PASS receipt for every scheduled stage, one binding (TREE, pkg-lock, client sha, migrations)
   across jobs, 0 skipped, and any pinned EXPECT_* totals; writes SUMMARY.md (job summary + artifact `summary`).

Trigger: `proof/trigger.sh <label> <sha> [KEY=VALUE ...]` (from a clone with this branch; pushes only `proof/run/<label>`).
Watch: `gh run list --repo BradleyGleavePortfolio/growth-project-backend --branch proof/run/<label>`.
