#!/bin/bash
# Regenerates handoffs/op-115/LIVE_QUEUE.json (one line per wave PR: head, base, size, merge state, failing checks).
# Usage (needs gh auth): bash handoffs/op-115/tools/live_queue.sh   then   python3 handoffs/op-115/tools/live_queue_md.py
set -e
here=$(cd "$(dirname "$0")" && pwd); out=$(mktemp -d)
B="667 665 666 668 669 670 671 672 673 674 675 676 677 681 682 683 684 685 686 678 679 680 687 688 689 690 691 692 693 642 652 664 611 661 653 634 655 657 658 659 660 643 650"
M="342 343 344 345 346 347 348 349 350 351 352 353 354 355 356 357 358 359 360 361 362 363 364 365 366 367 312 315 321 335 338 340 339 341 331 336 337"
cd "$out"
( for n in $B; do echo "growth-project-backend $n"; done; for n in $M; do echo "growth-project-mobile $n"; done ) | xargs -P 8 -L 1 "$here/live_queue_one.sh"
jq -s 'sort_by(.repo,.number)' *.json > "$here/../LIVE_QUEUE.json"
echo "wrote $(jq length "$here/../LIVE_QUEUE.json") PRs"
