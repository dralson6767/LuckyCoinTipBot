# syntax=docker/dockerfile:1

# Base
FROM node:20-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

# Dependencies layer (shared)
FROM base AS deps
COPY package*.json ./
RUN npm ci

# Build layer (TypeScript -> dist)
FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
COPY sql ./sql
RUN npm run build

# Runtime image (tiny, has node_modules + dist)
FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production

# bring in dependencies and built output
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package*.json ./

# Default command can be overridden by docker-compose per service
CMD ["node", "dist/src/index.js"]
