# Discord request bot — Fly.io / Docker
FROM node:22-slim AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate

FROM base AS build
# Native build tools (some deps may need them)
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y build-essential python-is-python3 && \
    rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY scripts/package.json ./scripts/
COPY lib/db/package.json ./lib/db/

# Do NOT use --frozen-lockfile: workspace catalogs can drift from the lockfile.
RUN pnpm install --filter @workspace/scripts... --filter @workspace/db... --no-frozen-lockfile

COPY scripts ./scripts
COPY lib/db ./lib/db
COPY tsconfig.json tsconfig.base.json ./

FROM base AS runner
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app /app

# Long-running Discord worker (no HTTP port required)
CMD ["sh", "-c", "pnpm --filter @workspace/db run push-force || true; pnpm start"]
