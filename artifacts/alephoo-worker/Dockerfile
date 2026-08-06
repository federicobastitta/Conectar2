## ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:24-alpine AS builder

WORKDIR /workspace

# pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copiar manifests del workspace (para pnpm workspaces)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY lib/clinica-db/package.json ./lib/clinica-db/
COPY lib/clinica-db/tsconfig.json ./lib/clinica-db/
COPY artifacts/alephoo-worker/package.json ./artifacts/alephoo-worker/

# Instalar dependencias (sin devDeps en prod — se sobrescribe abajo en runtime stage)
RUN pnpm install --frozen-lockfile

# Copiar fuentes
COPY lib/clinica-db/src ./lib/clinica-db/src
COPY artifacts/alephoo-worker/src ./artifacts/alephoo-worker/src
COPY artifacts/alephoo-worker/tsconfig.json ./artifacts/alephoo-worker/tsconfig.json

# Compilar clinica-db primero (es referencia compuesta)
RUN pnpm --filter @workspace/clinica-db run build

# Compilar el worker
RUN pnpm --filter @workspace/alephoo-worker run build

## ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:24-alpine AS runtime

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

# Solo manifests de producción
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY lib/clinica-db/package.json ./lib/clinica-db/
COPY artifacts/alephoo-worker/package.json ./artifacts/alephoo-worker/

# Instalar solo prod deps
RUN pnpm install --frozen-lockfile --prod

# Copiar builds compilados
COPY --from=builder /workspace/lib/clinica-db/dist ./lib/clinica-db/dist
COPY --from=builder /workspace/artifacts/alephoo-worker/dist ./artifacts/alephoo-worker/dist

# Migraciones SQL — deben ir en dist/migrations/sql/ porque runner.js resuelve
# __dirname relativo al archivo compilado (dist/migrations/runner.js)
COPY lib/clinica-db/src/migrations/sql ./lib/clinica-db/dist/migrations/sql

WORKDIR /app/artifacts/alephoo-worker

# Usuario no-root
RUN addgroup -g 1001 worker && adduser -D -u 1001 -G worker worker
USER worker

EXPOSE 3099

# Health check para ECS
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=2 \
  CMD wget -qO- http://localhost:3099/health || exit 1

ENTRYPOINT ["node", "--enable-source-maps", "dist/index.js"]
