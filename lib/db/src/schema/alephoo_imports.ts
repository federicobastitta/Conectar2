import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

// ── Sesiones de importación desde Alephoo ─────────────────────────────────
// Cada importación de un archivo .xls de Alephoo crea un registro aquí.
// El proceso es idempotente, auditable y reanudable: si se interrumpe se
// puede retomar desde el último nro_fila procesado exitosamente.

export const alephooImportaciones = pgTable("alephoo_importaciones", {
  id: serial("id").primaryKey(),
  nombreArchivo: text("nombre_archivo").notNull(),
  fechaTurno: text("fecha_turno").notNull(), // YYYY-MM-DD para el que se importa
  totalFilas: integer("total_filas").notNull().default(0),
  procesados: integer("procesados").notNull().default(0),
  creadosPacientes: integer("creados_pacientes").notNull().default(0),
  reutilizadosPacientes: integer("reutilizados_pacientes").notNull().default(0),
  creadosTurnos: integer("creados_turnos").notNull().default(0),
  reutilizadosTurnos: integer("reutilizados_turnos").notNull().default(0),
  excluidos: integer("excluidos").notNull().default(0),
  sinEquivalencia: integer("sin_equivalencia").notNull().default(0),
  bandejaRevision: integer("bandeja_revision").notNull().default(0),
  errores: integer("errores").notNull().default(0),
  estado: text("estado").notNull().default("iniciando"),
  // iniciando | en_proceso | completado | error | cancelado
  iniciadoEn: timestamp("iniciado_en", { withTimezone: true }).notNull().defaultNow(),
  finalizadoEn: timestamp("finalizado_en", { withTimezone: true }),
  ultimoProcesoEn: timestamp("ultimo_proceso_en", { withTimezone: true }),
  creadoPor: text("creado_por"),
  resumen: jsonb("resumen"), // JSON final del informe
});

// ── Filas de conciliación por importación ─────────────────────────────────
// Una fila por cada turno del archivo. Permite auditar qué pasó con cada
// registro y reanudar desde nro_fila si el proceso se interrumpe.

export const alephooImportacionesFilas = pgTable(
  "alephoo_importaciones_filas",
  {
    id: serial("id").primaryKey(),
    importacionId: integer("importacion_id").notNull(),
    nroFila: integer("nro_fila").notNull(),
    origenEstado: text("origen_estado"), // Pendiente | A reprogramar | No asistió
    origenApellido: text("origen_apellido"),
    origenNombre: text("origen_nombre"),
    origenDni: text("origen_dni"),
    origenHc: text("origen_hc"),
    origenFecha: text("origen_fecha"),
    origenHora: text("origen_hora"),
    origenSede: text("origen_sede"),
    origenEspecialidad: text("origen_especialidad"),
    origenMedico: text("origen_medico"),
    origenMedicoDni: text("origen_medico_dni"),
    origenConsultorio: text("origen_consultorio"),
    origenCobertura: text("origen_cobertura"),
    origenAfiliado: text("origen_afiliado"),
    origenPlan: text("origen_plan"),
    resultado: text("resultado"),
    // creado_paciente | reutilizado_paciente | creado_turno | reutilizado_turno
    // | excluido | error | sin_equivalencia | bandeja_revision
    pacienteId: integer("paciente_id"),
    turnoId: integer("turno_id"),
    eventoId: integer("evento_id"),
    alertas: text("alertas").array(), // ["sin_prestacion","sin_afiliado","sin_token","sin_equiv_sede",...]
    detalle: text("detalle"),
    creadoEn: timestamp("creado_en", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("alephoo_import_filas_importacion_idx").on(t.importacionId),
    index("alephoo_import_filas_turno_idx").on(t.turnoId),
    index("alephoo_import_filas_resultado_idx").on(t.resultado),
  ],
);

export type AlephooImportacion = typeof alephooImportaciones.$inferSelect;
export type AlephooImportacionFila = typeof alephooImportacionesFilas.$inferSelect;
