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

# System deps (python runtime for letta-evals)
RUN apt-get update && \
    apt-get install -y python3 python3-pip git && \
    rm -rf /var/lib/apt/lists/*

# Python packages (letta-evals, etc.)
# Use --break-system-packages for Debian's PEP 668 restriction (safe in Docker)
COPY requirements.lock ./
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.lock

# Copy Python files
COPY python/run_with_graders.py /app/python/run_with_graders.py

# Set permissions
RUN chmod +x /app/python/run_with_graders.py

# Set PYTHONPATH
ENV PYTHONPATH=/app/python:$PYTHONPATH

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

