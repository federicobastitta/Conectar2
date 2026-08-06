import { pgTable, pgSequence, serial, integer, text, timestamp, uniqueIndex, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ── Workspace PACS (contrato DiagnosticPACS–Conectar v1.0, CONGELADO) ───────
// Todo detrás de PACS_WORKSPACE_ENABLED=false. Los informes se redactan,
// firman, versionan y publican EN CONECTAR; el PACS aporta visor, estudios
// e imágenes clave. Relación: order_id + accession_number + StudyInstanceUID.

// Secuencia para accession numbers CM-1: C{AA}-{12 dígitos}, opaca, inmutable.
export const pacsAccessionSeq = pgSequence("pacs_accession_seq", {
  startWith: 1,
  increment: 1,
  minValue: 1,
  maxValue: 999999999999,
  cache: 1,
});

// ── Informe PACS por orden ───────────────────────────────────────────────────
// Un registro por study_order. Almacena el borrador activo, el estado del
// informe (borrador/firmado/publicado) y el estado operativo de la orden en
// el workflow PACS (AGENDADO → RECEPCIONADO → PENDIENTE_DE_INFORME →
// INFORMADO, con desvío AUSENTE).
export const pacsInformesTable = pgTable(
  "pacs_informes",
  {
    id: serial("id").primaryKey(),
    studyOrderId: integer("study_order_id").notNull(),
    estadoOperativo: text("estado_operativo").notNull().default("AGENDADO"),
    informeEstado: text("informe_estado").notNull().default("borrador"),
    borradorActual: text("borrador_actual").notNull().default(""),
    createdBy: integer("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("pacs_informes_order_unico").on(t.studyOrderId)],
);

// Un informe puede abarcar N estudios DICOM (informe ↔ N StudyInstanceUID).
export const informeEstudiosTable = pgTable(
  "informe_estudios",
  {
    id: serial("id").primaryKey(),
    informeId: integer("informe_id").notNull(),
    studyOrderId: integer("study_order_id"),
    studyInstanceUid: text("study_instance_uid").notNull(),
    accessionNumber: text("accession_number"),
    modality: text("modality"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("informe_estudios_unico").on(t.informeId, t.studyInstanceUid)],
);

// Versionado inmutable del informe: cada firma/publicación crea una versión.
export const informeVersionesTable = pgTable(
  "informe_versiones",
  {
    id: serial("id").primaryKey(),
    informeId: integer("informe_id").notNull(),
    version: integer("version").notNull(),
    texto: text("texto").notNull(),
    firmadoPor: integer("firmado_por"),
    firmadoPorNombre: text("firmado_por_nombre"),
    firmadoEn: timestamp("firmado_en", { withTimezone: true }),
    publicadoEn: timestamp("publicado_en", { withTimezone: true }),
    pdfReferencia: text("pdf_referencia"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("informe_versiones_unico").on(t.informeId, t.version)],
);

// Evidencia congelada al firmar (CM-4, Opción A): copia inmutable de la
// miniatura en el almacenamiento de Conectar + snapshot de identificación.
export const informeImagenesClavePacsTable = pgTable(
  "informe_imagenes_clave_pacs",
  {
    id: serial("id").primaryKey(),
    informeId: integer("informe_id").notNull(),
    informeVersionId: integer("informe_version_id"),
    keyImageId: text("key_image_id").notNull(),
    studyInstanceUid: text("study_instance_uid").notNull(),
    seriesInstanceUid: text("series_instance_uid").notNull(),
    sopInstanceUid: text("sop_instance_uid").notNull(),
    frameNumber: integer("frame_number"),
    titulo: text("titulo"),
    comentarioMedico: text("comentario_medico"),
    orden: integer("orden").notNull().default(1),
    thumbnailSha256: text("thumbnail_sha256"),
    copiaReferencia: text("copia_referencia"),
    congeladaEn: timestamp("congelada_en", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("informe_imagenes_clave_pacs_unico").on(t.informeId, t.keyImageId)],
);

// ── Worklist PACS (escenario v3) ────────────────────────────────────────────
// Conectar publica al PACS los estudios a realizar. Un ítem por turno cuya
// especialidad tiene envia_al_pacs. estado_envio es el estado de la cola de
// publicación (pendiente → publicado; error con reintentos; cancelado).
// worklist_status es el estado funcional del ítem según el contrato:
// scheduled | arrived | ready_to_report | cancelled.
export const pacsWorklistItemsTable = pgTable(
  "pacs_worklist_items",
  {
    id: serial("id").primaryKey(),
    // Ítems por turno (agenda) o por orden de estudio (copia de la orden al PACS)
    turnoId: integer("turno_id"),
    ordenEstudioId: integer("orden_estudio_id"),
    // order_id que Conectar le pasa al PACS (id del turno u "SO-{id}" de la orden)
    orderId: text("order_id").notNull(),
    accessionNumber: text("accession_number").notNull(),
    modalidad: text("modalidad"),
    descripcionEstudio: text("descripcion_estudio"),
    worklistStatus: text("worklist_status").notNull().default("scheduled"),
    // pendiente | publicado | error | cancelado
    estadoEnvio: text("estado_envio").notNull().default("pendiente"),
    intentos: integer("intentos").notNull().default(0),
    ultimoError: text("ultimo_error"),
    publicadoEn: timestamp("publicado_en", { withTimezone: true }),
    proximoIntentoEn: timestamp("proximo_intento_en", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("pacs_worklist_turno_unico").on(t.turnoId),
    uniqueIndex("pacs_worklist_orden_unico").on(t.ordenEstudioId).where(sql`${t.ordenEstudioId} IS NOT NULL`),
    uniqueIndex("pacs_worklist_accession_unico").on(t.accessionNumber),
  ],
);

// Informe FIRMADO EN EL PACS y archivado en Conectar (v3): copia inmutable
// del PDF firmado (en el object storage privado) + metadatos de la firma.
export const pacsInformesFirmadosTable = pgTable(
  "pacs_informes_firmados",
  {
    id: serial("id").primaryKey(),
    turnoId: integer("turno_id").notNull(),
    worklistItemId: integer("worklist_item_id"),
    orderId: text("order_id").notNull(),
    accessionNumber: text("accession_number"),
    studyInstanceUid: text("study_instance_uid"),
    version: integer("version").notNull().default(1),
    texto: text("texto"),
    firmadoPorNombre: text("firmado_por_nombre"),
    firmadoEn: timestamp("firmado_en", { withTimezone: true }),
    pdfPath: text("pdf_path").notNull(),
    pdfSha256: text("pdf_sha256").notNull(),
    recibidoEn: timestamp("recibido_en", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("pacs_informes_firmados_unico").on(t.turnoId, t.version)],
);

// Webhook entrante /api/pacs/webhook/eventos: idempotencia por event_id.
export const pacsEventosTable = pgTable(
  "pacs_eventos",
  {
    id: serial("id").primaryKey(),
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    orderId: text("order_id"),
    studyInstanceUid: text("study_instance_uid"),
    ocurridoEn: timestamp("ocurrido_en", { withTimezone: true }),
    payload: jsonb("payload"),
    procesadoEn: timestamp("procesado_en", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("pacs_eventos_event_id_unico").on(t.eventId)],
);

// ── Estudios DICOM vinculados a pacientes ───────────────────────────────────
// El PACS ya no permite listar estudios por DNI (cerró el API legado), así
// que Conectar mantiene el vínculo paciente ↔ StudyInstanceUID localmente.
// Se puebla a mano (staff pega el UID), y a futuro por webhook/listado v1.
export const pacsEstudiosVinculadosTable = pgTable(
  "pacs_estudios_vinculados",
  {
    id: serial("id").primaryKey(),
    pacienteId: integer("paciente_id").notNull(),
    studyInstanceUid: text("study_instance_uid").notNull(),
    modalidad: text("modalidad"),
    descripcion: text("descripcion"),
    estado: text("estado"),
    vinculadoPor: integer("vinculado_por"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("pacs_estudios_vinculados_uid_unico").on(t.studyInstanceUid)],
);

export const insertPacsInformeSchema = createInsertSchema(pacsInformesTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertInformeEstudioSchema = createInsertSchema(informeEstudiosTable).omit({ id: true, createdAt: true });
export const insertInformeVersionSchema = createInsertSchema(informeVersionesTable).omit({ id: true, createdAt: true });
export const insertInformeImagenClavePacsSchema = createInsertSchema(informeImagenesClavePacsTable).omit({ id: true, createdAt: true });
export const insertPacsEventoSchema = createInsertSchema(pacsEventosTable).omit({ id: true, createdAt: true });
export const insertPacsWorklistItemSchema = createInsertSchema(pacsWorklistItemsTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertPacsInformeFirmadoSchema = createInsertSchema(pacsInformesFirmadosTable).omit({ id: true, createdAt: true });
export const insertPacsEstudioVinculadoSchema = createInsertSchema(pacsEstudiosVinculadosTable).omit({ id: true, createdAt: true });

export type PacsInforme = typeof pacsInformesTable.$inferSelect;
export type InformeEstudio = typeof informeEstudiosTable.$inferSelect;
export type InformeVersion = typeof informeVersionesTable.$inferSelect;
export type InformeImagenClavePacs = typeof informeImagenesClavePacsTable.$inferSelect;
export type PacsEvento = typeof pacsEventosTable.$inferSelect;
export type PacsEstudioVinculado = typeof pacsEstudiosVinculadosTable.$inferSelect;
export type InsertPacsInforme = z.infer<typeof insertPacsInformeSchema>;
export type InsertInformeEstudio = z.infer<typeof insertInformeEstudioSchema>;
export type InsertInformeVersion = z.infer<typeof insertInformeVersionSchema>;
export type InsertInformeImagenClavePacs = z.infer<typeof insertInformeImagenClavePacsSchema>;
export type InsertPacsEvento = z.infer<typeof insertPacsEventoSchema>;
export type PacsWorklistItem = typeof pacsWorklistItemsTable.$inferSelect;
export type InsertPacsWorklistItem = z.infer<typeof insertPacsWorklistItemSchema>;
export type PacsInformeFirmado = typeof pacsInformesFirmadosTable.$inferSelect;
export type InsertPacsInformeFirmado = z.infer<typeof insertPacsInformeFirmadoSchema>;
