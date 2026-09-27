#!/usr/bin/env bash
# GH-LANES runner setup for one stage job.
#   setup-runner.sh target <sha> <dir> <repo url>  full fetch of the target commit into its own clean repo, detached checkout
#   setup-runner.sh pg <jar cache dir> <dist dir>  PG 17.6 server (zonky 17.6.0, same pins as rt-setup-42d8c5b5.sh)
#   setup-runner.sh psql                          postgresql-client-18 from PGDG (local lane uses psql 18.6)
#   setup-runner.sh rg                            ripgrep (journey-full J20 core-diff gate)
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd); . "$HERE/lanes.sh"
sha(){ sha256sum "$1" | cut -c1-64; }
case "$1" in
  target)
    SHA=$2; D=$3; URL=$4
    [[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "bad sha" >&2; exit 70; }
    [ ! -e "$D" ] || { echo "$D exists" >&2; exit 70; }
    git init -q "$D"; git -C "$D" remote add origin "$URL"
    # Full history: the lane bootstraps check `merge-base --is-ancestor <base> HEAD` and J20 diffs against a base.
    timeout 600 git -C "$D" -c core.hooksPath=/dev/null fetch -q --no-tags origin "$SHA"
    git -C "$D" -c core.hooksPath=/dev/null -c advice.detachedHead=false checkout -q --detach "$SHA"
    git -C "$D" remote set-url --push origin no_push://disabled
    [ "$(git -C "$D" rev-parse HEAD)" = "$SHA" ] && [ -z "$(git -C "$D" status --porcelain --untracked-files=all)" ] || { echo "target not clean at $SHA" >&2; exit 71; }
    echo "TARGET_OK head=$SHA tree=$(git -C "$D" rev-parse 'HEAD^{tree}') commits=$(git -C "$D" rev-list --count HEAD)"
    ;;
  pg)
    C=$2; DIST=$3; mkdir -p "$C"; J=$C/pg-17.6.0.jar
    if [ ! -f "$J" ] || [ "$(sha "$J")" != "$PG_JAR_SHA256" ]; then rm -f "$J"; timeout 300 curl -fsSL --retry 3 -o "$J" "$PG_JAR_URL"; fi
    [ "$(sha "$J")" = "$PG_JAR_SHA256" ] || { echo "jar sha256 != pin" >&2; exit 70; }
    X=$(mktemp -d); unzip -q -o "$J" postgres-linux-x86_64.txz -d "$X"
    [ "$(sha "$X/postgres-linux-x86_64.txz")" = "$PG_TXZ_SHA256" ] || { echo "txz sha256 != pin" >&2; exit 70; }
    mkdir -p "$DIST"; tar -xJf "$X/postgres-linux-x86_64.txz" -C "$DIST"; rm -rf "$X"
    [ "$(sha "$DIST/bin/postgres")" = "$PG_POSTGRES_SHA256" ] && [ "$(sha "$DIST/bin/initdb")" = "$PG_INITDB_SHA256" ] && [ "$(sha "$DIST/bin/pg_ctl")" = "$PG_PGCTL_SHA256" ] \
      || { echo "server binaries sha256 != pin" >&2; exit 70; }
    V=$(LD_LIBRARY_PATH="$DIST/lib" "$DIST/bin/postgres" --version); [ "${V##* }" = 17.6 ] || { echo "not 17.6: $V" >&2; exit 70; }
    echo "PG_OK $V dist=$DIST"
    ;;
  psql)
    if [ ! -x /usr/lib/postgresql/18/bin/psql ]; then
      if ! apt-cache policy postgresql-client-18 2>/dev/null | grep -q 'Candidate: [0-9]'; then
        sudo install -d /usr/share/postgresql-common/pgdg
        sudo curl -fsSL --retry 3 -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc
        . /etc/os-release
        echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $VERSION_CODENAME-pgdg main" | sudo tee /etc/apt/sources.list.d/pgdg-lanes.list >/dev/null
        timeout 300 sudo apt-get update -qq -o Dir::Etc::sourcelist=sources.list.d/pgdg-lanes.list -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0
      fi
      DEBIAN_FRONTEND=noninteractive timeout 600 sudo apt-get install -y -qq --no-install-recommends postgresql-client-18 >/dev/null
    fi
    /usr/lib/postgresql/18/bin/psql --version
    ;;
  rg)
    if ! command -v rg >/dev/null; then
      DEBIAN_FRONTEND=noninteractive timeout 600 sudo apt-get install -y -qq --no-install-recommends ripgrep >/dev/null 2>&1 \
        || { timeout 300 sudo apt-get update -qq; DEBIAN_FRONTEND=noninteractive timeout 600 sudo apt-get install -y -qq --no-install-recommends ripgrep >/dev/null; }
    fi
    rg --version | head -1
    ;;
  *) echo "usage" >&2; exit 64 ;;
esac
