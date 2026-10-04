#!/bin/bash
# usage: mkrestack.sh <n> <old> <new> <lowerpr> <lowernew> <pid> <ownstat> <runurl> <tests>
n=$1; old=$2; new=$3; lpr=$4; lnew=$5; pid=$6; own="$7"; run=$8; tests="$9"
cat <<EOT
FIX ROUND 1 (restack, merge-only; B-W2-117, agent 117) — growth-project-mobile#$n @ $new

Mechanical restack under the \`wear\` lock after [FIX ROUND 1 on #360](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/360#issuecomment-5976937429) (B-360-1, head \`fde1875edc1bd5d14ac8fda4f2e68ee8b7c5ebf5\`). No content edit in this piece; no conflict.

| Item | Value |
|---|---|
| Old head | \`$old\` |
| New head | \`$new\` = merge commit, parent 1 \`$old\`, parent 2 \`$lnew\` (#$lpr head) |
| Base branch | unchanged (#$lpr's branch) |
| This piece's own diff (base head -> head) | $own; \`git patch-id --stable\` before = after = \`$pid\` (byte-identical) |
| Delta old head -> new head | the 4 B-360-1 files only (\`healthConnectSyncService.ts\`, \`onDeviceConnect.ts\` and their two suites, +169/-2); patch-id equal to #360's \`4a508d8b..fde1875\` |
| Whole stack | \`git diff d0407b62 a3206441\` (#317 head vs new top #364) = the clinic \`easUpdateGuard\` pin already at #364 + those 4 files only |
| Findings | none open on this piece (no AUDIT verdict posted yet at the old head) |
| CI at this exact head | Typecheck, lint, test = SUCCESS, [run]($run)$tests. Analyze runs only on main-based PRs (\`codeql.yml\`), so it does not run on this stacked head. |

Lens note: no verdict exists at the old head, so this head takes its normal full piece audit; the only change from the old head is the #360 fix above (\`git diff $old $new\`). Rule 12 does not cover a restack. Land as one (rule 11).

READY FOR AUDIT
EOT
