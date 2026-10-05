# AUD-OPUS-S12-117 complete

- **mobile #345** `a4e4958820053b5aaa0f2d4a8c14f140816541b2`: REQUEST CHANGES, A/B/C 0/2/3.
  - B-345-1: the update PATCH drops the billing cadence (`packagesApi.ts:439-447`), so a package can go live monthly while the app says one-time, and paid-to-free gets stuck.
  - B-329-5 (retained): the helper admits a create after the owner or mount changed.
  - [Verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/345#issuecomment-5977036236)
- **mobile #346** `4522eb8e550119a5cb770b93b9525290b4ffb03f`: REQUEST CHANGES, A/B/C 0/2/3.
  - B-346-1: first-person copy at `CoachSetupChecklist.tsx:121` and `CoachSetupScreen.tsx:44`.
  - B-329-5 caller part: `FirstPackageForm.tsx:194-219`.
  - [Verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/346#issuecomment-5977036337)
- **Probe runs.** [37180178650](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37180178650) and [37180389838](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37180389838).
- **Defaults.** Land #345-#351 as one unit, then one W1+W2 fix round, then fresh dual verdicts.
- **Paths.** Report at `/home/user/workspace/ops/reports/AUD-OPUS-S12-117.md`; probes and logs at `/home/user/workspace/ops/aud-117/AUD-OPUS-S12-117/`.
- **Cleanup.** Audit branches deleted; worktrees removed.
