import { pgTable, text, serial, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const sedesTable = pgTable("sedes", {
  id: serial("id").primaryKey(),
  nombre: text("nombre").notNull(),
  direccion: text("direccion"),
  telefono: text("telefono"),
  email: text("email"),
  activa: boolean("activa").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertSedeSchema = createInsertSchema(sedesTable).omit({ id: true, createdAt: true });
export type InsertSede = z.infer<typeof insertSedeSchema>;
export type Sede = typeof sedesTable.$inferSelect;
