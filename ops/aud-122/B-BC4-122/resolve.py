#!/usr/bin/env python3
"""B-BC4-122: resolve the #726 <- origin/main merge conflicts (unions; messaging custom).

Run inside the worktree while the merge is in progress. Prints each hunk and its resolution.
ours = HEAD (#726 broadcasts), theirs = origin/main.
"""
import re
import sys

LOG = []


def hunks(text):
    pat = re.compile(r"^<<<<<<< [^\n]*\n(.*?)^=======\n(.*?)^>>>>>>> [^\n]*\n", re.S | re.M)
    return pat


def resolve(path, fn):
    src = open(path).read()
    pat = hunks(src)
    n = [0]

    def rep(m):
        n[0] += 1
        ours, theirs = m.group(1), m.group(2)
        out = fn(n[0], ours, theirs, src, m)
        LOG.append(f"{path} hunk {n[0]}: ours {ours.count(chr(10))} lines, main {theirs.count(chr(10))} lines -> {out.count(chr(10))} lines")
        return out

    new = pat.sub(rep, src)
    if "<<<<<<<" in new or ">>>>>>>" in new:
        sys.exit(f"markers left in {path}")
    open(path, "w").write(new)


def union_main_first(_i, ours, theirs, _s, _m):
    return theirs + ours


def json_union(_i, ours, theirs, _s, _m):
    # Both sides end with their own last entry; main's entry gets a comma, then ours.
    t = theirs.rstrip("\n")
    o = ours.rstrip("\n")
    t_lines = t.split("\n")
    if not t_lines[-1].rstrip().endswith(","):
        t_lines[-1] = t_lines[-1].rstrip() + ","
    # ours: if a following line exists outside the hunk it already decides the comma; keep ours as is
    return "\n".join(t_lines) + "\n" + o + "\n"


def schema(i, ours, theirs, src, m):
    # End-of-file append conflict: both sides add models after the same last
    # model; the shared closing brace after the hunk closes main's last model,
    # so ours (broadcasts) needs its own closing brace.
    after = src[m.end():]
    if after.strip() == "}":
        return ours + "}\n\n" + theirs
    # Field-block conflict inside CoachMessage: union of fields.
    return ours + theirs


def messaging(_i, ours, theirs, _s, _m):
    if "card: { select: { card_type: true, ref_id: true, snapshot: true } }" not in ours or "reply_to" not in theirs:
        sys.exit("messaging hunk shape changed; resolve by hand")
    return (
        "      // A4 — rich card (workout, meal plan, booking, package, check-in) as a\n"
        "      // server-validated snapshot, read only while FEATURE_COACH_BROADCASTS is\n"
        "      // on. A3-MSG-CORE: the quoted message for swipe-replies (v2 only). With\n"
        "      // both flags off the query is byte-identical to the legacy one.\n"
        "      ...(withCards && v2\n"
        "        ? {\n"
        "            include: {\n"
        "              card: { select: { card_type: true, ref_id: true, snapshot: true } },\n"
        "              reply_to: {\n"
        "                select: {\n"
        "                  id: true,\n"
        "                  sender_id: true,\n"
        "                  body: true,\n"
        "                  voice_url: true,\n"
        "                  deleted_at: true,\n"
        "                },\n"
        "              },\n"
        "            },\n"
        "          }\n"
        "        : withCards\n"
        "          ? {\n"
        "              include: {\n"
        "                card: { select: { card_type: true, ref_id: true, snapshot: true } },\n"
        "              },\n"
        "            }\n"
        "          : v2\n"
        "            ? {\n"
        "                include: {\n"
        "                  reply_to: {\n"
        "                    select: {\n"
        "                      id: true,\n"
        "                      sender_id: true,\n"
        "                      body: true,\n"
        "                      voice_url: true,\n"
        "                      deleted_at: true,\n"
        "                    },\n"
        "                  },\n"
        "                },\n"
        "              }\n"
        "            : {}),\n"
    )


def messaging_post(path):
    s = open(path).read()
    old = (
        "  private async listThread(coachId: string, clientId: string, opts: ListOpts) {\n"
        "    const limit = this.clampLimit(opts.limit);\n"
        "    const before = this.parseBefore(opts.before);\n"
    )
    new = old + "    const v2 = isMessagingCoreV2Enabled();\n    const withCards = coachBroadcastsEnabled();\n"
    assert s.count(old) == 1, "listThread header changed"
    s = s.replace(old, new)
    imp = "import { isMessagingCoreV2Enabled } from './messaging-core.feature';\n"
    assert s.count(imp) == 1
    s = s.replace(imp, imp + "import { coachBroadcastsEnabled } from '../broadcasts/broadcasts.feature';\n")
    open(path, "w").write(s)


if __name__ == "__main__":
    resolve(".github/fly-env-desired-state.json", json_union)
    resolve(".github/workflows/ci.yml", union_main_first)
    resolve("docs/runbooks/launch-flags.md", union_main_first)
    resolve("prisma/schema.prisma", schema)
    resolve("src/account-deletion/account-deletion.manifest.ts", union_main_first)
    resolve("src/messaging/messaging.service.ts", messaging)
    messaging_post("src/messaging/messaging.service.ts")
    print("\n".join(LOG))
