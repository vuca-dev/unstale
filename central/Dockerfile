# unstale central: the coverage service and catalog host (`npm run serve`, src/onboarding/cli.ts).
#
#   docker build -t unstale-central central
#   docker run -d --name unstale-central -p 47831:47831 -v unstale-store:/data unstale-central
#
# Node 24 runs the TypeScript sources directly (type stripping; the code is erasable-syntax only), so there is
# no build step and no tsx at runtime.
#
# State and the published catalog live under UNSTALE_STORE=/data (a volume); the image holds no state. On first
# start an empty store gets catalog/v1/root.json. Bind mounts must be writable by uid 1000 (the `node` user).
#
# Runtime environment (full list: central/README.md, "Operator environment"). Nothing secret is baked in:
#   UNSTALE_PORT            listen port (default 47831)
#   UNSTALE_HOST            listen address; 0.0.0.0 here so the published port reaches the service
#   UNSTALE_STORE           state + catalog root (/data)
#   GITHUB_TOKEN            needed by coverage jobs (POST /coverage): release lists, docs resolution, admission
#   JEV_API_KEY             classifier key for coverage jobs
#   AI_GATEWAY_API_KEY      extraction and the classifier's fallback (gpt-6-luna through the AI gateway)
#   UNSTALE_RATE_PER_HOUR, UNSTALE_VOTES_PER_HOUR, UNSTALE_RUNS_PER_DAY, UNSTALE_TRUST_PROXY
#                           abuse limits (src/onboarding/limits.ts); set UNSTALE_TRUST_PROXY=1 behind one proxy.
#                           UNSTALE_RUNS_PER_DAY=0 serves the catalog without starting any job.
# Serving the catalog and /health needs none of the secrets or network access; coverage jobs need outbound network.

# Debian slim rather than alpine: glibc, so a gh binary added for coverage jobs runs unchanged.
FROM node:24.22.0-bookworm-slim

# tini as PID 1 forwards SIGTERM to node (which handles it and exits 0) and reaps any orphaned grandchildren of the
# git/gh subprocesses that coverage jobs spawn; node itself does not reap processes it did not start.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && rm -rf /root/.npm

COPY src ./src

RUN mkdir -p /data && chown node:node /data
ENV UNSTALE_STORE=/data \
    UNSTALE_HOST=0.0.0.0 \
    UNSTALE_PORT=47831
VOLUME ["/data"]
USER node
EXPOSE 47831

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.UNSTALE_PORT}/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/onboarding/cli.ts"]
