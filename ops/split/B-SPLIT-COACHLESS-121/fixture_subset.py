#!/usr/bin/env python3
"""Piece-2 variant of test/coachless/coachless-fixture.ts: the full file minus the
CoachCodeRedemptionService import and construction (that service lands in piece 3)."""
import sys
s = open(sys.argv[1]).read()
imp = "import { CoachCodeRedemptionService } from '../../src/coachless/coach-code-redemption.service';\n"
ctor = """  const redemption = new CoachCodeRedemptionService(
    prisma,
    invites,
    lookup,
    featured,
    asAudit(audit),
  );
"""
ret = "  return { db, invites, analytics, audit, lookup, featured, prompts, home, redemption };\n"
for part in (imp, ctor, ret):
    assert s.count(part) == 1, part
s = s.replace(imp, "").replace(ctor, "").replace(ret, "  return { db, invites, analytics, audit, lookup, featured, prompts, home };\n")
sys.stdout.write(s)
