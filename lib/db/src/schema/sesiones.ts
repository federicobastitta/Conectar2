import { pgTable, text, serial, timestamp, integer, boolean } from "drizzle-orm/pg-core";

export const sesionesTable = pgTable("sesiones", {
  id: serial("id").primaryKey(),
  token: text("token").notNull().unique(),
  usuarioId: integer("usuario_id").notNull(),
  activa: boolean("activa").notNull().default(true),
  vistaRol: text("vista_rol"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Sesion = typeof sesionesTable.$inferSelect;
