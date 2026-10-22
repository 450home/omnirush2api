# syntax=docker/dockerfile:1
#
# omnirush2api — OpenAI-compatible reverse proxy for OmniRush.ai
#
# Build:
#   docker build -t omnirush2api .
# Run:
#   docker run -d --name omnirush2api \
#     -p 20129:20129 \
#     -v omnirush-tokens:/root/.omnirush2api \
#     -e OMNIRUSH_REFRESH_TOKEN="<refresh>|<access>" \
#     omnirush2api
#
# The runtime has ZERO npm dependencies (esbuild/tsx/typescript are
# devDependencies only), so the final image carries no node_modules at all.

# ---------- build stage ----------
FROM node:22-alpine AS builder

WORKDIR /app

# Install build tooling only (the runtime needs none of it).
# NODE_ENV=production would skip devDependencies, so it is forced to
# development for this stage.
ENV NODE_ENV=development
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src

# Bundle dist/cli.js (daemon) and worker/worker.js (Cloudflare Worker).
RUN npx tsx scripts/build.ts

# ---------- runtime stage ----------
FROM node:22-alpine AS runtime

LABEL org.opencontainers.image.title="omnirush2api" \
      org.opencontainers.image.description="OpenAI-compatible reverse proxy for OmniRush.ai" \
      org.opencontainers.image.source="https://github.com/IMROVOID/omnirush2api"

WORKDIR /app
ENV NODE_ENV=production

# Run unprivileged.
RUN mkdir -p /root/.omnirush2api && chown -R node:node /app /root/.omnirush2api

# The prebuilt bundle plus the metadata the daemon prints on start.
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/worker ./worker
COPY --chown=node:node package.json README.md ./

# Where the daemon stores rotated refresh tokens — mount a volume here so the
# tokens survive a container replacement.
VOLUME ["/root/.omnirush2api"]

# 20129 is the default daemon port (OpenAI-compatible base URL:
# http://127.0.0.1:20129/v1)
EXPOSE 20129

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:20129/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Gateway URL, bearer key for incoming clients, and the OAuth token pair
# (refresh|access) can all be set as env vars.
ENV OMNIRUSH_GATEWAY_URL="https://omnirush.ai/omnirush/v1" \
    API_KEY="sk-omnirush" \
    PORT="20129" \
    HOST="0.0.0.0"

CMD ["node", "dist/cli.js", "start", "--port", "20129", "--host", "0.0.0.0"]
