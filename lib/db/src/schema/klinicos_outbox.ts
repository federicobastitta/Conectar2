import {
  pgTable,
  text,
  serial,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ── Bandeja de salida al Robot (Transactional Outbox) ─────────────────────
// Un evento por cada cambio de turno relevante: ALTA, ACTUALIZACION,
// REPROGRAMACION, CANCELACION, TOKEN_DISPONIBLE. Se crea dentro de la misma
// transacción que el turno para garantizar consistencia. El worker de entrega
// lo envía al endpoint del Robot y solo marca entregado cuando el Robot
// confirma persistencia. La fecha de elegibilidad (00:01 AR del día del turno)
// se incluye en el payload para que el Robot sepa cuándo ejecutarlo.

export const klinicosEventosSalida = pgTable(
  "klinicos_eventos_salida",
  {
    id: serial("id").primaryKey(),
    turnoId: integer("turno_id").notNull(),
    version: integer("version").notNull(), // monotónico por turnoId
    tipoEvento: text("tipo_evento").notNull(), // ALTA | ACTUALIZACION | REPROGRAMACION | CANCELACION | TOKEN_DISPONIBLE
    payload: jsonb("payload").notNull(), // snapshot completo al momento del evento
    estado: text("estado").notNull().default("pendiente"), // pendiente | enviando | entregado | reintento | error_permanente
    intentos: integer("intentos").notNull().default(0),
    ultimoIntentoEn: timestamp("ultimo_intento_en", { withTimezone: true }),
    proximoIntentoEn: timestamp("proximo_intento_en", { withTimezone: true }).defaultNow(),
    robotConfirmacionId: text("robot_confirmacion_id"), // ID del Robot al persistir
    robotConfirmadoEn: timestamp("robot_confirmado_en", { withTimezone: true }),
    errorTexto: text("error_texto"),
    creadoEn: timestamp("creado_en", { withTimezone: true }).notNull().defaultNow(),
    actualizadoEn: timestamp("actualizado_en", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("klinicos_ev_salida_turno_version_uidx").on(t.turnoId, t.version),
    index("klinicos_ev_salida_estado_proximo_idx").on(t.estado, t.proximoIntentoEn),
    index("klinicos_ev_salida_turno_idx").on(t.turnoId),
  ],
);

// ── Estado operativo informado por el Robot ────────────────────────────────
// El Robot llama back al endpoint /api/robot-klinicos/appointments/status
// después de procesar cada evento. Esta tabla guarda el último estado conocido.
// Muestra en recepción el estado operativo en Klinicos.
export const klinicosEstadoRobot = pgTable(
  "klinicos_estado_robot",
  {
    id: serial("id").primaryKey(),
    turnoId: integer("turno_id").notNull(),
    estadoOperativo: text("estado_operativo").notNull().default("sin_evento"),
    // sin_evento | en_buffer | en_proceso | a_confirmar | confirmado | rechazado | excluido
    klinicosIngresoId: text("klinicos_ingreso_id"),
    klinicosIngresoUrl: text("klinicos_ingreso_url"),
    ultimoEventoId: integer("ultimo_evento_id"),
    ultimoReporteEn: timestamp("ultimo_reporte_en", { withTimezone: true }),
    detalleRobot: text("detalle_robot"),
    creadoEn: timestamp("creado_en", { withTimezone: true }).notNull().defaultNow(),
    actualizadoEn: timestamp("actualizado_en", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("klinicos_estado_robot_turno_uidx").on(t.turnoId)],
);

// ── Equivalencias Conectar → Klinicos ─────────────────────────────────────
// Mapean entidades de Conectar a los nombres/IDs exactos del portal Klinicos.
// Sin equivalencia completa → el evento se crea con alertas pero sin bloquear
// la reserva. Faltan equivalencias → estado_operativo "sin_equiv".

export const klinicosEqSedes = pgTable(
  "klinicos_eq_sedes",
  {
    id: serial("id").primaryKey(),
    sedeId: integer("sede_id").notNull(),
    klinicosEstablecimiento: text("klinicos_establecimiento").notNull(),
    klinicosSector: text("klinicos_sector"), // ej: ADMINISTRACIÓN
    activo: boolean("activo").notNull().default(true),
    creadoEn: timestamp("creado_en", { withTimezone: true }).notNull().defaultNow(),
    actualizadoEn: timestamp("actualizado_en", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("klinicos_eq_sedes_sede_uidx").on(t.sedeId)],
);

export const klinicosEqEspecialidades = pgTable(
  "klinicos_eq_especialidades",
  {
    id: serial("id").primaryKey(),
    especialidadId: integer("especialidad_id").notNull(),
    klinicosEspecialidad: text("klinicos_especialidad").notNull(),
    activo: boolean("activo").notNull().default(true),
    creadoEn: timestamp("creado_en", { withTimezone: true }).notNull().defaultNow(),
    actualizadoEn: timestamp("actualizado_en", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("klinicos_eq_especialidades_esp_uidx").on(t.especialidadId)],
);

export const klinicosEqProfesionales = pgTable(
  "klinicos_eq_profesionales",
  {
    id: serial("id").primaryKey(),
    profesionalId: integer("profesional_id").notNull(),
    klinicosProfesionalNombre: text("klinicos_profesional_nombre").notNull(),
    activo: boolean("activo").notNull().default(true),
    creadoEn: timestamp("creado_en", { withTimezone: true }).notNull().defaultNow(),
    actualizadoEn: timestamp("actualizado_en", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("klinicos_eq_profesionales_prof_uidx").on(t.profesionalId)],
);

// ── Auditoría de la bandeja de salida ─────────────────────────────────────
export const klinicosEventosLog = pgTable(
  "klinicos_eventos_log",
  {
    id: serial("id").primaryKey(),
    eventoId: integer("evento_id").notNull(),
    turnoId: integer("turno_id").notNull(),
    accion: text("accion").notNull(), // crear | enviar | confirmar_entrega | reintentar | error | error_permanente
    estadoAntes: text("estado_antes"),
    estadoDespues: text("estado_despues"),
    fechaPrevista: timestamp("fecha_prevista", { withTimezone: true }), // elegibilidad programada
    fechaRealIntento: timestamp("fecha_real_intento", { withTimezone: true }),
    timezone: text("timezone").notNull().default("America/Argentina/Buenos_Aires"),
    resultado: text("resultado"), // ok | error | excluido
    detalle: text("detalle"),
    creadoEn: timestamp("creado_en", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("klinicos_eventos_log_evento_idx").on(t.eventoId),
    index("klinicos_eventos_log_turno_idx").on(t.turnoId),
  ],
);

export type KlinicosEventoSalida = typeof klinicosEventosSalida.$inferSelect;
export type KlinicosEstadoRobot = typeof klinicosEstadoRobot.$inferSelect;
export type KlinicosEqSede = typeof klinicosEqSedes.$inferSelect;
export type KlinicosEqEspecialidad = typeof klinicosEqEspecialidades.$inferSelect;
export type KlinicosEqProfesional = typeof klinicosEqProfesionales.$inferSelect;
