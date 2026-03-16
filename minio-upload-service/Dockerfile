# ─── Build stage ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy manifests first for better layer caching
COPY package*.json tsconfig.json ./
RUN npm ci --ignore-scripts

COPY src ./src
RUN npm run build
# dashboard HTML is copied into dist/ by the build script above

# ─── Production stage ────────────────────────────────────────────────────────
FROM node:20-alpine AS production

WORKDIR /app

# Only install production dependencies
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Copy compiled output from build stage
COPY --from=builder /app/dist ./dist

# Run as non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

CMD ["node", "dist/index.js"]
