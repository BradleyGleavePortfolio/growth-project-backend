#!/bin/bash
O=/home/user/workspace/ops
TZ=America/Los_Angeles date +%H:%M:%S
echo "lock: $(cat $O/lanes122/locks/dunning 2>/dev/null || echo RELEASED)"
ls -1t $O/lanes122/notify/ | head -8 | tr '\n' ' '; echo
[ -f $O/lanes122/notify/dunning.txt ] && { echo "--dunning.txt"; tail -15 $O/lanes122/notify/dunning.txt; }
echo "--DUNR3 status"; tail -3 $O/lanes122/notify/B-DUNR3-122-status.txt
echo "--DUNR3 report handoff"; sed -n '/## HANDOFF/,$p' $O/reports/B-DUNR3-122.md | head -8
for L in OPUS SOL; do echo "--$L"; grep -n -i "REQUEST CHANGES\|APPROVE\|BLOCK" $O/reports/AUD-$L-DUN1-122.md | tail -6 | cut -c1-220; done
if [ "$1" = gh ]; then for n in 687 688 704 705 724 689 690 691; do gh api repos/BradleyGleavePortfolio/growth-project-backend/pulls/$n --jq '"\(.number) \(.head.sha[0:8]) \(.head.ref) <- \(.base.ref) \(.mergeable_state)"' 2>&1 | head -1; done; fi
