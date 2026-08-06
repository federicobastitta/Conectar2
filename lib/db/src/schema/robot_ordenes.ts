import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ── Cola de envío de órdenes de estudio al Robot Klinicos ─────────────────
// Cada orden de estudio generada en Conectar se encola acá y un worker la
// empuja a POST {ROBOT_API_URL}/api/integraciones/ordenes (auth x-api-key).
// El envío nunca bloquea la atención: si el Robot está caído se reintenta
// con backoff exponencial hasta MAX_INTENTOS.
export const robotOrdenesEnvios = pgTable(
  "robot_ordenes_envios",
  {
    id: serial("id").primaryKey(),
    ordenId: integer("orden_id").notNull(), // study_orders.id
    estado: text("estado").notNull().default("pendiente"), // pendiente | enviado | error_permanente
    intentos: integer("intentos").notNull().default(0),
    ultimoError: text("ultimo_error"),
    robotRespuesta: text("robot_respuesta"), // body de la respuesta del Robot (truncado)
    ultimoIntentoEn: timestamp("ultimo_intento_en", { withTimezone: true }),
    proximoIntentoEn: timestamp("proximo_intento_en", { withTimezone: true }).defaultNow(),
    enviadoEn: timestamp("enviado_en", { withTimezone: true }),
    creadoEn: timestamp("creado_en", { withTimezone: true }).notNull().defaultNow(),
    actualizadoEn: timestamp("actualizado_en", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("robot_ordenes_envios_orden_uidx").on(t.ordenId),
    index("robot_ordenes_envios_estado_proximo_idx").on(t.estado, t.proximoIntentoEn),
  ],
);

export type RobotOrdenEnvio = typeof robotOrdenesEnvios.$inferSelect;
