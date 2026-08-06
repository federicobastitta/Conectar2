import { pgTable, serial, integer, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const jobImportacionesTable = pgTable("job_importaciones", {
  id: serial("id").primaryKey(),
  nombre: text("nombre").notNull(),
  tipoEntidad: text("tipo_entidad").notNull(),
  formato: text("formato").notNull().default("json"),
  estado: text("estado").notNull().default("pendiente"),
  totalRegistros: integer("total_registros").notNull().default(0),
  creados: integer("creados").notNull().default(0),
  actualizados: integer("actualizados").notNull().default(0),
  omitidos: integer("omitidos").notNull().default(0),
  errores: integer("errores").notNull().default(0),
  mapeoColumnas: jsonb("mapeo_columnas"),
  filasData: jsonb("filas_data"),
  ejecutadoPor: text("ejecutado_por"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completadoAt: timestamp("completado_at", { withTimezone: true }),
});

export const importacionAuditoriaTable = pgTable("importacion_auditoria", {
  id: serial("id").primaryKey(),
  jobId: integer("job_id").notNull(),
  fila: integer("fila").notNull(),
  accion: text("accion").notNull(),
  entidadTipo: text("entidad_tipo").notNull(),
  entidadId: integer("entidad_id"),
  datosOriginales: jsonb("datos_originales"),
  mensajeError: text("mensaje_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertJobImportacionSchema = createInsertSchema(jobImportacionesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertJobImportacion = z.infer<typeof insertJobImportacionSchema>;
export type JobImportacion = typeof jobImportacionesTable.$inferSelect;

export type ImportacionAuditoria = typeof importacionAuditoriaTable.$inferSelect;
