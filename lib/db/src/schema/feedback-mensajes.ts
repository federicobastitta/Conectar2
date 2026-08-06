import { pgTable, serial, integer, text, timestamp, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// Chat de feedback "usuarios → desarrollo". Cada usuario del sistema tiene UNA
// conversación directa con el equipo de desarrollo (identificada por
// usuarioId, el dueño del hilo). El perfil desarrollador responde en cualquier
// hilo. adjuntos guarda un JSON array de {path, nombre, tipo} apuntando a
// objetos privados del object storage (capturas de pantalla, etc.).
export const feedbackMensajesTable = pgTable(
  "feedback_mensajes",
  {
    id: serial("id").primaryKey(),
    usuarioId: integer("usuario_id")
      .notNull()
      .references(() => usersTable.id),
    enviadoPorId: integer("enviado_por_id").references(() => usersTable.id),
    emisor: text("emisor").notNull(), // "usuario" | "desarrollo"
    mensaje: text("mensaje").notNull().default(""),
    adjuntos: text("adjuntos"), // JSON: [{path, nombre, tipo}]
    creadoEn: timestamp("creado_en").notNull().defaultNow(),
    leidoEn: timestamp("leido_en"),
  },
  (t) => [index("feedback_mensajes_hilo_idx").on(t.usuarioId, t.id)],
);

export type FeedbackMensajeRow = typeof feedbackMensajesTable.$inferSelect;
