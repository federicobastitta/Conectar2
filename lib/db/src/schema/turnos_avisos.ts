import { pgTable, serial, integer, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { turnosTable } from "./turnos";

// Cola durable de avisos al portal del paciente cuando la clínica cancela o
// mueve un turno (patrón videollamadas_envios). Contrato del portal (ago 2026):
//   POST {APP_PACIENTE_PUSH_URL}/api/integracion/turnos con Bearer.
//   evento: "cancelado" | "reprogramado" (reprogramado exige fecha+horaInicio).
// Los reenvíos son seguros del lado del portal (no duplican avisos).
export const turnosAvisosEnviosTable = pgTable(
  "turnos_avisos_envios",
  {
    id: serial("id").primaryKey(),
    turnoId: integer("turno_id")
      .notNull()
      .references(() => turnosTable.id),
    evento: text("evento").notNull(), // cancelado | reprogramado
    payload: jsonb("payload").notNull(),
    estado: text("estado").notNull().default("pendiente"), // pendiente | enviado | error_permanente
    intentos: integer("intentos").notNull().default(0),
    ultimoError: text("ultimo_error"),
    appRespuesta: text("app_respuesta"),
    proximoIntentoEn: timestamp("proximo_intento_en").defaultNow(),
    ultimoIntentoEn: timestamp("ultimo_intento_en"),
    enviadoEn: timestamp("enviado_en"),
    creadoEn: timestamp("creado_en").notNull().defaultNow(),
    actualizadoEn: timestamp("actualizado_en").notNull().defaultNow(),
  },
  (t) => [index("turnos_avisos_envios_estado_prox_idx").on(t.estado, t.proximoIntentoEn)],
);

export type TurnoAvisoEnvio = typeof turnosAvisosEnviosTable.$inferSelect;
