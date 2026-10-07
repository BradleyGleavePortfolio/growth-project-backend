#!/usr/bin/env bash
# FU-BOOK-126: run ONE jest file through heavy.sh in the FU-BOOK-126 worktree, log to reports/FU-BOOK-126-jest-<name>.log
cd /home/user/workspace/wt/FU-BOOK-126-mobile || exit 1
name=$(basename "$1" | sed 's/\..*//')
/home/user/workspace/ops/heavy.sh npx jest --forceExit "$1" > "/home/user/workspace/ops/reports/FU-BOOK-126-jest-$name.log" 2>&1
echo "EXIT $?" >> "/home/user/workspace/ops/reports/FU-BOOK-126-jest-$name.log"
