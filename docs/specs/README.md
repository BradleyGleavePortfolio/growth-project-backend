# Specs

Engineer-facing specifications for expansion-track items. Each
spec follows the 16-section template (status banner; WHY; WHEN;
WHERE; WHO; WHAT; HOW; data-model sketch; API sketch; rollout
flags; RBAC + privacy; AI governance; analytics; tests; risks;
acceptance + operator handoff).

This folder is **docs-only**. Specs do not introduce runtime
code, schema migrations, env-var registration, or module wiring.
Each runtime PR descends from a spec, narrow and small enough to
review in under an hour, behind its own feature flag.

## Engagement & retention wave (rows #40–#44)

| Row | Spec | Brief |
|---|---|---|
| 40 | [`community-spaces.md`](./community-spaces.md) | [`../architecture/handoff/40-community-spaces.md`](../architecture/handoff/40-community-spaces.md) |
| 41 | [`events-live-calls.md`](./events-live-calls.md) | [`../architecture/handoff/41-events-live-calls.md`](../architecture/handoff/41-events-live-calls.md) |
| 42 | [`replays-content-library.md`](./replays-content-library.md) | [`../architecture/handoff/42-replays-content-library.md`](../architecture/handoff/42-replays-content-library.md) |
| 43 | [`rewards-and-bounties.md`](./rewards-and-bounties.md) | [`../architecture/handoff/43-rewards-and-bounties.md`](../architecture/handoff/43-rewards-and-bounties.md) |
| 44 | [`ai-business-copilot.md`](./ai-business-copilot.md) | [`../architecture/handoff/44-ai-business-copilot.md`](../architecture/handoff/44-ai-business-copilot.md) |

The wave addendum and gap map live in
[`../architecture/expansion-wave-engagement-retention.md`](../architecture/expansion-wave-engagement-retention.md)
and
[`../architecture/gap-map-engagement-retention.md`](../architecture/gap-map-engagement-retention.md).

## Spec template

Each spec opens with a status banner, then the six WHY / WHEN /
WHERE / WHO / WHAT / HOW questions, then the eleven supplemental
sections (data-model sketch, API sketch, media/storage,
moderation, RBAC + privacy, AI governance, feature flags +
entitlements, analytics, tests + risks + dependencies +
acceptance criteria + operator handoff). Each spec closes with
the list of decisions that must close before PR-1.

## Rules

- **No runtime in a spec PR.** Specs do not add migrations,
  env vars, modules, or routes.
- **Additive schema sketches only.** Spec data-model sketches
  follow the existing schema conventions (snake_case, uuid
  ids, explicit indexes, no implicit cascades that cross the
  tenancy axis) and reserve PR #118's `acted_by_member_user_id`
  forward-compat column on every new table.
- **Cross-references are explicit.** A spec naming a draft PR
  cites it by number; a spec naming a merged module cites the
  README path.
- **Drafts only.** Specs stay in PRs marked Draft until the
  founder + backend lead review and the §"decisions that must
  close" list is empty.
- **Edit in place.** As decisions close, the spec is edited in
  place, not appended.
