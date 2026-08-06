import { pgTable, text, serial, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Documentación validada en recepción: DNI, credencial, orden médica, autorización.
// Un registro por paciente+tipo (la validación es del paciente; turnoId referencia
// el turno en el que se validó/actualizó por última vez).
export const documentacionRecepcionTable = pgTable(
  "documentacion_recepcion",
  {
    id: serial("id").primaryKey(),
    pacienteId: integer("paciente_id").notNull(),
    turnoId: integer("turno_id"),
    tipo: text("tipo").notNull(), // dni | credencial | orden_medica | autorizacion
    estado: text("estado").notNull().default("pendiente"), // pendiente | validada | no_aplica
    // Archivo escaneado/subido (opcional): data URL base64 con mime incluido
    archivoNombre: text("archivo_nombre"),
    archivoMime: text("archivo_mime"),
    archivoData: text("archivo_data"),
    observaciones: text("observaciones"),
    validadoPor: text("validado_por"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Documentación del paciente (dni, credencial, orden_medica, autorizacion):
    // un registro por paciente+tipo. El informe es POR TURNO (índice aparte).
    uniqueIndex("documentacion_recepcion_paciente_tipo_unique")
      .on(t.pacienteId, t.tipo)
      .where(sql`tipo <> 'informe'`),
    uniqueIndex("documentacion_recepcion_informe_turno_unique")
      .on(t.pacienteId, t.tipo, t.turnoId)
      .where(sql`tipo = 'informe'`),
    index("documentacion_recepcion_paciente_idx").on(t.pacienteId),
  ],
);

export const insertDocumentacionRecepcionSchema = createInsertSchema(documentacionRecepcionTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertDocumentacionRecepcion = z.infer<typeof insertDocumentacionRecepcionSchema>;
export type DocumentacionRecepcion = typeof documentacionRecepcionTable.$inferSelect;

export const TIPOS_DOCUMENTACION = ["dni", "credencial", "orden_medica", "autorizacion"] as const;
export const ESTADOS_DOCUMENTACION = ["pendiente", "validada", "no_aplica"] as const;
