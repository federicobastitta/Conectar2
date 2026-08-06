import { pgTable, text, serial, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Salas de espera con pantalla TV propia. El médico elige desde qué sala se
// anuncia su llamado; cada TV puede vincularse a una sala específica.
export const salasLlamadoTable = pgTable("salas_llamado", {
  id: serial("id").primaryKey(),
  nombre: text("nombre").notNull(),
  detalle: text("detalle"),
  activa: boolean("activa").notNull().default(true),
});

export const insertSalaLlamadoSchema = createInsertSchema(salasLlamadoTable).omit({ id: true });
export type InsertSalaLlamado = z.infer<typeof insertSalaLlamadoSchema>;
export type SalaLlamado = typeof salasLlamadoTable.$inferSelect;
