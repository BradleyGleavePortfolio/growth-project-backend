#!/bin/bash
# LF-OPUS-126 poll: list agent126/fu-* PRs, head, READY lines, existing Opus verdicts at head
for r in mobile backend; do
  R=BradleyGleavePortfolio/growth-project-$r
  for n in $(gh pr list --repo $R --state open --json number,headRefName --jq '.[]|select((.headRefName|startswith("agent126/fu-")) or (.headRefName|startswith("agent126/r11c-126-mobile")))|.number'); do
    sha=$(gh api repos/$R/pulls/$n --jq .head.sha)
    br=$(gh api repos/$R/pulls/$n --jq .head.ref)
    ready=$(gh api repos/$R/issues/$n/comments --paginate --jq '.[]|select(.body|test("READY FOR AUDIT"))|.body|split("\n")[0]' | tail -1)
    opus=$(gh api repos/$R/issues/$n/comments --paginate --jq '.[]|select(.body|startswith("AUDIT Claude Opus 5.5"))|.body|split("\n")[0]' | grep -c "$sha")
    echo "$r#$n $br head=$sha opus_at_head=$opus"
    echo "   last READY: $ready"
  done
done
