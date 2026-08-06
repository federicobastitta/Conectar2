import {
  pgTable,
  text,
  serial,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { pacientesTable } from "./pacientes";
import { turnosTable } from "./turnos";

// Cola de trabajos del robot Klinicos: cada recepción de paciente en Conectar
// encola un trabajo que el robot procesa contra klinicos.aceapp.ar.
export const klinicosTrabajos = pgTable(
  "klinicos_trabajos",
  {
    id: serial("id").primaryKey(),
    pacienteId: integer("paciente_id")
      .notNull()
      .references(() => pacientesTable.id),
    turnoId: integer("turno_id").references(() => turnosTable.id),
    // Datos congelados al encolar (por si el turno/paciente cambia después)
    dni: text("dni").notNull(),
    sexo: text("sexo"),
    celular: text("celular"),
    especialidad: text("especialidad").notNull(),
    motivo: text("motivo"),
    // Derivados por reglas / IA
    sectorServicio: text("sector_servicio").notNull(), // CONSULTORIO | IMAGENES S/C
    profesionalKlinicos: text("profesional_klinicos"), // profesional a machear en el ingreso (viene de la agenda/profesional)
    consultaPor: text("consulta_por"), // redacción clínica generada
    cie10Codigo: text("cie10_codigo"),
    cie10Descripcion: text("cie10_descripcion"),
    practicaCodigos: text("practica_codigos").array(), // códigos IOMA a cargar (si imágenes)
    efectorNombre: text("efector_nombre"),
    prescriptorNombre: text("prescriptor_nombre"), // médico prescriptor (rotación)
    // Orden médica que respalda la práctica en Klinicos: si Conectar ya tiene
    // una orden cargada para el turno/paciente se usa esa; si no, el worker
    // crea una automáticamente (prescriptor rotado) y la vincula acá.
    ordenPracticaId: integer("orden_practica_id"),
    tokenAutorizacion: text("token_autorizacion"), // token IOMA que el paciente le da a recepción (único paso humano)
    // Estado del trabajo
    // pendiente | en_proceso | esperando_aprobacion | completado | error | cancelado
    // esperando_aprobacion (etapa 4, modo asistido): la simulación quedó lista
    // y el operador debe aprobar la ejecución real desde la bandeja.
    estado: text("estado").notNull().default("pendiente"),
    pasoActual: text("paso_actual"), // login | buscar_paciente | alta_paciente | ingreso_ambulatorio | detalle_atencion | prestacion
    pasosCompletados: jsonb("pasos_completados").$type<string[]>().default([]),
    intentos: integer("intentos").notNull().default(0),
    ultimoError: text("ultimo_error"),
    klinicosIngresoCreado: boolean("klinicos_ingreso_creado").notNull().default(false),
    // Guardas anti-duplicado (modo real): se marca ANTES del POST del ingreso;
    // si un reintento encuentra postIntentadoEn sin ingresoCreado, NO re-postea
    // (el resultado del intento anterior es desconocido → revisión manual).
    postIntentadoEn: timestamp("post_intentado_en", { withTimezone: true }),
    klinicosAtencionUrl: text("klinicos_atencion_url"), // URL del detalle de la atención creada
    // Informe de facturación (versión burocrática para la obra social):
    // lo genera la IA automáticamente y sale firmado con la firma escaneada
    // del médico. NO es el informe médico real (ese vive en informesTable).
    informeIaTexto: text("informe_ia_texto"),
    informeIaGeneradoEn: timestamp("informe_ia_generado_en", { withTimezone: true }),
    // PDF del informe guardado en la nube (App Storage): puede ser el PDF
    // generado por nosotros (origen "generado") o un PDF/captura subido a
    // mano desde la bandeja (origen "subido"). El nombre es el apellido del paciente.
    informePdfPath: text("informe_pdf_path"), // /objects/... en el bucket
    informePdfNombre: text("informe_pdf_nombre"),
    informePdfOrigen: text("informe_pdf_origen"), // generado | subido
    informePdfSubidoEn: timestamp("informe_pdf_subido_en", { withTimezone: true }),
    klinicosPrestacionCreada: boolean("klinicos_prestacion_creada").notNull().default(false),
    // Modo simulación (etapa 3 RPA): payload exacto que el robot HABRÍA
    // enviado (ingreso + prestación + plan de autorización), con el token
    // SIEMPRE enmascarado. No se confirma nada en Klinicos.
    simulacionPayload: jsonb("simulacion_payload").$type<Record<string, unknown>>(),
    simulacionEn: timestamp("simulacion_en", { withTimezone: true }),
    // Modo asistido (etapa 4): confirmación humana por caso antes de la carga real
    aprobadoPor: text("aprobado_por"), // email del operador que aprobó
    aprobadoEn: timestamp("aprobado_en", { withTimezone: true }),
    // Guardas anti doble-POST de la prestación (mismo patrón que postIntentadoEn)
    prestacionPostIntentadoEn: timestamp("prestacion_post_intentado_en", { withTimezone: true }),
    klinicosPrestacionNumero: text("klinicos_prestacion_numero"), // ej. P-2026-198669
    // Guardas y resultado de la autorización con token (fail-closed: un token
    // jamás se reconsume; incierto ≠ rechazo)
    autorizacionPostIntentadoEn: timestamp("autorizacion_post_intentado_en", { withTimezone: true }),
    autorizacionResultado: text("autorizacion_resultado"), // aceptado | rechazado | incierto
    klinicosNroBono: text("klinicos_nro_bono"),
    // Guardas del adjunto de la orden médica (lección 03/08/2026): el PDF de
    // la orden de Conectar se sube a la atención vía "Adjuntar documentación".
    // Mismo patrón anti doble-POST que el ingreso/prestación.
    ordenAdjuntoIntentadoEn: timestamp("orden_adjunto_intentado_en", { withTimezone: true }),
    ordenAdjuntada: boolean("orden_adjuntada").notNull().default(false),
    ordenAdjuntoDetalle: text("orden_adjunto_detalle"),
    creadoEn: timestamp("creado_en", { withTimezone: true }).notNull().defaultNow(),
    actualizadoEn: timestamp("actualizado_en", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("klinicos_trabajos_estado_idx").on(t.estado),
    index("klinicos_trabajos_paciente_idx").on(t.pacienteId),
  ],
);

// Regla especialidad → Sector/Servicio de Klinicos
export const klinicosReglasSector = pgTable("klinicos_reglas_sector", {
  id: serial("id").primaryKey(),
  especialidad: text("especialidad").notNull().unique(), // nombre normalizado (mayúsculas sin acentos)
  sectorServicio: text("sector_servicio").notNull(), // CONSULTORIO | IMAGENES S/C
  activo: boolean("activo").notNull().default(true),
  creadoEn: timestamp("creado_en", { withTimezone: true }).notNull().defaultNow(),
});

// Catálogo de prácticas: estudio → códigos IOMA + efector
export const klinicosPracticas = pgTable("klinicos_practicas", {
  id: serial("id").primaryKey(),
  nombre: text("nombre").notNull(), // ej: ECO ABDOMEN
  categoria: text("categoria"), // ej: DIAGNOSTICO POR IMAGENES, CARDIOLOGIA, PESADOS 88
  codigos: text("codigos").array().notNull(), // códigos IOMA (hasta 4 por formulario)
  // Código de ENVÍO a Conectar: el string exacto de la planilla acordada, con
  // separadores y sufijos preservados (ej. "290101-290102-420102",
  // "340601+340601+340602+340602", "881841/A+881841/B"). Es lo que viaja como
  // practice_code al Robot; si falta se cae a codigoFacturacion o a la
  // planilla embebida en el server, y si nada matchea el caso queda para
  // revisión manual (nunca se inventa un código).
  codigoEnvio: text("codigo_envio"),
  // Override manual legado del practice_code (misma semántica que codigoEnvio;
  // se mantiene por compatibilidad y como segundo nivel de resolución).
  codigoFacturacion: text("codigo_facturacion"),
  codigosAdicionales: text("codigos_adicionales").array(), // ej: blanco y negro de pesados 88
  efectorNombre: text("efector_nombre"), // profesional efector en Klinicos
  activo: boolean("activo").notNull().default(true),
  creadoEn: timestamp("creado_en", { withTimezone: true }).notNull().defaultNow(),
});

// Regla de equivalencia especialidad → práctica: si el turno matchea la
// especialidad (y opcionalmente un patrón sobre el motivo), se elige esta
// práctica directo, sin depender del match por nombre. Mayor prioridad gana.
export const klinicosReglasPractica = pgTable("klinicos_reglas_practica", {
  id: serial("id").primaryKey(),
  especialidad: text("especialidad").notNull(), // normalizada (mayúsculas sin acentos)
  patronMotivo: text("patron_motivo"), // texto opcional a buscar dentro del motivo (normalizado); null = cualquier motivo
  practicaId: integer("practica_id")
    .notNull()
    .references(() => klinicosPracticas.id),
  prioridad: integer("prioridad").notNull().default(0), // mayor gana
  activo: boolean("activo").notNull().default(true),
  creadoEn: timestamp("creado_en", { withTimezone: true }).notNull().defaultNow(),
});

// Equivalencias motivo → CIE-10: si el texto del turno (motivo + especialidad,
// normalizado) contiene el patrón, se usa este diagnóstico y NO se llama a la
// IA. La IA queda como respaldo para lo que no matchea ninguna regla.
export const klinicosReglasCie10 = pgTable("klinicos_reglas_cie10", {
  id: serial("id").primaryKey(),
  patron: text("patron").notNull(), // texto a buscar (normalizado, sin acentos)
  cie10Codigo: text("cie10_codigo").notNull(),
  cie10Descripcion: text("cie10_descripcion").notNull(),
  consultaPor: text("consulta_por"), // redacción opcional; si falta se genera genérica
  prioridad: integer("prioridad").notNull().default(0),
  activo: boolean("activo").notNull().default(true),
  creadoEn: timestamp("creado_en", { withTimezone: true }).notNull().defaultNow(),
});

// Médicos prescriptores de Klinicos: el robot rota entre los activos para el
// campo "Prescriptor" de la prestación. Los ginecólogos se excluyen para
// pacientes varones.
export const klinicosPrescriptores = pgTable("klinicos_prescriptores", {
  id: serial("id").primaryKey(),
  nombre: text("nombre").notNull().unique(), // tal como figura en Klinicos
  matricula: text("matricula"), // el portal la exige para prescriptor "externo al establecimiento"
  especialidad: text("especialidad"),
  esGinecologo: boolean("es_ginecologo").notNull().default(false),
  activo: boolean("activo").notNull().default(true),
  ultimoUsoEn: timestamp("ultimo_uso_en", { withTimezone: true }), // para rotación round-robin
  creadoEn: timestamp("creado_en", { withTimezone: true }).notNull().defaultNow(),
});

// Profesionales del ingreso ambulatorio por especialidad: cuando una
// especialidad tiene filas activas acá, el robot ROTA entre ellas (round-robin)
// para el campo "Profesional" del ingreso, en vez de usar el espejo del
// profesional de Conectar. Pedido del 31/07/2026 para CLINICA MEDICA: usar
// todos los del desplegable de Klinicos MENOS "CANESTRO, FERREYRA".
// La elección explícita de recepción en la ficha del turno sigue teniendo
// prioridad sobre la rotación.
export const klinicosProfesionalesIngreso = pgTable(
  "klinicos_profesionales_ingreso",
  {
    id: serial("id").primaryKey(),
    especialidad: text("especialidad").notNull(), // normalizada (mayúsculas sin acentos)
    nombre: text("nombre").notNull(), // tal como figura en el desplegable de Klinicos
    activo: boolean("activo").notNull().default(true),
    ultimoUsoEn: timestamp("ultimo_uso_en", { withTimezone: true }), // round-robin
    creadoEn: timestamp("creado_en", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("klinicos_prof_ingreso_unq").on(t.especialidad, t.nombre)],
);

// Validaciones de token IOMA contra el Robot externo (ROBOT_API_URL).
// Cada intento queda registrado: fecha, resultado, referencia de Klinicos y
// latencia. NUNCA se guarda el token completo (solo los últimos 4 dígitos).
export const klinicosTokenValidaciones = pgTable(
  "klinicos_token_validaciones",
  {
    id: serial("id").primaryKey(),
    turnoId: integer("turno_id")
      .notNull()
      .references(() => turnosTable.id),
    requestId: text("request_id").notNull(), // se reutiliza en reintentos técnicos
    tokenUltimos4: text("token_ultimos4").notNull(),
    estado: text("estado").notNull(), // TOKEN_ACCEPTED | TOKEN_DENIED | TOKEN_EXPIRED | TOKEN_ALREADY_USED | PATIENT_MISMATCH | TECHNICAL_ERROR | TIMEOUT | MANUAL_REVIEW
    motivo: text("motivo"),
    referenciaKlinicos: text("referencia_klinicos"),
    latenciaMs: integer("latencia_ms"),
    creadoEn: timestamp("creado_en", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("klinicos_token_valid_turno_idx").on(t.turnoId)],
);

export const insertKlinicosTrabajoSchema = createInsertSchema(klinicosTrabajos).omit({
  id: true,
  creadoEn: true,
  actualizadoEn: true,
});
export const insertKlinicosReglaSectorSchema = createInsertSchema(klinicosReglasSector).omit({
  id: true,
  creadoEn: true,
});
export const insertKlinicosPracticaSchema = createInsertSchema(klinicosPracticas).omit({
  id: true,
  creadoEn: true,
});
export const insertKlinicosReglaPracticaSchema = createInsertSchema(klinicosReglasPractica).omit({
  id: true,
  creadoEn: true,
});
export const insertKlinicosReglaCie10Schema = createInsertSchema(klinicosReglasCie10).omit({
  id: true,
  creadoEn: true,
});

export type KlinicosTrabajo = typeof klinicosTrabajos.$inferSelect;
export type InsertKlinicosTrabajo = z.infer<typeof insertKlinicosTrabajoSchema>;
export type KlinicosReglaSector = typeof klinicosReglasSector.$inferSelect;
export type KlinicosPractica = typeof klinicosPracticas.$inferSelect;
export type KlinicosReglaPractica = typeof klinicosReglasPractica.$inferSelect;
export type KlinicosReglaCie10 = typeof klinicosReglasCie10.$inferSelect;
export type KlinicosPrescriptor = typeof klinicosPrescriptores.$inferSelect;
