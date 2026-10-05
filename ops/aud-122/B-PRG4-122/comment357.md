RESTACK (B-PRG4-122, agent 122) — growth-project-mobile#357 @ 670fea7555e0621d475455d8f8490b0ac6f28c6d — READY FOR AUDIT

**What changed:** merge-only. The #356 head d38b4a7045da9c8aa0bec262adba2428dc8da287 (B-PRG2-122 fix round; it carries #355 36fd39d9 with main 203e80e3) is merged into this branch. The merge was clean, with no conflicts and nothing resolved. P3's own diff is unchanged: 7 files, 2,421 lines (grandfathered 3,000).

**P3 findings at b364b9ea, triaged under the owner freeze (SoT A2 items 1-11, _COMMON_122 item 6):**
- Opus B-357-1 (a lost response reuses the request key): the operator ruled it C (edge, deferred to 10k clients). Not changed.
- Proposed C (edge, deferred to 10k clients), each pending an operator ruling:
  - **Sol B-357-1** (an unrelated second revision clears an unresolved conflict): only happens when two people edit the same program at the same time.
  - **Sol B-357-2** (the day picker keeps its key after an unknown outcome): same root cause as Opus B-357-1, which the operator ruled C.
  - **Sol B-357-3** (Duplicate writes the copy under the original program's cache key): the same handler invalidates every program query, and the original screen is still mounted, so it refetches straight away and again when it regains focus. The wrong data only shows if that refresh also fails.
  - **Sol B-357-4** (the old owner's mutation refills the cache or navigates after unmount or an account change): only happens if the coach signs out or switches account while a save is still in flight. React Navigation does not act on a goBack from a route that has left the stack.
- Opus C-357-1..7 and Sol C-357-1 stay follow-ups.

**Evidence:**
- PR CI "Typecheck, lint, test" passed at this head: https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37387969143/job/112025968914
- Lens probes were replayed at the #358 head (P3 + P4 code) in lane run https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37388378121.
  - P3 reds: Opus B-357-1 (operator C), Opus C-357-1 (= Opus B-355-2, operator C), Opus C-357-2, and Sol P3 conflict, day picker, duplicate and ownership (proposed C above).
  - Details are in the #358 comment.
- Report: ops/reports/B-PRG4-122.md.

READY FOR AUDIT: delta review of the merge only (no P3 bytes changed).
