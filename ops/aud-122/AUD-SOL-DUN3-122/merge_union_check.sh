#!/usr/bin/env bash
# Read-only object inspection. All generated evidence stays outside the repo.
set -euo pipefail
REPO=/home/user/workspace/growth-project-backend
OUT=/home/user/workspace/ops/aud-122/AUD-SOL-DUN3-122
A=0716a0f4ebf82fe6d73399fe80d4930d9bd77589
M=a70533d53c5833c5e998a8de363de3eeb81d9eb8
N=aa736434287c7ebcf2b68e87ee8a0b5dabf2b015
cd "$REPO"
B=$(git merge-base "$A" "$M")
printf 'Approved parent: %s\nMain parent: %s\nMerge head: %s\nMerge base: %s\n' "$A" "$M" "$N" "$B"
printf 'Actual parents: '; git show -s --format=%P "$N"
git merge-base --is-ancestor "$M" origin/main
printf 'Main parent is on local origin/main: PASS\n'
unexpected=0
while read -r commit; do
  git merge-base --is-ancestor "$commit" "$M" || unexpected=$((unexpected + 1))
done < <(git rev-list --no-merges "$A..$N")
printf 'Unexpected non-main commits: %s\n' "$unexpected"
test "$unexpected" -eq 0
changed=0
while read -r file; do
  old=$(git rev-parse -q --verify "$A:$file" || printf none)
  new=$(git rev-parse -q --verify "$N:$file" || printf none)
  if [ "$old" != "$new" ]; then
    changed=$((changed + 1))
    printf 'PR-owned file changed by merge: %s\n' "$file"
    case "$file" in
      prisma/schema.prisma|src/common/env-validation.ts) ;;
      *) printf 'Unexpected PR-owned file changed\n'; exit 1 ;;
    esac
  fi
done < <(git diff --name-only "$B" "$A")
test "$changed" -eq 2
printf 'Only the two assigned sensitive PR-owned files changed: PASS\n'

for f in prisma/schema.prisma src/common/env-validation.ts; do
  name=${f//\//_}
  git show "$B:$f" > "$OUT/$name.base"
  git show "$A:$f" > "$OUT/$name.approved"
  git show "$M:$f" > "$OUT/$name.main"
  git show "$N:$f" > "$OUT/$name.head"
  git merge-file -p "$OUT/$name.approved" "$OUT/$name.base" "$OUT/$name.main" > "$OUT/$name.expected"
  expected=$(git hash-object "$OUT/$name.expected")
  actual=$(git rev-parse "$N:$f")
  test "$expected" = "$actual"
  printf 'Exact conflict-free three-way union: %s PASS expected=%s actual=%s\n' "$f" "$expected" "$actual"
done

python - "$A" "$M" "$N" "$B" <<'PY'
import collections
import re
import subprocess
import sys

A, M, N, B = sys.argv[1:]

def git(*args):
    return subprocess.check_output(["git", *args], text=True).strip()

def blob(head, path):
    return subprocess.check_output(["git", "show", f"{head}:{path}"], text=True)

schema = blob(N, "prisma/schema.prisma")
declarations = re.findall(r"^(?:model|enum|type)\s+(\w+)\s*\{", schema, re.M)
duplicates = [name for name, n in collections.Counter(declarations).items() if n > 1]
print(f"Schema declarations: {len(declarations)}; duplicate model/enum/type names: {duplicates}")
assert not duplicates
field_duplicates = {}
for name, body in re.findall(r"^model\s+(\w+)\s*\{(.*?)^\}", schema, re.M | re.S):
    names = []
    for line in body.splitlines():
        line = line.split("//", 1)[0].strip()
        match = re.match(r"(\w+)\s+\w", line)
        if match:
            names.append(match.group(1))
    dup = [field for field, n in collections.Counter(names).items() if n > 1]
    if dup:
        field_duplicates[name] = dup
print(f"Duplicate schema fields within a model: {field_duplicates}")
assert not field_duplicates
env = blob(N, "src/common/env-validation.ts")
env_array = re.search(r"^export const ENV_RULES: EnvRule\[\] = \[(.*?)^\];", env, re.M | re.S).group(1)
env_names = re.findall(r"\bname:\s*['\"]([A-Z][A-Z0-9_]*)['\"]", env_array)
env_duplicates = [key for key, n in collections.Counter(env_names).items() if n > 1]
print(f"ENV_RULES keys: {len(env_names)}; duplicate env keys: {env_duplicates}")
assert not env_duplicates

def tree(head):
    lines = git("ls-tree", "-r", head, "--", "prisma/migrations").splitlines()
    return {line.split("\t", 1)[1]: line.split()[2] for line in lines}

approved, main, actual = tree(A), tree(M), tree(N)
common_mismatches = [p for p in approved.keys() & main.keys() if approved[p] != main[p]]
assert not common_mismatches, common_mismatches
expected = approved | main
assert actual == expected
print(f"Entire migration tree plain union: PASS ({len(actual)} files; no overwritten, missing or extra blobs)")
dunning = git("diff", "--name-only", B, A, "--", "prisma/migrations").splitlines()
main_new = git("diff", "--name-only", B, M, "--", "prisma/migrations").splitlines()
print("Dunning-added migrations:", sorted({p.split("/")[2] for p in dunning}))
print("Main-added migrations:", sorted({p.split("/")[2] for p in main_new}))
tables = {}
for side, paths in [("dunning", dunning), ("main", main_new)]:
    names = set()
    references = set()
    alters = set()
    for path in paths:
        if not path.endswith("/migration.sql"):
            continue
        sql = blob(N, path)
        sql = re.sub(r"--[^\n]*", "", sql)
        names.update(re.findall(r'CREATE TABLE\s+"([^"]+)"', sql))
        references.update(re.findall(r'REFERENCES\s+"([^"]+)"', sql))
        alters.update(re.findall(r'ALTER TABLE\s+"([^"]+)"', sql))
    tables[side] = names
    print(f"{side} created tables: {sorted(names)}")
    print(f"{side} referenced tables: {sorted(references)}")
    print(f"{side} altered tables: {sorted(alters)}")
assert not tables["dunning"] & tables["main"]
print("No table-name collisions across the sides: PASS")
PY
