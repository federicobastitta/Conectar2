import { pgTable, serial, integer, text, timestamp, index } from "drizzle-orm/pg-core";
import { profesionalesTable } from "./profesionales";
import { usersTable } from "./users";

// Chat entre recepción/administración (staff) y un profesional. La
// conversación queda identificada por (staffUsuarioId, profesionalId); si
// staffUsuarioId es NULL es el canal general del profesional con toda la
// recepción. enviadoPorId registra qué usuario concreto escribió el mensaje.
export const chatMensajesTable = pgTable(
  "chat_mensajes",
  {
    id: serial("id").primaryKey(),
    profesionalId: integer("profesional_id")
      .notNull()
      .references(() => profesionalesTable.id),
    staffUsuarioId: integer("staff_usuario_id").references(() => usersTable.id),
    enviadoPorId: integer("enviado_por_id").references(() => usersTable.id),
    emisor: text("emisor").notNull(), // "staff" | "medico"
    mensaje: text("mensaje").notNull(),
    creadoEn: timestamp("creado_en").notNull().defaultNow(),
    leidoEn: timestamp("leido_en"),
  },
  (t) => [index("chat_mensajes_conversacion_idx").on(t.staffUsuarioId, t.profesionalId, t.id)],
);

export type ChatMensajeRow = typeof chatMensajesTable.$inferSelect;
