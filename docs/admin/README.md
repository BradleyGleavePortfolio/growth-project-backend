# Admin console docs

This directory holds the canonical specs for the OWNER admin console
(`tgp-admin-web`). The console is a **separate frontend repo** that
consumes `growth-project-backend`'s `/api/admin/*` surface — it is
distinct from the mobile app, the coach console BFF, and the public
`new-website`.

## Files

| File | Purpose | Status |
|---|---|---|
| [`control-room-spec.md`](./control-room-spec.md) | Canonical target shape — EHR/Healthie/Athena-style operator control room. Inventories every shipped `/api/admin/*` endpoint and grades the gaps as §11.A–O. | Draft |
| [`deployment-and-rbac.md`](./deployment-and-rbac.md) | How the console is deployed, how operators authenticate, the advisory client-side capability matrix, and the optional admin mobile companion wire contract. | Draft |
| [`pr-sequence.md`](./pr-sequence.md) | Reconciles §11 gap letters with concrete future runtime PR numbers. The single source of truth for which PR closes which gap. | Draft |

## Reading order

1. `control-room-spec.md` — what the console is and the gap inventory.
2. `deployment-and-rbac.md` — how it's wired and who can do what.
3. `pr-sequence.md` — the runtime work that closes the gaps.

## Superseded specs

- **PR #127** (`docs/admin-web-dashboard.md` on the
  `docs-admin-web-dashboard-spec` branch) — the original "admin web
  dashboard" framing. **Superseded.** Its unique sections (deployment
  shape, RBAC capability matrix, screens not in #128, mobile companion
  contract, PR sequencing table) have been migrated into the files in
  this directory. Recommend closing PR #127 unmerged once the
  canonical PR is merged.

- **PR #128** (`docs/admin/control-room-spec.md` on the
  `docs/admin-control-room-spec` branch) — the EHR control-room
  reframe. **Adopted as the canonical primary spec.** Carried forward
  unchanged in this directory.
