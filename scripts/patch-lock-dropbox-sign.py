#!/usr/bin/env python3
"""Add @dropbox/sign (+ its only missing transitive dep, bluebird) to
package-lock.json so `npm ci` in CI stays in sync with package.json.

Disk constraints prevent a real `npm install`; this mirrors exactly what npm
would write for lockfileVersion 3. Idempotent.
"""
import json
import collections

LOCK = "package-lock.json"

with open(LOCK) as f:
    d = json.load(f, object_pairs_hook=collections.OrderedDict)

pkgs = d["packages"]

# 1) root dependency entry (keep alphabetical-ish: npm sorts by key).
root_deps = pkgs[""]["dependencies"]
if "@dropbox/sign" not in root_deps:
    root_deps["@dropbox/sign"] = "^1.8.0"
    # re-sort root deps the way npm does (ASCII sort by key)
    pkgs[""]["dependencies"] = collections.OrderedDict(
        sorted(root_deps.items(), key=lambda kv: kv[0])
    )

# 2) @dropbox/sign package node.
pkgs["node_modules/@dropbox/sign"] = collections.OrderedDict([
    ("version", "1.8.0"),
    ("resolved", "https://registry.npmjs.org/@dropbox/sign/-/sign-1.8.0.tgz"),
    ("integrity",
     "sha512-Bnq6sYP+o7gFYGaxEQ0g0ZDkGFK6z8Yd+O0A77KHPN+QZaoGAVI+Ifn021kR57aW1dUXpW+hW+iQBkl2HPl/LA=="),
    ("license", "MIT"),
    ("dependencies", collections.OrderedDict([
        ("axios", "^1.7.0"),
        ("bluebird", "^3.7.2"),
        ("form-data", "^4.0.0"),
        ("qs", "^6.10.3"),
    ])),
])

# 3) bluebird (only missing transitive dep; 3.7.2 has no deps).
if "node_modules/bluebird" not in pkgs:
    pkgs["node_modules/bluebird"] = collections.OrderedDict([
        ("version", "3.7.2"),
        ("resolved", "https://registry.npmjs.org/bluebird/-/bluebird-3.7.2.tgz"),
        ("integrity",
         "sha512-XpNj6GDQzdfW+r2Wnn7xiSAd7TM3jzkxGXBGTtWKuSXv1xUV+azxAm8jdWZN06QTQk+2N2XB9jRDkvbmQmcRtg=="),
        ("license", "MIT"),
    ])

# Re-sort the packages map by key (npm keeps node_modules/* sorted; the root ""
# key sorts first under ASCII because '' < 'n').
ordered = collections.OrderedDict(
    sorted(pkgs.items(), key=lambda kv: kv[0])
)
d["packages"] = ordered

with open(LOCK, "w") as f:
    json.dump(d, f, indent=2)
    f.write("\n")

print("Patched", LOCK)
print("@dropbox/sign present:", "node_modules/@dropbox/sign" in d["packages"])
print("bluebird present:", "node_modules/bluebird" in d["packages"])
