# syntax=docker/dockerfile:1.6
FROM node:20-slim

# ca-certificates is required so the Sentry sourcemap upload step
# (RUN bash ./scripts/sentry-upload-sourcemaps.sh) can verify TLS to
# sentry.io. node:20-slim ships without the CA bundle, which makes
# every outbound HTTPS call from the build fail with
# "SSL certificate problem: unable to get local issuer certificate".
RUN apt-get update -qq && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma/
COPY scripts ./scripts/

RUN npm ci

COPY . .

RUN npx prisma generate

RUN npm run build

# Upload sourcemaps to Sentry so production stack traces are readable.
#
# Inputs:
#   RELEASE_VERSION (build arg)        commit SHA / tag — propagated to runtime
#                                      via ENV below so instrument.ts reads
#                                      the same release the maps were tagged with.
#   SENTRY_AUTH_TOKEN (build secret)   internal-integration token, never baked
#                                      into the image — exposed only to this RUN.
#   SENTRY_DSN / SENTRY_ORG /
#   SENTRY_PROJECT (build args)        Sentry routing.
#
# The script is a graceful no-op when any of the four secrets is unset, so
# `docker build` works without Sentry credentials in dev / CI.
ARG RELEASE_VERSION=""
ARG SENTRY_DSN=""
ARG SENTRY_ORG=""
ARG SENTRY_PROJECT=""
ENV RELEASE_VERSION=$RELEASE_VERSION

RUN --mount=type=secret,id=sentry_auth_token \
    SENTRY_AUTH_TOKEN="$( [ -f /run/secrets/sentry_auth_token ] && cat /run/secrets/sentry_auth_token || echo '' )" \
    SENTRY_DSN="$SENTRY_DSN" \
    SENTRY_ORG="$SENTRY_ORG" \
    SENTRY_PROJECT="$SENTRY_PROJECT" \
    RELEASE_VERSION="$RELEASE_VERSION" \
    bash ./scripts/sentry-upload-sourcemaps.sh dist

EXPOSE 3000

CMD ["node", "dist/main.js"]
