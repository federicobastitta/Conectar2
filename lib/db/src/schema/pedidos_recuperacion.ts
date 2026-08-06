import { pgTable, text, serial, timestamp } from "drizzle-orm/pg-core";

// Pedidos de "olvidé mi contraseña" hechos desde el login.
// Los ve el administrador dentro de la app y desde ahí asigna una clave nueva.
export const pedidosRecuperacionTable = pgTable("pedidos_recuperacion_clave", {
  id: serial("id").primaryKey(),
  // Lo que la persona escribió en el login (email o usuario), normalizado.
  identificador: text("identificador").notNull(),
  estado: text("estado").notNull().default("pendiente"), // pendiente | resuelto
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  resueltoAt: timestamp("resuelto_at", { withTimezone: true }),
});

export type PedidoRecuperacion = typeof pedidosRecuperacionTable.$inferSelect;
