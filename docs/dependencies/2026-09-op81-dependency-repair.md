# Dependency repair: overrides, advisory evidence and removal conditions (2026-09)

Scope: the `overrides` block of `package.json` on PR #524 head
`238f0f1f152ebbb1b4691f555e98c888473d8ee7` (base `c23b9d9f3fcc106b92c061ceb7d04d7ec53038d7`).
This note exists so the rationale travels with the commit instead of living only in a
PR description. It documents why each override exists, which consumer it is meant to
affect, the primary advisory evidence, and the condition under which it should be
removed. It is not a release approval and it does not claim the repository's
outstanding release-control findings are closed.

Manifest and lockfile are unchanged by this note. The amendment that added it touched
only this document, `test/dependency-compatibility.spec.ts`, and a **comment-only** edit
to `.github/workflows/danger.yml` (the stale duplicated Danger version statement); no
workflow step, condition or command changed.

## Why some overrides are keyed to an exact parent version

`@prisma/config@6.19.3`, `@nestjs/platform-express@11.1.26` and `@nestjs/swagger@11.4.4`
each declare an **exact** version of the dependency being replaced. A version-keyed
(nested) override was chosen deliberately: it forces the patched child only inside the
parent whose graph was actually exercised by the compatibility tests, instead of forcing
one version on every consumer in the tree, some of which declare different majors and
were not tested against it.

The trade-off is real and must be understood: a nested override keyed to
`parent@version` stops applying once that parent resolves to a different version.
What the new parent's graph will contain is unknown in advance — it may already depend
on a patched child, or it may not. Likewise, a resolved major line that this note does
not list is **unreviewed** here: that means no floor has been configured for it and it
needs review, not that the major has no patched release. The safety property is
therefore not asserted from the manifest text; it is asserted from the resolved graph
by the
`keeps every advisory-patched floor resolved under its real consumer` test in
[`test/dependency-compatibility.spec.ts`](../../test/dependency-compatibility.spec.ts),
which fails when a consumer resolves a version below its configured patched floor, or a
major line for which no floor is configured (reported as unreviewed). Comparisons use
the installed `semver` (resolved through `ts-jest`'s declared `^7.7.4` dependency, so no
manifest entry is added), and a prerelease of a patched version — `8.0.0-rc.1` against an
`8.0.0` floor — is treated as below the floor. Renovate minor/patch automerge is
active in this repository, so that test is the gate that notices such a change; it is
complementary to, not a substitute for, the still-outstanding required `npm audit`
CI step (audit findings A-F04 / B-13).

## Override register

| Override                                                    | Intended consumer                                                                                                                                                                                                                                                                                      | Resolved on this SHA                              | Advisory evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Removal condition                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"@prisma/config@6.19.3": { "deepmerge-ts": "8.0.0" }`      | `@prisma/config` 6.19.3, which declares `deepmerge-ts` exactly `7.1.5`                                                                                                                                                                                                                                 | `deepmerge-ts@8.0.0`                              | Uncontrolled recursion / stack exhaustion on recursive object graphs in `deepmerge()` and `deepmergeInto()`, affected `< 8.0.0`, patched `8.0.0`: [GitHub Advisory GHSA-ggr8-5vv4-36mx](https://github.com/advisories/GHSA-ggr8-5vv4-36mx), [NVD CVE-2026-40345](https://nvd.nist.gov/vuln/detail/CVE-2026-40345)                                                                                                                                                                    | Remove when `@prisma/config` itself declares `deepmerge-ts >= 8.0.0` (verify with the resolved-floor test, then drop the key). This is a cross-major force (7.x → 8.x), so removal or re-keying must be accompanied by the CommonJS, ESM and real `loadConfigFromFile` probes passing on the new parent.                                                                                                                |
| `"@nestjs/platform-express@11.1.26": { "multer": "2.3.0" }` | `@nestjs/platform-express` 11.1.26, which declares `multer` exactly `2.1.1`                                                                                                                                                                                                                            | `multer@2.3.0`                                    | Four denial-of-service issues fixed in `2.3.0`: CVE-2026-77037 / GHSA-qfvm-cv95-jqjf (fd leak on aborted uploads), CVE-2026-77078 / GHSA-wc9g-mqfw-jrwm (uncaught `RangeError` from crafted field names), CVE-2026-82333 / GHSA-535w-7cp7-47q4 (oversized array index blocks the event loop), CVE-2026-77063 / GHSA-qvfw-j98x-7q72 (`fileSize` bypass via async `fileFilter`) — [Express security releases, 2026-08-31](https://expressjs.com/en/blog/2026-08-31-security-releases/) | Remove when `@nestjs/platform-express` declares `multer >= 2.3.0`. Multipart success, truncated-body and `LIMIT_FILE_SIZE` probes must pass under the new parent first.                                                                                                                                                                                                                                                 |
| `"@nestjs/swagger@11.4.4": { "js-yaml": "4.3.2" }`          | `@nestjs/swagger` 11.4.4, which declares `js-yaml` exactly `4.1.1`                                                                                                                                                                                                                                     | `js-yaml@4.3.2` (shared with the root direct pin) | `maxTotalMergeKeys` does not limit CPU use for empty merge sources; affected `>= 4.0.0, < 4.3.2` and `>= 3.0.0, < 3.15.2`, patched `4.3.2` / `3.15.2`: [GHSA-2883-xcg3-v3hh](https://github.com/nodeca/js-yaml/security/advisories/GHSA-2883-xcg3-v3hh), CVE-2026-84375                                                                                                                                                                                                              | Remove when `@nestjs/swagger` declares `js-yaml >= 4.3.2`. Swagger `load`/`dump` and duplicate-key behaviour must stay asserted.                                                                                                                                                                                                                                                                                        |
| `"qs": "6.16.0"` (unscoped)                                 | `express` (`^6.14.0`) and `body-parser` (`^6.15.2`) reached through `@nestjs/platform-express → express` and `@nestjs/platform-express → express → body-parser`, plus `@dropbox/sign` and `@gitbeaker/*` — all declare `^6.x`, so one patched 6.x satisfies every consumer without a cross-major force | `qs@6.16.0`                                       | Denial of service via attacker-controlled `isBuffer`; affected `>= 2.2.5, <= 6.15.3`, patched `6.16.0`: [GHSA-4mjr-xmp4-gh2g](https://github.com/ljharb/qs/security/advisories/GHSA-4mjr-xmp4-gh2g), CVE-2026-82417                                                                                                                                                                                                                                                                  | Remove when every consumer's own range floor is at or above `6.16.0`. Kept unscoped precisely because it stays inside major 6 and needs no per-parent keying.                                                                                                                                                                                                                                                           |
| `"diff": "9.0.0"` (unscoped, narrowed from `^9.0.0`)        | `ts-node` (`^4.0.1`) and `@flydotio/dockerfile` (`^7.0.0`), both development-only                                                                                                                                                                                                                      | `diff@9.0.0`                                      | `parsePatch` infinite loop on `\r`, `U+2028`, `U+2029` in filename headers. The advisory patches each affected line separately: `3.5.1`, `4.0.4`, `5.2.2`, and `8.0.3` for the `>= 6.0.0, < 8.0.3` range: [GHSA-73rr-hh4g-fpgx](https://github.com/advisories/GHSA-73rr-hh4g-fpgx), CVE-2026-24001. `9.0.0` is outside every affected range; the change on this SHA is the removal of the floating `^` (R114), not a new security fix.                                               | Removable once each consumer resolves a version patched **in its own line** — `4.0.4` satisfies `ts-node`'s `^4.0.1` and `5.2.2` patches the 5.x line, so a compatible older major is an acceptable outcome and not every `< 8.0.3` version is vulnerable. Configure that line's floor in the invariant test before dropping the override; bump the exact value when a newer `diff` is adopted, do not restore a range. |

## Override removed on this SHA

The previous global `"minimatch": "^9.0.7"` override was **removed**. It forced a major
that several consumers do not support (`test-exclude` and
`fork-ts-checker-webpack-plugin` use the 3.x API), which broke real Istanbul
instrumentation selection. After removal the tree contains minimatch 3.1.5, 5.1.9,
9.0.9, 10.2.5 and 10.2.6 — every one at or above the patched floor for its own line in
[GHSA-3ppc-4f35-3m26](https://github.com/advisories/GHSA-3ppc-4f35-3m26)
(CVE-2026-26996: `3.1.3` / `4.2.4` / `5.1.7` / `6.2.1` / `7.4.7` / `8.0.5` / `9.0.6` /
`10.2.1`). The presence of an older major is therefore not by itself an advisory
finding. The `test-exclude → minimatch` pair is included in the resolved-floor test so
a future dedupe cannot silently drop below `3.1.3`.

`@istanbuljs/load-nyc-config` keeps `js-yaml` 3.15.2 (its own `^3.13.1` range) rather
than being forced across majors; 3.15.2 is the patched 3.x release in
GHSA-2883-xcg3-v3hh, and its `safeLoad` API is asserted separately from Swagger's
`load`.

## Evidence in tests

`test/dependency-compatibility.spec.ts` supports this note with real package
behaviour, not version strings:

- CommonJS `deepmerge` semantics (cycles, nested objects, arrays, `Map`, `Set`) plus an
  assertion that the `require` condition selects `dist/index.cjs`.
- A separate ESM probe whose working directory is the directory holding
  `@prisma/config`'s resolved entry file — a directory inside that package, commonly a
  build output directory rather than the package root — so Node's upward `node_modules`
  lookup follows the consumer's own resolution chain. A bare `deepmerge-ts` specifier
  resolves to `dist/index.mjs` under the `import` condition, in the same physical
  package as the CommonJS entry, and merge and `deepmergeInto` behaviour is asserted
  through that binding. `import.meta.resolve` requires Node >= 20.6; the only runtime
  confirmed for this repair is Node 20.20.1, and `node-version: '20'` plus the
  `node:20-slim` image tag are moving references that were not verified here.
- A real `loadConfigFromFile` load of a temporary Prisma config, with the fixture
  removed in `finally` on success and retained with its path printed only when the
  probe fails.
- A real Danger local Git-object read, kept as a separate concern from the INI
  assertions: `ini@5` is installed because `danger` 13 declares `ini: ^5.0.0` and is
  resolved from `danger` for that reason, but Danger 13 dropped `parse-git-config` and
  nothing inspected here shows Danger parsing `.git/config` through `ini`, so no such
  claim is made.
- Hostile-key INI parsing (`__proto__` keys, `__proto__` and quoted `"__proto__"`
  sections, a dotted `constructor.prototype` section) asserting ini@5's actual output:
  hostile sections and keys are dropped, parsed containers have a null prototype, a
  dotted `constructor.prototype` section becomes inert own data on a null-prototype
  object rather than a mutation of the real `Object.prototype`.
- The resolved-consumer floor invariant described above.

## Verification status

Every statement above is derived from the lockfile, the packages' published sources and
the cited advisories. The tests described here were written but **not executed in the
change that produced this note**: no install, compile, lint or test run happened here.
The only runtime confirmed for this work is Node 20.20.1, from validation performed
separately; no other Node 20 patch release and no Docker image tag was verified.

## Sources

- deepmerge-ts: <https://github.com/advisories/GHSA-ggr8-5vv4-36mx>, <https://nvd.nist.gov/vuln/detail/CVE-2026-40345>
- multer: <https://expressjs.com/en/blog/2026-08-31-security-releases/>
- js-yaml: <https://github.com/nodeca/js-yaml/security/advisories/GHSA-2883-xcg3-v3hh>
- qs: <https://github.com/ljharb/qs/security/advisories/GHSA-4mjr-xmp4-gh2g>
- diff: <https://github.com/advisories/GHSA-73rr-hh4g-fpgx>
- minimatch: <https://github.com/advisories/GHSA-3ppc-4f35-3m26>
