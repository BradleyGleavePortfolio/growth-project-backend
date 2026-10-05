# AUD-OPUS-TR10-122 verdict drafts (not posted: gh/GitHub auth 401 for the whole session)
Heads verified on GitHub (unauthenticated api.github.com) at 15:31 PDT 10-05. Post each file verbatim as a PR comment ONLY if the head is unchanged.
| PR | exact head | verdict | A/B/C | file |
|---|---|---|---|---|
| #671 | 565893b5c969fdc937d03f3a5b947bcb8d100b11 | APPROVE | 0/0/0 | verdict-671.md |
| #672 | 193c6f9ac3f57a10b8ff87fa3874ee0f190dd9b7 | APPROVE | 0/0/1 | verdict-672.md |
| #673 | 91d0adcbb3b1c5eef10266006a6a6a8c6b33f6a5 | APPROVE | 0/0/2 | verdict-673.md |
| #706 | 87aaf126036bc7604dceb3ab55f0ddf255519950 | APPROVE | 0/0/0 | verdict-706.md |
| #707 | 2bb4b368f39d8a380a48086c6c79d21cb4cc34b9 | APPROVE | 0/0/0 new, B-707-1 closed | verdict-707.md |
Post command (operator, auth working): for n in 671 672 673 706 707; do gh pr comment $n --repo BradleyGleavePortfolio/growth-project-backend --body-file verdict-$n.md; done
