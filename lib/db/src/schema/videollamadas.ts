import { pgTable, serial, integer, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { pacientesTable } from "./pacientes";
import { usersTable } from "./users";
import { turnosTable } from "./turnos";

// Videollamadas médico-paciente. La sala es un nombre único de Jitsi;
// el paciente ve la llamada activa en su portal y se une desde ahí.
export const VIDEOLLAMADA_ESTADOS = ["activa", "finalizada"] as const;
export type VideollamadaEstado = (typeof VIDEOLLAMADA_ESTADOS)[number];

export const videollamadasTable = pgTable(
  "videollamadas",
  {
    id: serial("id").primaryKey(),
    pacienteId: integer("paciente_id")
      .notNull()
      .references(() => pacientesTable.id),
    medicoUserId: integer("medico_user_id")
      .notNull()
      .references(() => usersTable.id),
    sala: text("sala").notNull().unique(),
    estado: text("estado").notNull().default("activa"),
    creadaEn: timestamp("creada_en").notNull().defaultNow(),
    finalizadaEn: timestamp("finalizada_en"),
  },
  (t) => [
    index("videollamadas_paciente_estado_idx").on(t.pacienteId, t.estado),
    index("videollamadas_medico_estado_idx").on(t.medicoUserId, t.estado),
  ],
);

// ── Guardia virtual (videollamadas de guardia para IOMA) ────────────────────
// El paciente se anota desde el portal Mi Diagnosticar (antesala), después
// manda DNI + token IOMA; con token válido se crea el turno de guardia
// (modalidad videoconsulta) y el link Jitsi sale de urlVideollamadaTurno.
export const VIDEOLLAMADA_COLA_ESTADOS = [
  "en_cola", // anotado en la antesala, sin token todavía
  "recepcionado", // token válido, turno de guardia creado
  "tu_turno", // el médico lo llamó (push con link enviado)
  "finalizada",
  "cancelada",
] as const;
export type VideollamadaColaEstado = (typeof VIDEOLLAMADA_COLA_ESTADOS)[number];

export const videollamadasColaTable = pgTable(
  "videollamadas_cola",
  {
    id: serial("id").primaryKey(),
    dni: text("dni").notNull(),
    nombre: text("nombre"),
    apellido: text("apellido"),
    telefono: text("telefono"),
    obraSocial: text("obra_social"),
    pacienteId: integer("paciente_id").references(() => pacientesTable.id),
    turnoId: integer("turno_id").references(() => turnosTable.id),
    estado: text("estado").notNull().default("en_cola"),
    // Posición ofrecida al anotarse (1°, 2°, 3°...) y demora estimada en ese momento.
    posicionInicial: integer("posicion_inicial"),
    demoraEstimadaMin: integer("demora_estimada_min"),
    // Última posición avisada al portal (avance de fila). Solo se reenvía
    // "en_cola" cuando la posición BAJA respecto de este valor (anti-spam).
    ultimaPosicionAvisada: integer("ultima_posicion_avisada"),
    motivo: text("motivo"),
    motivoCancelacion: text("motivo_cancelacion"),
    creadoEn: timestamp("creado_en").notNull().defaultNow(),
    actualizadoEn: timestamp("actualizado_en").notNull().defaultNow(),
    finalizadaEn: timestamp("finalizada_en"),
  },
  (t) => [
    index("videollamadas_cola_dni_estado_idx").on(t.dni, t.estado),
    index("videollamadas_cola_turno_idx").on(t.turnoId),
    index("videollamadas_cola_estado_idx").on(t.estado),
  ],
);

// Cola durable de avisos salientes al portal (patrón certificados_app_envios):
// POST {APP_PACIENTE_PUSH_URL}/api/integracion/videollamadas con Bearer.
// Estados que acepta el portal: en_cola, tu_turno, cancelada, finalizada.
// Regla del portal: tu_turno SIN linkVideollamada se rechaza con 400 — el
// payload se congela al encolar y el link es obligatorio para tu_turno.
export const videollamadasEnviosTable = pgTable(
  "videollamadas_envios",
  {
    id: serial("id").primaryKey(),
    colaId: integer("cola_id")
      .notNull()
      .references(() => videollamadasColaTable.id),
    evento: text("evento").notNull(), // en_cola | tu_turno | cancelada | finalizada
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
  (t) => [index("videollamadas_envios_estado_prox_idx").on(t.estado, t.proximoIntentoEn)],
);
