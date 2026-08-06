/**
 * Tipos del pipeline de importación Alephoo
 *
 * Pipeline: raw → staging → normalización → dedup → cuarentena →
 *           conciliación → aprobación → incorporación
 *
 * Cada fila del Excel mantiene:
 *   - fila_numero: número de fila en el archivo original (para trazabilidad)
 *   - archivo_s3_key: key del archivo Excel en S3
 *   - upload_id: identificador de la sesión de importación
 */

// ── Estado de cada fila en el pipeline ────────────────────────────────────────

export type EstadoFilaPipeline =
  | "raw"              // leída del Excel, sin procesar
  | "staging"          // parseada y tipada
  | "normalizada"      // campos normalizados (DNI sin puntos, fechas ISO, etc.)
  | "duplicado_exacto" // idéntica a un registro ya importado
  | "duplicado_probable" // similar — requiere revisión
  | "cuarentena"       // datos inválidos o inconsistentes
  | "conciliada"       // duplicado resuelto manualmente
  | "aprobada"         // lista para incorporar
  | "incorporada"      // insertada en la tabla destino
  | "rechazada";       // descartada con motivo

// ── Estado global de una sesión de importación ────────────────────────────────

export type EstadoImportacion =
  | "iniciada"
  | "raw_completo"
  | "staging_completo"
  | "normalizacion_completa"
  | "dedup_completo"
  | "revision_pendiente"    // hay filas en cuarentena o duplicados
  | "aprobada"
  | "incorporando"
  | "completada"
  | "error"
  | "cancelada";

// ── Fila raw del Excel ─────────────────────────────────────────────────────────

export interface FilaRaw {
  filaNumero: number;          // número de fila en el Excel (1-based, incluye cabecera)
  datos: Record<string, unknown>; // columnas tal como llegan del Excel
  archivoS3Key: string;
  uploadId: string;
}

// ── Fila staging — campos tipados según el esquema Alephoo ───────────────────

export interface FilaAlephooStaging {
  uploadId: string;
  filaNumero: number;
  archivoS3Key: string;

  // Paciente
  apellido?: string;
  nombre?: string;
  tipoDoc?: string;
  nroDoc?: string;
  fechaNacimiento?: string;   // ISO 8601 o como vino
  sexo?: string;
  email?: string;
  telefono?: string;

  // Cobertura
  obraSocial?: string;
  nroAfiliado?: string;

  // Turno / episodio (datos opcionales de la exportación Alephoo)
  fechaTurno?: string;
  horaTurno?: string;
  profesional?: string;
  especialidad?: string;
  sede?: string;
  motivoConsulta?: string;
  diagnosticoCie10?: string;
  diagnosticoDescripcion?: string;

  // Campos extra sin mapeo — se guardan como JSON para no perder información
  camposExtra?: Record<string, unknown>;

  // Estado del pipeline
  estado: EstadoFilaPipeline;
  erroresValidacion: string[];
  advertenciasValidacion: string[];
}

// ── Fila normalizada ──────────────────────────────────────────────────────────

export interface FilaNormalizada extends FilaAlephooStaging {
  // Sobre los staging: campos normalizados
  nroDocNorm?: string;        // DNI sin puntos ni espacios, solo dígitos
  fechaNacimientoIso?: string; // YYYY-MM-DD
  fechaTurnoIso?: string;     // YYYY-MM-DD
  horaTurnoNorm?: string;     // HH:MM
  apellidoNorm?: string;      // uppercase sin tildes para comparación
  nombreNorm?: string;
  sexoNorm?: "masculino" | "femenino" | "indeterminado" | "desconocido";
  emailNorm?: string;         // lowercase
  telefonoNorm?: string;      // solo dígitos + código de país
}

// ── Resultado de deduplicación ────────────────────────────────────────────────

export interface ResultadoDedup {
  filaNumero: number;
  uploadId: string;
  tipo: "sin_duplicado" | "duplicado_exacto" | "duplicado_probable";
  pacienteExistenteId?: string;      // UUID del paciente en la DB si existe
  filaOriginalNumero?: number;       // número de la fila original en el mismo batch
  scoreSimiaridad?: number;          // 0-1, para duplicados probables
  camposCoindicen?: string[];        // qué campos coinciden
  motivo?: string;
}

// ── Fila en cuarentena ────────────────────────────────────────────────────────

export interface FilaCuarentena extends FilaNormalizada {
  motivoCuarentena: string[];
  revisadaPor?: string;          // ID del usuario que revisó
  resolucion?: "aprobar" | "rechazar" | "corregir";
  correccionesAplicadas?: Partial<FilaNormalizada>;
}

// ── Resultado de incorporación ────────────────────────────────────────────────

export interface ResultadoIncorporacion {
  filaNumero: number;
  pacienteId?: string;             // UUID asignado en la DB
  episodioId?: string;
  accion: "creado" | "actualizado" | "vinculado" | "omitido";
  motivo?: string;
}

// ── Sesión de importación ─────────────────────────────────────────────────────

export interface SesionImportacion {
  uploadId: string;
  archivoS3Key: string;
  archivoNombre: string;
  archivoSha256: string;
  estado: EstadoImportacion;
  totalFilas: number;
  filasRaw: number;
  filasStaging: number;
  filasNormalizadas: number;
  filasDuplicadoExacto: number;
  filasDuplicadoProbable: number;
  filasCuarentena: number;
  filasAprobadas: number;
  filasIncorporadas: number;
  filasRechazadas: number;
  iniciadaEn: Date;
  completadaEn?: Date;
  iniciadaPor: string;          // ID de usuario
  aprobadaPor?: string;
  errores: string[];
}

// ── Opciones del pipeline ─────────────────────────────────────────────────────

export interface OpcionesPipeline {
  uploadId: string;
  archivoS3Key: string;
  archivoNombre: string;
  archivoSha256: string;
  iniciadaPor: string;

  /** Umbral de similitud para marcar como duplicado probable (0-1, default 0.85) */
  umbralDuplicadoProbable?: number;

  /** Si true, omite las filas con duplicado exacto en lugar de rechazarlas */
  omitirDuplicadosExactos?: boolean;

  /** Si true, las filas con duplicado probable van directo a cuarentena */
  cuarentenaDuplicadosProbables?: boolean;

  /** Logger inyectable (facilita tests) */
  log?: (msg: string, data?: Record<string, unknown>) => void;

  /**
   * Si true, omite la etapa de incorporación (stage 5).
   * Útil para staging-only: ver estadísticas y reportes sin escribir en la DB.
   * El worker Alephoo usa esto cuando no se pasa --approve.
   */
  skipIncorporacion?: boolean;
}
