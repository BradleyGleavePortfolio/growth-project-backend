MAIN REFRESH (B-340-122, agent 122) — growth-project-mobile#340 @ 62794564f340020b7b562911e8a531f065612576

**Base retargeted** from `agent/clinic/s-coach-money-mob` (retired; its content landed on main through the money train #348-#351 -> #345) to `main`.

**What changed**
- One merge commit `62794564` (parents `2e77dcb6` = previous head, `1fc46ff8` = main). Fast-forward push, **no force-push**; the PR's own commits are kept as they were.
- All 17 conflicted files (wizard, setup, packages, money screens: the old base's versions vs main's money train) take main's side. On top of main sits only this PR's own patch (`git diff 90701485..2e77dcb6`), which applied cleanly. No new code in this round.
- Main's money screens keep main's behaviour: against main, `MoneyScreen.tsx` changes only the export path (imports, `csvFileFailure`, the screen/session guards from B-340-1, `exportCsv`, the share-as-text note) plus one note re-wrapped with the same words. Main's B-348-1 "Not paid yet" and B-349-2 "Held from your next sales" copy are unchanged.

**Story:** a coach taps "Export tax CSV" and gets a real .csv file in the share sheet, ready to save to Files or attach to an email. Where the system cannot share files, the CSV goes out as text and the screen says so.

**Diff vs main (new size):** 6 files, +645 −55 = **700 lines** (699 without the one-line `package-lock.json` entry). Files: `src/lib/money/csvFile.ts` (+113), `src/lib/money/__tests__/csvFile.test.ts` (+114), `src/screens/coach/money/MoneyScreen.tsx` (+92 −14), `src/screens/coach/money/__tests__/money.test.tsx` (+324 −41), `package.json` / `package-lock.json` (+1 each: `expo-file-system ~56.0.8`, already in main's lock as an Expo dependency at 56.0.8). Same size as before the refresh.

**CI**
- Mobile CI lane at this head (`.ci-lane-tsc` + 10 specs: csvFile, money, moneyChargeTruth, moneyNavigation, moneyCopyMon2, repoHygiene, coachSaasBlockers, paymentsConnectPackages, romanP3HostWiring, romanP3FlagOff): tsc pass, 10/10 suites, 208/208 tests ([run 37395728254](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37395728254); the lane commit `522a1feb` has this head as its only parent and adds only the lane files).
- PR CI (Typecheck, lint, test) at `62794564`: PR_CI_STATE

**For the audit:** Sol's RC (10-03) and FIX ROUND 1 for B-340-1 at `2e77dcb6` were never audited; the code under review is that fix round, now on main.

READY FOR AUDIT — diff vs main 700 lines (6 files, +645 −55).
