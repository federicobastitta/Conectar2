import { pgTable, serial, text, integer, boolean, jsonb, timestamp } from "drizzle-orm/pg-core";

export const importacionesAdminTable = pgTable("importaciones_admin", {
  id: serial("id").primaryKey(),
  runId: text("run_id").notNull().unique(),
  fuente: text("fuente").notNull().default("excel"),
  archivo: text("archivo"),
  estado: text("estado").notNull().default("completado"),
  totalFilas: integer("total_filas").notNull().default(0),
  sedesCreadas: integer("sedes_creadas").notNull().default(0),
  sedesReutilizadas: integer("sedes_reutilizadas").notNull().default(0),
  especialidadesCreadas: integer("especialidades_creadas").notNull().default(0),
  especialidadesReutilizadas: integer("especialidades_reutilizadas").notNull().default(0),
  profesionalesCreados: integer("profesionales_creados").notNull().default(0),
  profesionalesReutilizados: integer("profesionales_reutilizados").notNull().default(0),
  agendasCreadas: integer("agendas_creadas").notNull().default(0),
  agendasActualizadas: integer("agendas_actualizadas").notNull().default(0),
  filasOmitidas: integer("filas_omitidas").notNull().default(0),
  conflictos: integer("conflictos").notNull().default(0),
  ejecutadoPor: text("ejecutado_por"),
  detalle: jsonb("detalle"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const importacionConflictosTable = pgTable("importacion_conflictos", {
  id: serial("id").primaryKey(),
  runId: text("run_id").notNull(),
  tipo: text("tipo").notNull(),
  motivo: text("motivo").notNull(),
  profesionalNombre: text("profesional_nombre"),
  filaOriginal: jsonb("fila_original").notNull(),
  filasRelacionadas: jsonb("filas_relacionadas"),
  resuelto: boolean("resuelto").notNull().default(false),
  resueltoPor: text("resuelto_por"),
  resueltoAt: timestamp("resuelto_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ImportacionAdmin = typeof importacionesAdminTable.$inferSelect;
export type ImportacionConflicto = typeof importacionConflictosTable.$inferSelect;
