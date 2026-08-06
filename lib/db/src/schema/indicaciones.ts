import { sql } from "drizzle-orm";
import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  date,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ── Indicaciones para el paciente (plan de atención) ──────────────────────
// Documento que el médico arma al final de la consulta con todo lo que el
// paciente tiene que hacer: estudios a realizar, medicamentos y cómo
// tomarlos, y otras indicaciones especiales. Se genera PDF y se empuja a la
// app del paciente igual que los certificados.
export const indicacionesPacientesTable = pgTable(
  "indicaciones_pacientes",
  {
    id: serial("id").primaryKey(),
    patientId: integer("patient_id").notNull(), // pacientes.id
    professionalId: integer("professional_id").notNull(), // profesionales.id
    consultationId: integer("consultation_id"), // turnos.id (opcional)
    estudios: text("estudios"), // estudios a realizar
    medicamentos: text("medicamentos"), // medicamentos y cómo tomarlos
    otrasIndicaciones: text("otras_indicaciones"), // pautas especiales
    verificationCode: text("verification_code").notNull(), // idempotencia del push a la app
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Día argentino de la indicación: sostiene el invariante "una por
    // paciente+profesional+día" (las expresiones AT TIME ZONE no pueden ir
    // en un índice funcional por no ser IMMUTABLE).
    fecha: date("fecha", { mode: "string" })
      .notNull()
      .default(sql`((now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date)`),
  },
  (t) => [
    index("indicaciones_pacientes_patient_idx").on(t.patientId, t.createdAt),
    uniqueIndex("indicaciones_pacientes_codigo_uidx").on(t.verificationCode),
    uniqueIndex("indicaciones_pacientes_dia_uidx").on(t.patientId, t.professionalId, t.fecha),
  ],
);

export type IndicacionPaciente = typeof indicacionesPacientesTable.$inferSelect;

// ── Cola de envío de indicaciones a la app del paciente ───────────────────
// Mismo diseño que certificados_app_envios: cola durable + worker con
// backoff; el envío nunca bloquea la emisión.
export const indicacionesAppEnvios = pgTable(
  "indicaciones_app_envios",
  {
    id: serial("id").primaryKey(),
    indicacionId: integer("indicacion_id").notNull(), // indicaciones_pacientes.id
    estado: text("estado").notNull().default("pendiente"), // pendiente | enviado | error_permanente
    intentos: integer("intentos").notNull().default(0),
    ultimoError: text("ultimo_error"),
    appRespuesta: text("app_respuesta"),
    ultimoIntentoEn: timestamp("ultimo_intento_en", { withTimezone: true }),
    proximoIntentoEn: timestamp("proximo_intento_en", { withTimezone: true }).defaultNow(),
    enviadoEn: timestamp("enviado_en", { withTimezone: true }),
    creadoEn: timestamp("creado_en", { withTimezone: true }).notNull().defaultNow(),
    actualizadoEn: timestamp("actualizado_en", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("indicaciones_app_envios_ind_uidx").on(t.indicacionId),
    index("indicaciones_app_envios_estado_proximo_idx").on(t.estado, t.proximoIntentoEn),
  ],
);

export type IndicacionAppEnvio = typeof indicacionesAppEnvios.$inferSelect;
