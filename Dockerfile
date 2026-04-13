# Multi-stage Docker build for TCQ.
#
# Stage 1: Install dependencies and build all packages.
# Stage 2: Copy only the production artefacts into a slim image.
#
# The resulting image runs the Express server, which serves the
# Vite-built client assets and handles Socket.IO connections.

# --- Stage 1: Build ---
FROM node:20-alpine AS build

WORKDIR /app

# Copy workspace config and all package.json files first (for layer caching)
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/

# Install all dependencies (including devDependencies for building)
RUN npm ci

# Copy source code
COPY packages/shared/ packages/shared/
COPY packages/server/ packages/server/
COPY packages/client/ packages/client/

# Build all packages in dependency order:
# 1. shared (types and constants used by both server and client)
# 2. client (Vite production build → packages/client/dist/)
# 3. server (TypeScript compilation → packages/server/dist/)
RUN npm run build -w packages/shared
RUN npm run build -w packages/client
RUN npm run build -w packages/server

# --- Stage 2: Production image ---
FROM node:20-alpine

WORKDIR /app

# Copy workspace config
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/

# Install production dependencies only
RUN npm ci --omit=dev

# Copy built artefacts from the build stage
# Shared: compiled types (needed at runtime by server imports)
COPY --from=build /app/packages/shared/dist/ packages/shared/dist/
# Server: compiled JavaScript
COPY --from=build /app/packages/server/dist/ packages/server/dist/
# Client: Vite production build (served as static files by Express)
COPY --from=build /app/packages/client/dist/ packages/client/dist/

# The server listens on PORT (default 8080 for Cloud Run)
ENV PORT=8080
ENV NODE_ENV=production

EXPOSE 8080

# Run the compiled server
CMD ["node", "packages/server/dist/index.js"]
