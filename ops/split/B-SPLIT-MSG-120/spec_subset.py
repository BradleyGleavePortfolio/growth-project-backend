#!/usr/bin/env python3
# spec_subset.py <full-spec-file> <piece> -> prints the piece's version of test/messaging/messaging-core-v2.spec.ts
# Each piece's version is an in-order SUBSEQUENCE of the final file's lines, so every later piece only ADDS lines.
import sys
full = open(sys.argv[1]).read().split('\n')
k = int(sys.argv[2])
def rng(a, b): return set(range(a, b + 1))
P3 = rng(24, 30) | {40} | rng(186, 187) | rng(198, 199) | rng(399, 595) | rng(605, 619) | rng(635, 670) | rng(728, 841)
P4 = {35} | rng(292, 311)
owner = {}
for n in range(1, len(full) + 1):
    owner[n] = 4 if n in P4 else 3 if n in P3 else 2
keep = [full[n - 1] for n in range(1, len(full) + 1) if owner[n] <= k]
sys.stdout.write('\n'.join(keep))
