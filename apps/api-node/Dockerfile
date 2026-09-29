# ---------------------------------------------------------------------------
# NestJS runtime image.
#
# Four stages so the runtime carries production dependencies and compiled output
# and nothing else — no TypeScript, no Nest CLI, no Prisma CLI, no sources.
#
# The generated Prisma client is copied into the production dependency tree
# rather than regenerated there, and `npm prune` is not used. Both for the same
# reason: `prisma generate` writes to node_modules/.prisma, which npm regards as
# extraneous and will happily delete, and the Prisma CLI is a dev dependency so
# it is gone by the time anyone notices. Copying the artifact is deterministic.
# ---------------------------------------------------------------------------

# --- 1. all dependencies, plus the generated client ------------------------
FROM node:22-alpine AS deps
WORKDIR /app
# Prisma's query engine links against OpenSSL 3; without it the client builds
# fine and then fails to load at container start.
RUN apk add --no-cache openssl
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund \
 && npx prisma generate

# --- 2. compile ------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# --- 3. production dependencies only --------------------------------------
FROM node:22-alpine AS prod-deps
WORKDIR /app
RUN apk add --no-cache openssl
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
# @prisma/client declares the Prisma CLI and TypeScript as peers, and npm installs
# a production package's peers even with --omit=dev (and --omit=peer does not
# override that). The runtime only ever loads the generated client, so the CLI, its
# engines and config loader — which pull in `effect` and `fast-check` — go (~150MB).
RUN rm -rf node_modules/prisma node_modules/@prisma/engines \
      node_modules/@prisma/fetch-engine node_modules/@prisma/get-platform \
      node_modules/@prisma/config node_modules/effect node_modules/fast-check \
      node_modules/typescript node_modules/.bin/prisma node_modules/.bin/tsc \
      node_modules/.bin/tsserver
# The generated client, from the stage that had the CLI to generate it.
COPY --from=deps /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=deps /app/node_modules/@prisma/client ./node_modules/@prisma/client
# The client ships a WebAssembly engine per database for edge runtimes. This one runs
# on Node against PostgreSQL through the native library engine, so none are loaded.
RUN find node_modules/@prisma/client/runtime node_modules/.prisma/client \
      -name '*.wasm*' -delete \
 && find node_modules/@prisma/client/runtime -name '*edge*' -delete

# --- 4. runtime ------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

# npm, npx and corepack are never run in this image, so they are removed: a package
# manager is one less tool for an intruder. (It saves no space — they live in the base
# layer — which is ~155MB of the image, 123MB of it the node binary itself.)
RUN apk add --no-cache openssl \
 && addgroup -S app \
 && adduser -S app -G app \
 && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
      /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg

ENV NODE_ENV=production \
    PORT=3000

COPY --from=prod-deps --chown=app:app /app/node_modules ./node_modules
COPY --from=build     --chown=app:app /app/dist         ./dist
COPY --chown=app:app package.json ./

USER app
EXPOSE 3000

# 127.0.0.1, not localhost: inside the container localhost resolves to ::1 first
# and the server listens on IPv4, so the probe would be refused.
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/v1/health || exit 1

# Exec form, so node is PID 1 and receives SIGTERM directly — enableShutdownHooks
# then gets a chance to close the Prisma pool instead of the container being killed.
CMD ["node", "dist/main.js"]
