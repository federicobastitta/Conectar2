import { pgTable, text, serial, integer, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Mapeo entre un paciente de un sistema externo (Pulso) y su ficha en Conectar.
// Permite deduplicar por el id estable del sistema de origen (más confiable que
// el DNI), hacer sync incremental y dejar trazabilidad del origen del paciente.
export const pacientesExternosTable = pgTable(
  "pacientes_externos",
  {
    id: serial("id").primaryKey(),
    origen: text("origen").notNull().default("pulso"),
    externalId: text("external_id").notNull(),
    patientId: integer("patient_id").notNull(),
    // Marcas de tiempo reportadas por el sistema externo (para sync incremental)
    externalCreatedAt: timestamp("external_created_at", { withTimezone: true }),
    externalUpdatedAt: timestamp("external_updated_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("pacientes_externos_origen_external_id_unique").on(t.origen, t.externalId)],
);

export const insertPacienteExternoSchema = createInsertSchema(pacientesExternosTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertPacienteExterno = z.infer<typeof insertPacienteExternoSchema>;
export type PacienteExterno = typeof pacientesExternosTable.$inferSelect;
