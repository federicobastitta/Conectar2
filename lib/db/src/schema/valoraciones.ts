import { pgTable, serial, integer, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

// ── Valoración de la atención por el paciente ──────────────────────────────
// Al finalizar una consulta se crea una fila con un token único y se empuja
// una invitación a la app del paciente (portal) para que califique 1–5.
// La misma fila funciona como cola de envío (estado_envio + backoff), igual
// que certificados_app_envios. El puntaje llega por la API pública con token.
export const valoracionesAtencionTable = pgTable(
  "valoraciones_atencion",
  {
    id: serial("id").primaryKey(),
    encounterId: integer("encounter_id").notNull(),
    pacienteId: integer("paciente_id").notNull(),
    profesionalId: integer("profesional_id").notNull(),
    token: text("token").notNull(),
    // Calificación del paciente (null hasta que responde)
    puntaje: integer("puntaje"), // 1..5
    comentario: text("comentario"),
    calificadoEn: timestamp("calificado_en", { withTimezone: true }),
    // Cola de envío de la invitación a la app del paciente
    estadoEnvio: text("estado_envio").notNull().default("pendiente"), // pendiente | enviado | error_permanente
    intentos: integer("intentos").notNull().default(0),
    ultimoError: text("ultimo_error"),
    ultimoIntentoEn: timestamp("ultimo_intento_en", { withTimezone: true }),
    proximoIntentoEn: timestamp("proximo_intento_en", { withTimezone: true }).defaultNow(),
    enviadoEn: timestamp("enviado_en", { withTimezone: true }),
    creadoEn: timestamp("creado_en", { withTimezone: true }).notNull().defaultNow(),
    actualizadoEn: timestamp("actualizado_en", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("valoraciones_atencion_encounter_uidx").on(t.encounterId),
    uniqueIndex("valoraciones_atencion_token_uidx").on(t.token),
    index("valoraciones_atencion_prof_idx").on(t.profesionalId),
    index("valoraciones_atencion_envio_idx").on(t.estadoEnvio, t.proximoIntentoEn),
  ],
);

export type ValoracionAtencion = typeof valoracionesAtencionTable.$inferSelect;
