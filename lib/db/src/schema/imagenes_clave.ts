import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const imagenesClaveTable = pgTable("imagenes_clave", {
  id: serial("id").primaryKey(),
  informeId: integer("informe_id").notNull(),
  url: text("url").notNull(),
  descripcion: text("descripcion"),
  orden: integer("orden").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertImagenClaveSchema = createInsertSchema(imagenesClaveTable).omit({
  id: true,
  createdAt: true,
});
export type InsertImagenClave = z.infer<typeof insertImagenClaveSchema>;
export type ImagenClave = typeof imagenesClaveTable.$inferSelect;
