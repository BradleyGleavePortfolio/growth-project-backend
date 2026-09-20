# syntax=docker/dockerfile:1.6
#
# Two stages:
#   build   — full devDependency install, prisma generate, nest build, Sentry
#             sourcemap upload (unchanged behaviour from the previous single
#             stage).
#   runtime — production dependency closure only (`npm ci --omit=dev`), the
#             compiled dist/, prisma/ (schema, migrations, seed-diagnostic.json
#             read at runtime) and scripts/release.sh (Fly release_command).
#             Build fails if a build/test tool is present or the prisma CLI
#             (needed by release.sh) is missing, so the artifact cannot
#             silently regress to shipping the toolchain.
#
# Not proven here: this Dockerfile has not been built in the authoring sandbox
# (no Docker). The invariants above are asserted at build time on Fly's remote
# builder and structurally by test/ci/delivery-artifact.spec.ts.

############################
# build stage
############################
FROM node:20-slim AS build

# ca-certificates is required so the Sentry sourcemap upload step can verify
# TLS to sentry.io; openssl is required by Prisma engines.
RUN apt-get update -qq && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma/
COPY scripts ./scripts/

# Git hooks are meaningless inside an image build, and the `prepare` script
# (`lefthook install`) execs `git`, which node:20-slim does not ship. Strip the
# script instead of setting LEFTHOOK=0 (which does not gate `install`).
# `postinstall` (prisma generate) and native-module install scripts still run.
RUN npm pkg delete scripts.prepare

RUN npm ci --no-audit --no-fund

COPY . .

RUN npx prisma generate

RUN npm run build

# Upload sourcemaps to Sentry so production stack traces are readable.
# SENTRY_AUTH_TOKEN is a build secret exposed only to this RUN; the script is
# a graceful no-op when Sentry variables are unset.
ARG RELEASE_VERSION=""
ARG SENTRY_DSN=""
ARG SENTRY_ORG=""
ARG SENTRY_PROJECT=""
RUN --mount=type=secret,id=sentry_auth_token \
    SENTRY_AUTH_TOKEN="$( [ -f /run/secrets/sentry_auth_token ] && cat /run/secrets/sentry_auth_token || echo '' )" \
    SENTRY_DSN="$SENTRY_DSN" \
    SENTRY_ORG="$SENTRY_ORG" \
    SENTRY_PROJECT="$SENTRY_PROJECT" \
    RELEASE_VERSION="$RELEASE_VERSION" \
    bash ./scripts/sentry-upload-sourcemaps.sh dist

############################
# runtime stage
############################
FROM node:20-slim AS runtime

RUN apt-get update -qq && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma/
COPY scripts/release.sh ./scripts/release.sh

# Production closure only. `prisma` (CLI) is a devDependency that is also an
# optional peer of @prisma/client, i.e. dev-optional; npm keeps dev-optional
# packages under --omit=dev, and the assertion below fails the build if that
# ever stops being true. Lifecycle scripts still run here so @prisma/engines
# fetches its engines and `postinstall` generates the client for this tree.
# SCARF_ANALYTICS=false: @scarf/scarf (transitive) would otherwise phone home
# from its postinstall during this install.
RUN npm pkg delete scripts.prepare \
    && SCARF_ANALYTICS=false npm ci --omit=dev --no-audit --no-fund

COPY --from=build /app/dist ./dist

# Fail the build if the artifact is wrong: runtime deps + prisma CLI must
# resolve; build/test tooling must be absent; compiled entrypoint and
# release inputs must exist.
RUN node -e "['prisma/package.json','@prisma/client/package.json','@nestjs/core/package.json'].forEach(p => require.resolve(p))" \
    && for p in jest ts-jest ts-node @nestjs/cli @nestjs/testing eslint lefthook danger supertest; do \
         if [ -e "node_modules/$p" ]; then echo "artifact check failed: dev tool $p present in runtime image" >&2; exit 1; fi; \
       done \
    && test -f dist/main.js \
    && test -f prisma/schema.prisma \
    && test -f prisma/seed-diagnostic.json \
    && test -f scripts/release.sh \
    && echo "artifact check OK"

# RELEASE_VERSION / GIT_SHA: commit the image was built from, read by
# src/instrument.ts (Sentry release) — passed by .github/workflows/fly-deploy.yml.
ARG RELEASE_VERSION=""
ARG GIT_SHA=""
ENV RELEASE_VERSION=$RELEASE_VERSION
ENV GIT_SHA=$GIT_SHA

EXPOSE 3000

# Runtime writes only under /tmp (scripts/release.sh, data-export, signed-pdf
# store); /app stays root-owned and read-only for the process. `node` is the
# unprivileged user shipped with the official image.
USER node

CMD ["node", "dist/main.js"]
