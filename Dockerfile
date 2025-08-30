# Simple, stable build (dev deps included) — works for both bot & worker
FROM node:20-alpine

WORKDIR /app

# 1) Install dependencies (incl. dev) so tsc exists
COPY package*.json ./
RUN npm ci

# 2) Copy sources and build TS -> dist/
COPY tsconfig.json ./
COPY src ./src
COPY sql ./sql
RUN npm run build

# 3) Runtime
ENV NODE_ENV=production
# Compose overrides to run bot or worker:
# - bot:    ["node","dist/src/index.js"]
# - worker: ["node","dist/src/worker.js"]
CMD ["node","dist/src/index.js"]
