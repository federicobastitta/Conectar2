import { pgTable, serial, integer, text, timestamp, index } from "drizzle-orm/pg-core";
import { profesionalesTable } from "./profesionales";
import { usersTable } from "./users";

// Mensajes dirigidos de recepción/administración a un profesional puntual.
// El médico los ve en su pantalla y los marca como leídos.
export const mensajesProfesionalTable = pgTable(
  "mensajes_profesional",
  {
    id: serial("id").primaryKey(),
    profesionalId: integer("profesional_id")
      .notNull()
      .references(() => profesionalesTable.id),
    deUsuarioId: integer("de_usuario_id")
      .notNull()
      .references(() => usersTable.id),
    mensaje: text("mensaje").notNull(),
    creadoEn: timestamp("creado_en").notNull().defaultNow(),
    leidoEn: timestamp("leido_en"),
  },
  (t) => [index("mensajes_profesional_destino_idx").on(t.profesionalId, t.leidoEn)],
);

export type MensajeProfesionalRow = typeof mensajesProfesionalTable.$inferSelect;
