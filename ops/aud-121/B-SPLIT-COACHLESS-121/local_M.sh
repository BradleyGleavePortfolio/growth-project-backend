#!/usr/bin/env bash
# local evidence on reference M (wt-1), one heavy job at a time
cd /home/user/workspace/wt/B-SPLIT-COACHLESS-121-1
A=/home/user/workspace/ops/aud-121/B-SPLIT-COACHLESS-121
/home/user/workspace/ops/heavy.sh npx prisma generate > $A/gen.log 2>&1; echo "rc=$?" >> $A/gen.log
/home/user/workspace/ops/heavy.sh npx tsc --noEmit -p tsconfig.json > $A/tsc-M.log 2>&1; echo "rc=$?" >> $A/tsc-M.log
/home/user/workspace/ops/heavy.sh npx jest --ci test/coachless test/account-deletion/erasure-manifest-coverage.spec.ts test/account-deletion/manifest-fk-order.spec.ts test/privacy/no-pii-in-logs.spec.ts test/ci/fly-env-manifest.spec.ts src/feature-flags test/roles-enforced.spec.ts > $A/jest-M.log 2>&1; echo "rc=$?" >> $A/jest-M.log
