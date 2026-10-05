#!/usr/bin/env bash
A=/home/user/workspace/ops/aud-121/B-SPLIT-COACHLESS-121
W=/home/user/workspace/wt/B-SPLIT-COACHLESS-121-2
cd $W && git checkout -q agent121/coachless-split-2-featured-home && echo "piece2 head $(git rev-parse HEAD)" > $A/jest-piece2.log
/home/user/workspace/ops/link_deps.sh backend $W >> $A/jest-piece2.log 2>&1
/home/user/workspace/ops/heavy.sh npx prisma generate >> $A/jest-piece2.log 2>&1
/home/user/workspace/ops/heavy.sh npx jest --ci --runInBand test/coachless/coachless-home.spec.ts src/feature-flags test/ci/fly-env-manifest.spec.ts >> $A/jest-piece2.log 2>&1; echo "rc=$?" >> $A/jest-piece2.log
cd /home/user/workspace/wt/B-SPLIT-COACHLESS-121-1 && echo "M' head $(git rev-parse HEAD)" > $A/tsc-Mprime.log
NODE_OPTIONS=--max-old-space-size=4096 /home/user/workspace/ops/heavy.sh npx tsc --noEmit -p tsconfig.json >> $A/tsc-Mprime.log 2>&1; echo "rc=$?" >> $A/tsc-Mprime.log
