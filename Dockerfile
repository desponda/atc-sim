# ── Stage 1: install all deps ─────────────────────────────────────────────
FROM node:20-alpine AS deps
RUN npm install -g pnpm@9
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/client/package.json ./packages/client/
COPY packages/server/package.json ./packages/server/
RUN pnpm install --frozen-lockfile

# ── Stage 2: build everything ─────────────────────────────────────────────
FROM deps AS build
COPY . .
# Build shared → server → client
RUN pnpm build

# ── Stage 3: production runtime ───────────────────────────────────────────
FROM node:20-alpine AS runtime
RUN npm install -g pnpm@9
WORKDIR /app

# Copy only production server deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/
RUN pnpm install --frozen-lockfile --filter @atc-sim/server...

# Compiled server + shared
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/server/dist ./packages/server/dist

# Built client (served as static files)
COPY --from=build /app/packages/client/dist ./packages/client/dist

# Airport / nav data
COPY data/ ./data/

ENV PORT=3001
ENV STATIC_DIR=/app/packages/client/dist
# Let the server discover airport data relative to the working directory
WORKDIR /app

EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/api/health || exit 1

CMD ["node", "packages/server/dist/index.js"]
