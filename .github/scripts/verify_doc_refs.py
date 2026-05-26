#!/usr/bin/env python3
"""
verify_doc_refs.py — R15 enforcement.

Scans every Markdown file in the repository for references to .md / .yml /
.yaml / .ts / .tsx / .js / .py / .sql / .sh / .json / .toml file paths.
For each reference, checks whether the path exists in the repo.

If a referenced path does NOT exist and is NOT on the allowlist
(.agent-doc-allowlist), the script exits 1 and prints the offending file +
reference. Fails the CI job.

Allowlist format:
    # comments allowed
    relative/or/bare/filename.md
    Another-Doc.md

The allowlist is a temporary safety net while stranded legacy docs are
rescued into tgp-agent-context. Goal: empty allowlist.

Why this exists:
    Prior operator agents lost canonical docs (CPO_MASTER_HANDOFF.md Part 1,
    R36_TO_R45_OPERATOR_RULES.md, SUPABASE_RLS_CRISIS.md, agent-context/)
    when their sandboxes died. The files were referenced in handoffs but
    never pushed to GitHub. This check makes that failure mode physically
    impossible going forward.
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path
from typing import Iterable

REPO_ROOT = Path(__file__).resolve().parents[2]
ALLOWLIST_PATH = REPO_ROOT / ".agent-doc-allowlist"

# Directories we don't recurse into when scanning for .md files.
SKIP_DIRS = {
    ".git",
    "node_modules",
    "dist",
    "build",
    ".next",
    ".turbo",
    "coverage",
    ".cache",
    "out",
}

# File extensions that "look like" doc/code paths and are worth verifying.
TRACKED_EXTENSIONS = {
    ".md",
    ".yml",
    ".yaml",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".py",
    ".sql",
    ".sh",
    ".json",
    ".toml",
}

# Path-like references in Markdown: backticked `foo/bar.md`, bare
# foo/bar.md, or markdown links [text](foo/bar.md). We capture the path
# itself.
PATH_PATTERN = re.compile(
    r"""
    (?:                                # path may be wrapped in:
        `([^`\s]+?\.[a-zA-Z0-9]{1,6})` # backticks: `path.md`
        |
        \[[^\]]*\]\(([^)\s]+?\.[a-zA-Z0-9]{1,6})(?:\s[^)]*)?\) # markdown link
        |
        (?<![A-Za-z0-9/_\-])           # boundary: not part of a longer ident
        ([A-Za-z0-9_./\-]+?\.[a-zA-Z0-9]{1,6}) # bare: path.md or dir/path.md
        (?![A-Za-z0-9])
    )
    """,
    re.VERBOSE,
)

# Substrings that, if present in a candidate, mean it's not a real path:
# template placeholders, globs, env-var interpolation, code-fence noise.
NONPATH_INDICATORS = (
    "<", ">",       # <YYYY-MM-DD>, <<EVIDENCE>>, etc.
    "*",            # globs: *.json, **/*.md
    "$",            # ${VAR}, $foo.bar
    "{", "}",       # template literals
    "%",            # printf-style
    "..",           # path traversal in examples
)

# Bare identifiers that look like "foo.bar" but aren't paths.
NONPATH_BARE_NAMES = {
    "node.js",
    "next.js",
    "nest.js",
    "react.js",
    "vue.js",
    "express.js",
    "nx.js",
    "e.g.",
    "i.e.",
    "etc.",
    "vs.",
    "v1.0",
    "v2.0",
    "v3.0",
}

# Prose-y stems that, when found as the only token of a bare reference
# (no directory prefix), are framework names not file paths.
NONPATH_PROSE_STEMS = {
    "node",
    "next",
    "nest",
    "react",
    "vue",
    "express",
}

# File extensions that are almost never actual file references in prose
# (TLDs, version numbers, prose abbreviations).
NONPATH_EXTENSIONS = {
    ".js",  # too ambiguous in prose — "Node.js", "Next.js" etc.
            # We accept .js paths only when prefixed with a dir.
}

# We only care about paths that look like documentation or in-repo code.
# These prefixes / shapes are skipped because they're clearly external.
EXTERNAL_PREFIXES = (
    "http://",
    "https://",
    "mailto:",
    "git@",
    "ssh://",
    "ftp://",
)


def load_allowlist() -> set[str]:
    if not ALLOWLIST_PATH.exists():
        return set()
    entries: set[str] = set()
    for line in ALLOWLIST_PATH.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        entries.add(stripped)
    return entries


def iter_markdown_files() -> Iterable[Path]:
    for root, dirs, files in os.walk(REPO_ROOT):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for fname in files:
            if fname.lower().endswith(".md"):
                yield Path(root) / fname


def extract_candidates(text: str) -> Iterable[str]:
    for match in PATH_PATTERN.finditer(text):
        for group in match.groups():
            if group:
                yield group
                break


def is_external(path: str) -> bool:
    return path.startswith(EXTERNAL_PREFIXES)


def has_tracked_extension(path: str) -> bool:
    suffix = Path(path).suffix.lower()
    return suffix in TRACKED_EXTENSIONS


def is_obvious_nonpath(candidate: str) -> bool:
    """Filter out template placeholders, globs, env-vars, and prose nouns."""
    lower = candidate.lower()
    if lower in NONPATH_BARE_NAMES:
        return True
    if any(ind in candidate for ind in NONPATH_INDICATORS):
        return True
    # Bare .js with no directory prefix is almost always prose
    # ("Node.js", "Next.js"). Require a `/` for .js references.
    if candidate.endswith(".js") and "/" not in candidate:
        return True
    # "Next.js", "Node.js" style: stem is a known framework, no dir prefix.
    if "/" not in candidate:
        stem = candidate.split(".")[0].lower()
        if stem in NONPATH_PROSE_STEMS:
            return True
    return False


def path_exists_in_repo(path: str) -> bool:
    """A reference resolves if either:
       - the path exists relative to repo root, OR
       - the bare filename exists somewhere in the repo
         (handles docs that say `FOO.md` without a directory prefix).
    """
    candidate = REPO_ROOT / path
    if candidate.exists():
        return True

    # Bare-filename fallback: search for a file with this name anywhere.
    bare = Path(path).name
    for root, dirs, files in os.walk(REPO_ROOT):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        if bare in files:
            return True
    return False


def main() -> int:
    allowlist = load_allowlist()
    failures: list[tuple[Path, str]] = []
    checked = 0

    for md_file in iter_markdown_files():
        try:
            text = md_file.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue

        seen: set[str] = set()
        for candidate in extract_candidates(text):
            if candidate in seen:
                continue
            seen.add(candidate)

            if is_external(candidate):
                continue
            if is_obvious_nonpath(candidate):
                continue
            if not has_tracked_extension(candidate):
                continue

            # Strip leading ./ or /
            normalized = candidate.lstrip("./").lstrip("/")
            if not normalized:
                continue

            checked += 1

            # Allowlist matches: full path OR bare filename.
            if normalized in allowlist or Path(normalized).name in allowlist:
                continue

            if not path_exists_in_repo(normalized):
                failures.append((md_file.relative_to(REPO_ROOT), normalized))

    if failures:
        print(
            "\n❌ verify-doc-refs FAILED — the following Markdown files "
            "reference paths that do not exist in this repo:\n",
            file=sys.stderr,
        )
        last_file: Path | None = None
        for md, ref in failures:
            if md != last_file:
                print(f"\n  in {md}:", file=sys.stderr)
                last_file = md
            print(f"      → {ref}", file=sys.stderr)
        print(
            "\nFix options:\n"
            "  1. Commit the referenced file to this repo (preferred).\n"
            "  2. Update the Markdown to point at the correct path.\n"
            "  3. If the file lives in the tgp-agent-context repo, "
            "qualify the reference (e.g. 'tgp-agent-context/RULES.md') "
            "AND add the bare filename to .agent-doc-allowlist as a "
            "temporary cross-repo exception.\n"
            "  4. If the doc is a known-stranded legacy file being "
            "rescued, add its bare filename to .agent-doc-allowlist "
            "(temporary; goal is empty allowlist).\n\n"
            f"Scanned {checked} unique references across "
            f"{sum(1 for _ in iter_markdown_files())} Markdown files.",
            file=sys.stderr,
        )
        return 1

    print(
        f"✅ verify-doc-refs OK — {checked} unique references checked, "
        "all resolve."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
