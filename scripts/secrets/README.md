# scripts/secrets/

Helper scripts for secrets rotation operations.

## Scripts

| Script | Usage | Purpose |
|---|---|---|
| `list.ts` | `npx ts-node scripts/secrets/list.ts` | Scans source for `process.env.X` references vs `SECRET_INVENTORY` |
| `rotate-jwt.ts` | `npx ts-node scripts/secrets/rotate-jwt.ts` | Generates new JWT key + prints flyctl rotation commands |
| `check-staleness.ts` | `DATABASE_URL=... npx ts-node scripts/secrets/check-staleness.ts` | Warns if any secrets are overdue for rotation |

All scripts are read-only with respect to Fly secrets — they print the `flyctl` commands you need to run, but never execute them directly. This is intentional: you always review before running.

See `docs/runbooks/secrets-rotation.md` for the full per-secret playbook.
