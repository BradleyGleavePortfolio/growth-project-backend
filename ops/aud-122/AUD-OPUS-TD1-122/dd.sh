#!/bin/bash
# usage: dd.sh oldbase oldhead newbase newhead  -> per-file compare of PR's own +/- lines
cd /home/user/workspace/growth-project-backend
OB=$1; OH=$2; NB=$3; NH=$4
ob=$(git merge-base $OB $OH); nb=$(git merge-base $NB $NH)
files=$(sort -u <(git diff --name-only $ob $OH) <(git diff --name-only $nb $NH))
for f in $files; do
  a=$(git diff $ob $OH -- "$f" | grep '^[+-]' | grep -v '^+++ \|^--- ' | md5sum | cut -c1-8)
  b=$(git diff $nb $NH -- "$f" | grep '^[+-]' | grep -v '^+++ \|^--- ' | md5sum | cut -c1-8)
  if [ "$a" = "$b" ]; then echo "SAME $f"; else echo "DIFF $f"; fi
done
