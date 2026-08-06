import { pgTable, text, serial, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const consultoriosTable = pgTable("consultorios", {
  id: serial("id").primaryKey(),
  nombre: text("nombre").notNull(),
  detalle: text("detalle"),
  activo: boolean("activo").notNull().default(true),
});

export const insertConsultorioSchema = createInsertSchema(consultoriosTable).omit({ id: true });
export type InsertConsultorio = z.infer<typeof insertConsultorioSchema>;
export type Consultorio = typeof consultoriosTable.$inferSelect;
