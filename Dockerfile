FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY scripts ./scripts
COPY src ./src
COPY dashboard ./dashboard
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production TRADEPILOT_MODE=Monopoly TRADING_ENABLED=false
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json
RUN mkdir -p /app/data /app/dashboard/public && chown -R node:node /app/data /app/dashboard
USER node
CMD ["node", "dist/cli.js", "worker"]
