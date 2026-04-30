# Architecture decision records

Design proposals and architecture decision records (ADRs) for the
Growth Project backend live here. Operator-facing docs live one
directory up in [`docs/`](../README.md).

These documents are intentionally separate from the operator
documentation:

- **Operator docs** (`docs/*.md`) describe how the backend behaves
  *today* — env vars, route contracts, runbooks, smoke tests. They
  must stay in sync with `main`.
- **Architecture docs** (`docs/architecture/*.md`) describe proposals
  and decisions about the *future* shape of the system. An ADR may
  describe work that has not been merged yet, or that will land in
  multiple PRs over time. Each ADR carries a `Status:` line that
  reflects whether it is a draft, accepted, implemented, or
  superseded.

## Index

| ADR | Status | Title |
|---|---|---|
| [`adr-0001-team-mode-foundation.md`](./adr-0001-team-mode-foundation.md) | Draft | Team Mode foundation: multi-staff coaching businesses |

## Conventions

- File names: `adr-NNNN-kebab-case-title.md`, where `NNNN` is a
  zero-padded sequential number.
- Each ADR has, near the top: `Status`, `Date`, `Author`, and
  `Supersedes` / `Superseded by` (when relevant).
- ADRs are append-only in spirit: once accepted, prefer writing a new
  ADR that supersedes the old one rather than rewriting history.
- Drafts may be revised freely until accepted.
