# syntax=docker/dockerfile:1

# ---------- Install ALL deps (incl. dev) ----------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
# Install devDependencies so 'tsc' is available
RUN npm ci

# ---------- Build TypeScript ----------
FROM node:20-alpine AS build
WORKDIR /app
# Bring in node_modules (with dev deps) so 'npm run build' works
COPY --from=deps /app/node_modules ./node_modules
COPY tsconfig.json ./
COPY src ./src
# (Optional) include SQL if your build references it
COPY sql ./sql
RUN npm run build

# ---------- Install PROD-only deps ----------
FROM node:20-alpine AS prod-deps
WORKDIR /app
COPY package*.json ./
# Only production deps for the runtime image
RUN npm ci --omit=dev

# ---------- Final runtime image ----------
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Prod deps only
COPY --from=prod-deps /app/node_modules ./node_modules
# Compiled JS
COPY --from=build /app/dist ./dist
# Package files (for version/metadata)
COPY package*.json ./
# Command is overridden by docker-compose per service
CMD ["node", "dist/src/index.js"]
