import {
  pgTable, uuid, text, boolean, timestamp, integer, bigint, smallint, pgEnum,
} from "drizzle-orm/pg-core";
import { origenDatoEnum } from "./pacientes.js";

export const estadoDocumentoEnum = pgEnum("estado_documento", [
  "pendiente_subida", "disponible", "procesando", "error_procesamiento", "archivado", "eliminado_s3",
]);

export const nivelAccesoEnum = pgEnum("nivel_acceso", [
  "medico_tratante", "equipo_clinico", "administracion", "paciente", "publico",
]);

export const documentos = pgTable("documentos", {
  id: uuid("id").defaultRandom().primaryKey(),
  pacienteId: uuid("paciente_id").notNull(),
  episodioId: uuid("episodio_id"),
  evolucionId: uuid("evolucion_id"),
  estudioId: uuid("estudio_id"),
  ordenId: uuid("orden_id"),
  tipo: text("tipo").notNull(),
  titulo: text("titulo").notNull(),
  descripcion: text("descripcion"),
  estado: estadoDocumentoEnum("estado").notNull().default("pendiente_subida"),
  nivelAcceso: nivelAccesoEnum("nivel_acceso").notNull().default("equipo_clinico"),
  visiblePaciente: boolean("visible_paciente").notNull().default(false),
  s3Bucket: text("s3_bucket"),
  s3Key: text("s3_key"),
  s3VersionId: text("s3_version_id"),
  contentType: text("content_type"),
  nombreArchivo: text("nombre_archivo").notNull(),
  tamanoBytes: bigint("tamano_bytes", { mode: "number" }),
  paginas: smallint("paginas"),
  sha256: text("sha256").notNull(),
  md5: text("md5"),
  version: integer("version").notNull().default(1),
  versionAnteriorId: uuid("version_anterior_id"),
  esVersionActiva: boolean("es_version_activa").notNull().default(true),
  textoExtraido: text("texto_extraido"),
  procesadoEn: timestamp("procesado_en", { withTimezone: true }),
  errorProcesamiento: text("error_procesamiento"),
  fechaDocumento: text("fecha_documento"),
  fechaExpiracion: text("fecha_expiracion"),
  subidoPor: uuid("subido_por"),
  subidoPorNombre: text("subido_por_nombre"),
  origen: origenDatoEnum("origen").notNull().default("interfaz_clinica"),
  origenSistema: text("origen_sistema"),
  origenIdExterno: text("origen_id_externo"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  createdBy: uuid("created_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  updatedBy: uuid("updated_by"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: uuid("deleted_by"),
  motivoEliminacion: text("motivo_eliminacion"),
});

export type Documento = typeof documentos.$inferSelect;
export type NuevoDocumento = typeof documentos.$inferInsert;

export const documentosAccesos = pgTable("documentos_accesos", {
  id: uuid("id").defaultRandom().primaryKey(),
  documentoId: uuid("documento_id").notNull(),
  usuarioId: uuid("usuario_id"),
  usuarioNombre: text("usuario_nombre"),
  tipoAcceso: text("tipo_acceso").notNull(),
  ipOrigen: text("ip_origen"),
  userAgent: text("user_agent"),
  accessedAt: timestamp("accessed_at", { withTimezone: true }).defaultNow().notNull(),
});

export type DocumentoAcceso = typeof documentosAccesos.$inferSelect;
