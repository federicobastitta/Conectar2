import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ── Cola de envío de certificados a la app del paciente ───────────────────
// Cada certificado emitido en Conectar se encola acá y un worker lo empuja a
// POST {APP_PACIENTE_PUSH_URL}/api/integracion/certificados (auth Bearer con
// APP_PACIENTE_PUSH_TOKEN). El envío nunca bloquea la emisión: si el portal
// del paciente está caído (o todavía no está configurado) queda pendiente y
// se reintenta solo con backoff exponencial.
export const certificadosAppEnvios = pgTable(
  "certificados_app_envios",
  {
    id: serial("id").primaryKey(),
    certificadoId: integer("certificado_id").notNull(), // certificates.id
    estado: text("estado").notNull().default("pendiente"), // pendiente | enviado | error_permanente
    intentos: integer("intentos").notNull().default(0),
    ultimoError: text("ultimo_error"),
    appRespuesta: text("app_respuesta"), // body de la respuesta de la app (truncado)
    ultimoIntentoEn: timestamp("ultimo_intento_en", { withTimezone: true }),
    proximoIntentoEn: timestamp("proximo_intento_en", { withTimezone: true }).defaultNow(),
    enviadoEn: timestamp("enviado_en", { withTimezone: true }),
    creadoEn: timestamp("creado_en", { withTimezone: true }).notNull().defaultNow(),
    actualizadoEn: timestamp("actualizado_en", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("certificados_app_envios_cert_uidx").on(t.certificadoId),
    index("certificados_app_envios_estado_proximo_idx").on(t.estado, t.proximoIntentoEn),
  ],
);

export type CertificadoAppEnvio = typeof certificadosAppEnvios.$inferSelect;
