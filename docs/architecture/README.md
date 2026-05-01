# Architecture / pre-work

Cross-cutting architecture artefacts that sit above the
operator runbooks and below the per-module READMEs. Each file
here is docs-only and reversible; runtime work descends from
these as separate, narrow PRs.

This folder is intentionally lightweight. The two long-form
shapes are:

- **Wave addenda** — group N specs into a single retention
  loop / engagement loop / business loop, with a dependency
  graph and a fold-in plan once the parent roadmap PR
  (#119) merges.
- **Gap maps** — answer "do we have this already?" per row,
  mapped to the closest existing artefact (merged module or
  draft PR), so a reviewer can triage the wave without
  reading every spec end-to-end.

## Engagement & retention wave (rows #40–#44)

- [`expansion-wave-engagement-retention.md`](./expansion-wave-engagement-retention.md)
- [`gap-map-engagement-retention.md`](./gap-map-engagement-retention.md)
- [`handoff/`](./handoff/) — per-row operator briefs (rows 40–44).

## Conventions

- The **roadmap row number** is stable and append-only. Once
  assigned, a row is never re-numbered or re-used.
- The **handoff brief** stays operator-facing (60-second read,
  WHY/WHEN/WHERE/WHO/WHAT/HOW, risks, acceptance, kill-switch);
  the **engineer spec** in `docs/specs/` is the long form.
- Both files cross-reference each other and the related draft
  PRs (#117–#123) explicitly.
- A revert is always a flag flip; no destructive migration
  ever runs in the rollback path.
