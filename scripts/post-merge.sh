#!/bin/bash
set -e
pnpm install --frozen-lockfile
# Recompilar las libs compartidas (el typecheck usa dist; runtime usa src).
pnpm -w run typecheck:libs
# NO correr `drizzle-kit push`: en entorno no interactivo se cuelga con
# prompts (renames/data-loss). El api-server auto-aplica el drift aditivo
# (tablas/columnas nuevas) al arrancar; cambios destructivos se hacen a mano.
