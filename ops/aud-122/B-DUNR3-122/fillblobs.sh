#!/bin/bash
# fill missing blobs of given revs from extracted trees (content-addressed; only writes when hash matches)
R=/home/user/workspace/growth-project-backend
SRCS="$R /home/user/workspace/wt/AUD-SOL-DUN1-122-724 /home/user/workspace/wt/AUD-SOL-DUN1-122-691 /home/user/workspace/wt/AUD-SOL-DUN1-122-725 /home/user/workspace/wt/AUD-SOL-TR10-122-top"
for rev in "$@"; do
  git -C $R rev-list --objects --missing=print "$rev^{tree}" 2>/dev/null | grep '^?' | sed 's/^?//' > /tmp/miss.$$
  for oid in $(cat /tmp/miss.$$); do
    # find path for oid
    p=$(git -C $R ls-tree -r "$rev" | awk -v o=$oid '$3==o{print $4; exit}')
    [ -z "$p" ] && continue
    for s in $SRCS; do
      f="$s/$p"; [ -f "$f" ] || continue
      h=$(git -C $R hash-object --no-filters "$f")
      if [ "$h" = "$oid" ]; then git -C $R hash-object --no-filters -w "$f" >/dev/null; break; fi
    done
  done
  left=$(git -C $R rev-list --objects --missing=print "$rev^{tree}" 2>/dev/null | grep -c '^?')
  echo "$rev left=$left"
done
