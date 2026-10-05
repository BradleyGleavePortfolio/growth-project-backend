#!/bin/bash
# dd.sh oldbase old newbase new [files...] : compare added/removed lines of the PR diff per file
ob=$1; o=$2; nb=$3; n=$4; shift 4
files="$@"; [ -z "$files" ] && files=$( (git diff --name-only $ob $o; git diff --name-only $nb $n) | sort -u)
for f in $files; do
  A=$(git diff -U0 $ob $o -- "$f" | grep -E '^[+-]' | grep -vE '^(\+\+\+|---) ' )
  B=$(git diff -U0 $nb $n -- "$f" | grep -E '^[+-]' | grep -vE '^(\+\+\+|---) ' )
  if [ "$A" != "$B" ]; then echo "##### CHANGED PR-LINES: $f"; diff <(echo "$A") <(echo "$B") | head -${MAXL:-80}; fi
done
