# Simple multi-stage build for the validator
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Install dependencies and build TypeScript
COPY package*.json ./
COPY tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build

# Runtime image
FROM node:20-bookworm-slim

WORKDIR /app

# Install only production Node deps
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy built JS
COPY --from=builder /app/dist ./dist

# Non-root user
RUN groupadd -g 1001 validator && \
    useradd -m -u 1001 -g validator validator && \
    chown -R validator:validator /app

USER validator

# Port 8080 exposes the validator's HTTP health server
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1) })" || exit 1

CMD ["node", "dist/index.js"]
