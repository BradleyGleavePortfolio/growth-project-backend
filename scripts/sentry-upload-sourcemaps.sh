#!/usr/bin/env bash
# Upload compiled sourcemaps to Sentry so the dashboard renders readable
# stack traces instead of minified column numbers from dist/.
#
# When invoked from the Dockerfile build stage, this script runs *after*
# `npm run build` has produced dist/ + dist/**/*.map. The release name is
# read from RELEASE_VERSION — the same variable instrument.ts uses at runtime
# — so what we upload here lines up with what Sentry sees on captured events.
#
# Behaviour:
#   - SENTRY_AUTH_TOKEN unset       → no-op (build still succeeds locally and
#                                      in CI environments without secrets).
#   - SENTRY_DSN unset              → no-op (no project to upload to).
#   - RELEASE_VERSION unset         → no-op with a printed warning; uploading
#                                      to a placeholder release would attach
#                                      maps to an event Sentry never receives.
#   - SENTRY_ORG / SENTRY_PROJECT
#     unset                         → no-op with a printed warning; the CLI
#                                      cannot resolve a project without them.
#
# Required Fly secrets when full upload is desired:
#   SENTRY_AUTH_TOKEN   internal-integration token, scope: project:releases
#   SENTRY_ORG          e.g. "the-growth-project"
#   SENTRY_PROJECT      e.g. "growth-project-backend"
#
# RELEASE_VERSION is supplied as a Docker build arg from fly.toml or the
# CI workflow (typically the commit SHA). The runtime uses the same value
# so events and sourcemaps share a release.

set -euo pipefail

if [ -z "${SENTRY_AUTH_TOKEN:-}" ] || [ -z "${SENTRY_DSN:-}" ]; then
  echo "[sentry] SENTRY_AUTH_TOKEN or SENTRY_DSN unset — skipping sourcemap upload."
  exit 0
fi

if [ -z "${SENTRY_ORG:-}" ] || [ -z "${SENTRY_PROJECT:-}" ]; then
  echo "[sentry] SENTRY_ORG or SENTRY_PROJECT unset — skipping sourcemap upload."
  exit 0
fi

RELEASE="${RELEASE_VERSION:-}"
if [ -z "$RELEASE" ]; then
  echo "[sentry] RELEASE_VERSION unset — skipping sourcemap upload."
  echo "[sentry] Set RELEASE_VERSION (typically the git SHA) on both build and runtime so events and maps line up."
  exit 0
fi

DIST_DIR="${1:-dist}"
if [ ! -d "$DIST_DIR" ]; then
  echo "[sentry] $DIST_DIR not found — run npm run build first."
  exit 1
fi

echo "[sentry] uploading sourcemaps from $DIST_DIR for release $RELEASE"

# `--unsafely-disable-prompts` would reject a non-tty; we never need prompts.
npx --yes @sentry/cli@2.39.0 releases new "$RELEASE"
npx --yes @sentry/cli@2.39.0 sourcemaps upload --release "$RELEASE" "$DIST_DIR"
npx --yes @sentry/cli@2.39.0 releases finalize "$RELEASE"

echo "[sentry] sourcemaps uploaded for release $RELEASE"
