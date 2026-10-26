# Omnirush2API - OpenAI-compatible reverse proxy for OmniRush.ai
#
# Build:
#   docker build -t omnirush2api .
# Run:
#   docker run -d --name omnirush2api \
#     -p 20129:20129 \
#     -v omnirush-tokens:/root/.omnirush2api \
#     -e API_KEY=sk-omnirush \
#     -e OMNIRUSH_REFRESH_TOKEN="<refresh>|<access>" \
#     omnirush2api
#
# The runtime has ZERO npm dependencies (esbuild/tsx/typescript are
# devDependencies only), so the final image carries no node_modules at all.
#
# NOTE: no "# syntax=" directive on purpose. It makes BuildKit fetch the
# dockerfile frontend image from Docker Hub before the build even starts,
# which fails on a restricted or slow registry. Everything used below is
# plain Dockerfile syntax that every builder understands.

# ---------- build stage ----------
FROM node:22-alpine AS builder

WORKDIR /app

# Install build tooling only (the runtime needs none of it).
# NODE_ENV=production would skip devDependencies, so it is forced to
# development for this stage.
#
# NPM_CONFIG_GLOBAL / NPM_CONFIG_PREFIX are cleared explicitly: with
# NPM_CONFIG_GLOBAL=true, "npm ci" aborts with ECIGLOBAL ("does not work for
# global packages") and the build fails.
ENV NODE_ENV=development \
    NPM_CONFIG_GLOBAL=false \
    NPM_CONFIG_PREFIX=""
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src

# Bundle dist/cli.js (daemon) and worker/worker.js (Cloudflare Worker).
RUN npx tsx scripts/build.ts

# ---------- runtime stage ----------
FROM node:22-alpine AS runtime

LABEL org.opencontainers.image.title="Omnirush2API" \
      org.opencontainers.image.description="OpenAI-compatible reverse proxy for Omnirush.ai" \
      org.opencontainers.image.source="https://github.com/450home/omnirush2api"

WORKDIR /app
ENV NODE_ENV=production

# Run unprivileged.
RUN mkdir -p /root/.omnirush2api && chown -R node:node /app /root/.omnirush2api

# The prebuilt bundle plus the metadata the daemon prints on start.
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/worker ./worker
COPY --chown=node:node package.json README.md ./

# Where the daemon stores rotated refresh tokens. Mount a volume here so the
# tokens survive a container replacement.
VOLUME ["/root/.omnirush2api"]

# 20129 is the default daemon port (OpenAI-compatible base URL:
# http://127.0.0.1:20129/v1)
EXPOSE 20129

USER node

# The health endpoint answers 401 when API_KEY is set, so the check sends the
# key as a bearer token. Without this the container would stay "unhealthy"
# forever even though the daemon is fine.
# It reads PORT from the environment so it still probes the right port when a
# platform (Blitz, Railway, Render, Fly) assigns its own.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const p=process.env.PORT||20129;fetch('http://127.0.0.1:'+p+'/health',{headers:{authorization:'Bearer '+(process.env.API_KEY||'')}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Gateway URL and the bearer key for incoming clients can be set as env vars.
#
# PORT is deliberately NOT given a default here: Docker platforms assign
# their own, and baking "20129" into the image risks shadowing it. The daemon
# already falls back to 20129 in code when PORT is unset, so plain `docker run`
# still works with no configuration.
ENV OMNIRUSH_GATEWAY_URL="https://omnirush.ai/omnirush/v1" \
    API_KEY="sk-omnirush" \
    HOST="0.0.0.0"

# Do NOT hardcode --port/--host here: a platform such as Blitz injects its
# own PORT, and an explicit CLI flag would override it (the daemon would then
# listen on the wrong port and fail its health probe). The daemon reads PORT
# and HOST from the environment, so leaving them out lets the platform win.
CMD ["node", "dist/cli.js", "start"]
