import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Configuración de sistema clave/valor (ej: secreto TOTP del supervisor).
// Los valores sensibles se guardan tal cual; el acceso se controla por rol
// en las rutas del api-server.
export const configSistemaTable = pgTable("config_sistema", {
  clave: text("clave").primaryKey(),
  valor: text("valor").notNull(),
  actualizadoEn: timestamp("actualizado_en", { withTimezone: true }).notNull().defaultNow(),
});

export type ConfigSistema = typeof configSistemaTable.$inferSelect;
