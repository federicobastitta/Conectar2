import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ── Catálogo administrable de prácticas ──────────────────────────────────────
// Fuente de verdad de todas las prácticas que Conectar puede ordenar.
// Pulso queda solo lectura para órdenes anteriores a FECHA_CORTE_PULSO.
// No hardcodear prácticas: el administrador completa y mantiene este catálogo.

export const practicasCatalogoTable = pgTable(
  "practicas_catalogo",
  {
    id: serial("id").primaryKey(),
    // Código único legible, e.g. "ECG-REPOSO", "HOLTER-24H"
    codigo: text("codigo").notNull(),
    nombre: text("nombre").notNull(),
    especialidad: text("especialidad").notNull().default("CARDIOLOGIA"),
    // Agrupador del asistente de órdenes: resonancia | tomografia | ecografia |
    // mamografia | radiologia | cardiologia | laboratorio | otros
    categoria: text("categoria").notNull().default("otros"),
    permiteContraste: boolean("permite_contraste").notNull().default(false),
    // Modalidad DICOM enviada al PACS (ECG, US, OT, etc.). Null = no DICOM.
    modalidadDicom: text("modalidad_dicom"),
    // Si true → orden se envía a DiagnosticPACS vía contrato v1.0.
    // Si false → queda en bandeja de informes estructurados de Conectar.
    generaDicom: boolean("genera_dicom").notNull().default(true),
    // Si true → el workspace de informe lo provee DiagnosticPACS (sesión segura).
    // Si false → Conectar muestra el editor de informes estructurados propio.
    usaWorkspacePacs: boolean("usa_workspace_pacs").notNull().default(true),
    // Validación TOKEN Klinicos requerida antes de emitir la orden
    requiereTokenKlinicos: boolean("requiere_token_klinicos").notNull().default(false),
    requiereRegion: boolean("requiere_region").notNull().default(false),
    requiereLateralidad: boolean("requiere_lateralidad").notNull().default(false),
    preparacion: text("preparacion"),
    // Documentación mínima necesaria (texto libre para el operador)
    requisitosDocumentacion: text("requisitos_documentacion"),
    // Datos de mapeo en el Robot Klinicos: { practiceId, practiceCode, catalog }
    reglasKlinicos: jsonb("reglas_klinicos").$type<{
      practiceId?: string;
      practiceCode?: string;
      catalog?: string;
      description?: string;
    } | null>(),
    // Códigos del nomenclador que componen el estudio. Algunos estudios
    // facturan varios códigos juntos (ej. Eco Abdomen = 180112 + 180113) y
    // pueden repetir un código para indicar cantidad (mamografía bilateral =
    // 340601 x2 + 340602 x2). Null/vacío = usar el código derivado de `codigo`.
    codigos: jsonb("codigos").$type<string[] | null>(),
    // Profesional informante habitual (FK a profesionales, opcional)
    profesionalInformanteId: integer("profesional_informante_id"),
    activo: boolean("activo").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("practicas_catalogo_codigo_unico").on(t.codigo)],
);

export type PracticaCatalogo = typeof practicasCatalogoTable.$inferSelect;

// ── Estados de la orden ──────────────────────────────────────────────────────
export const ESTADOS_ORDEN_PRACTICA = [
  "creada",
  "pendiente_validacion",
  "validada",
  "arribado",
  "en_realizacion",
  "pendiente_informe",
  "informada",
  "publicada",
  "rechazada",
  "cancelada",
] as const;
export type EstadoOrdenPractica = (typeof ESTADOS_ORDEN_PRACTICA)[number];

export const PRIORIDADES_ORDEN = ["normal", "urgente", "programada"] as const;
export type PrioridadOrden = (typeof PRIORIDADES_ORDEN)[number];

// ── Órdenes de prácticas ──────────────────────────────────────────────────────
// Genera todas las órdenes nuevas. Pulso queda congelado para historial anterior
// a la fecha de corte; ninguna orden nueva se duplica allí.
//
// Separación informe/anexos (regla invariable):
//   - informeEjecutivoUrl   → PDF firmado, 1 hoja A4, conclusión + firma
//   - informeAnexosUrl      → trazados, tablas, mediciones, DICOM multipágina (sin límite)
// DiagnosticPACS es dueño del workspace/editor/IA/firma para prácticas DICOM.
// Conectar no almacena DICOM ni reconstruye el motor de IA.

export const ordenesPracticasTable = pgTable(
  "ordenes_practicas",
  {
    id: serial("id").primaryKey(),
    // UUID inmutable = order_id enviado al PACS (CM-1 del contrato v1.0)
    ordenUuid: text("orden_uuid").notNull(),
    // Número legible: OP-{YYYY}-{id 6 dígitos}
    numeroOrden: text("numero_orden").notNull(),
    // Accession number: C{AA}-{12 dígitos}, único e inmutable (CM-1)
    accessionNumber: text("accession_number"),

    // ── Identidad ─────────────────────────────────────────────────────────
    patientId: integer("patient_id").notNull(),
    professionalId: integer("professional_id").notNull(),
    practicaId: integer("practica_id").notNull(),
    sedeId: integer("sede_id"),

    // ── Estado ────────────────────────────────────────────────────────────
    estado: text("estado").$type<EstadoOrdenPractica>().notNull().default("creada"),
    prioridad: text("prioridad").$type<PrioridadOrden>().notNull().default("normal"),

    // ── Clínica ───────────────────────────────────────────────────────────
    motivoClinico: text("motivo_clinico").notNull(),
    diagnosticoCie10: text("diagnostico_cie10"),
    region: text("region"),
    lateralidad: text("lateralidad"),
    observaciones: text("observaciones"),

    // ── Fechas ────────────────────────────────────────────────────────────
    fechaOrden: text("fecha_orden").notNull(), // YYYY-MM-DD
    fechaRealizacionEstimada: text("fecha_realizacion_estimada"),

    // ── Cobertura ─────────────────────────────────────────────────────────
    coberturaObra: text("cobertura_obra"),
    coberturaPlan: text("cobertura_plan"),
    coberturaNumeroAfiliado: text("cobertura_numero_afiliado"),

    // ── Validación Klinicos / TOKEN ────────────────────────────────────────
    // TOKEN_ACCEPTED es el único estado que habilita la orden cuando aplique.
    // TOKEN_DENIED = rechazo real; TECHNICAL_ERROR/TIMEOUT ≠ denegación.
    klinicosRequestId: text("klinicos_request_id"),
    klinicosEstado: text("klinicos_estado"),
    klinicosAuthorizationNumber: text("klinicos_authorization_number"),
    klinicosTokenMasked: text("klinicos_token_masked"), // NUNCA el token completo

    // ── PACS ──────────────────────────────────────────────────────────────
    pacsOrdenEnviada: boolean("pacs_orden_enviada").notNull().default(false),

    // ── Informe recibido desde DiagnosticPACS ─────────────────────────────
    // Informe ejecutivo firmado: 1 hoja A4, conclusión obligatoria (≥20 chars),
    // firma con nombre + matrícula + especialidad + fecha + checksum.
    // Los trazados, tablas, mediciones y DICOM van en informeAnexosUrl (multipágina OK).
    informeEjecutivoUrl: text("informe_ejecutivo_url"),
    informeEjecutivoTexto: jsonb("informe_ejecutivo_texto").$type<{
      secciones?: Array<{ titulo: string; contenido: string }>;
      motivo?: string;
      conclusion?: string;
    } | null>(),
    informeAnexosUrl: text("informe_anexos_url"),
    informeVersion: integer("informe_version"),
    informeChecksum: text("informe_checksum"),
    // Conclusión extraída para acceso rápido — mínimo 20 caracteres
    informeConclusion: text("informe_conclusion"),
    // Debe ser 1 para informes ejecutivos firmados (>1 bloquea firma en PACS)
    informePaginasEjecutivo: integer("informe_paginas_ejecutivo"),
    informeFirmanteNombre: text("informe_firmante_nombre"),
    informeFirmanteMatricula: text("informe_firmante_matricula"),
    informeFirmanteEspecialidad: text("informe_firmante_especialidad"),
    informeFirmadoAt: timestamp("informe_firmado_at", { withTimezone: true }),

    // ── Vínculo con el turno agendado (circuito pedido→agendado) ─────────
    turnoId: integer("turno_id"),

    // ── Motivos de corte ──────────────────────────────────────────────────
    canceladoMotivo: text("cancelado_motivo"),
    rechazadoMotivo: text("rechazado_motivo"),

    // ── Auditoría ─────────────────────────────────────────────────────────
    createdBy: integer("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("ordenes_practicas_uuid_unico").on(t.ordenUuid),
    uniqueIndex("ordenes_practicas_numero_unico").on(t.numeroOrden),
    uniqueIndex("ordenes_practicas_accession_unico")
      .on(t.accessionNumber)
      .where(sql`${t.accessionNumber} IS NOT NULL`),
    index("ordenes_practicas_patient_idx").on(t.patientId),
    index("ordenes_practicas_estado_idx").on(t.estado),
    index("ordenes_practicas_fecha_idx").on(t.fechaOrden),
  ],
);

export type OrdenPractica = typeof ordenesPracticasTable.$inferSelect;

// ── Log de transiciones de estado ────────────────────────────────────────────
export const ordenesPracticasLogTable = pgTable(
  "ordenes_practicas_log",
  {
    id: serial("id").primaryKey(),
    ordenId: integer("orden_id").notNull(),
    estadoAnterior: text("estado_anterior"),
    estadoNuevo: text("estado_nuevo").notNull(),
    autorId: integer("autor_id"),
    motivo: text("motivo"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ordenes_practicas_log_orden_idx").on(t.ordenId)],
);

export type OrdenPracticaLog = typeof ordenesPracticasLogTable.$inferSelect;

// ── Fecha de corte Pulso ───────────────────────────────────────────────────────
// Pulso queda solo lectura para órdenes ANTERIORES a esta fecha.
// Ninguna orden nueva se genera en Pulso a partir de este módulo.
export const FECHA_CORTE_PULSO = "2026-07-21";
