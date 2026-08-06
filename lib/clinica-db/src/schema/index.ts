/**
 * Schema Drizzle — conectar-clinica-dev
 *
 * Definiciones de tipos TypeScript alineadas con las migraciones SQL.
 * Se usan SOLO para type-safety en queries; el schema real en la DB
 * se gestiona con las migraciones SQL versionadas (src/migrations/sql/).
 *
 * NO usar drizzle-kit push desde aquí — siempre usar el migration runner.
 */

export * from "./pacientes.js";
export * from "./episodios.js";
export * from "./evoluciones.js";
export * from "./documentos.js";
export * from "./usuarios.js";
export * from "./auditoria.js";
