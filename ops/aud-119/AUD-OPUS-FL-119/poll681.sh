#!/usr/bin/env bash
# polls #681 head every 180 s for 30 min (AUD-OPUS-FL-119 step 4)
L=/home/user/workspace/ops/aud-119/AUD-OPUS-FL-119/poll681.log
for i in $(seq 1 11); do
  h=$(gh api repos/BradleyGleavePortfolio/growth-project-backend/pulls/681 -q '.head.sha' 2>&1)
  echo "$(TZ=America/Los_Angeles date '+%H:%M:%S') poll $i head=$h" >> $L
  [ "$h" = "0bc3696d2bd1a25a4e963776db6f7f531881e4eb" ] && { echo "MATCH" >> $L; exit 0; }
  [ $i -lt 11 ] && sleep 180
done
echo "END no match" >> $L
