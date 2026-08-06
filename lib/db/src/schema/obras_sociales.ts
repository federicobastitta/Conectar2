import { pgTable, text, serial, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const obrasSocialesTable = pgTable("obras_sociales", {
  id: serial("id").primaryKey(),
  nombre: text("nombre").notNull(),
  detalle: text("detalle"),
  codigo: text("codigo"),
  activa: boolean("activa").notNull().default(true),
  visible: boolean("visible").notNull().default(true),
});

export const insertObraSocialSchema = createInsertSchema(obrasSocialesTable).omit({ id: true });
export type InsertObraSocial = z.infer<typeof insertObraSocialSchema>;
export type ObraSocial = typeof obrasSocialesTable.$inferSelect;
