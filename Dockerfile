# Node runtime for bot/worker
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY sql ./sql
RUN npm run build
CMD ["node","dist/index.js"]
