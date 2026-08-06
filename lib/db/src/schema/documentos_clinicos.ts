import { pgTable, text, serial, integer, boolean, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Sprint 2 — Resolución clínica: derivaciones, certificados, órdenes de
// estudios y documentos PDF. Todo asociado a paciente, profesional,
// consulta (encounter) y usuario creador.
// Nota: las recetas usan la tabla `prescriptions` existente de la HCE
// (lib/db/src/schema/hce.ts), extendida con los campos del spec.

export const referralsTable = pgTable("referrals", {
  id: serial("id").primaryKey(),
  patientId: integer("patient_id").notNull(),
  professionalId: integer("professional_id").notNull(),
  consultationId: integer("consultation_id"),
  targetSpecialty: text("target_specialty").notNull(),
  targetProfessionalId: integer("target_professional_id"),
  reason: text("reason").notNull(),
  priority: text("priority").notNull().default("normal"),
  observations: text("observations"),
  // Trazabilidad de la derivación interna: pedido → agendado → realizado → informado (o anulada)
  status: text("status").notNull().default("pedido"),
  createdBy: integer("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const certificatesTable = pgTable("certificates", {
  id: serial("id").primaryKey(),
  patientId: integer("patient_id").notNull(),
  professionalId: integer("professional_id").notNull(),
  consultationId: integer("consultation_id"),
  certificateType: text("certificate_type").notNull().default("reposo"),
  diagnosis: text("diagnosis"),
  restDays: integer("rest_days"),
  content: text("content").notNull(),
  observations: text("observations"),
  // Código único para verificar la autenticidad del certificado vía QR.
  verificationCode: text("verification_code"),
  // Estado documental: valido | revocado | reemplazado. El certificado emitido
  // es inmutable: los errores se corrigen revocando o emitiendo un reemplazo.
  estado: text("estado").notNull().default("valido"),
  motivoRevocacion: text("motivo_revocacion"),
  revocadoEn: timestamp("revocado_en", { withTimezone: true }),
  revocadoPorId: integer("revocado_por_id"),
  // Historial documental: qué certificado lo reemplazó / a cuál reemplaza.
  reemplazadoPorId: integer("reemplazado_por_id"),
  reemplazaAId: integer("reemplaza_a_id"),
  // PDF ORIGINAL inmutable (base64), generado al emitir: la descarga pública
  // sirve siempre este binario, nunca uno regenerado con datos vivos.
  pdfOriginal: text("pdf_original"),
  createdBy: integer("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Trazabilidad de la verificación pública de certificados: cada consulta por
// QR, link o código manual queda registrada (solo para auditoría interna).
export const certificadoVerificacionesTable = pgTable("certificado_verificaciones", {
  id: serial("id").primaryKey(),
  certificateId: integer("certificate_id").notNull(),
  fecha: timestamp("fecha", { withTimezone: true }).notNull().defaultNow(),
  estadoAlMomento: text("estado_al_momento").notNull(),
  via: text("via").notNull().default("qr_link"), // qr_link | codigo_manual
  ip: text("ip"),
  userAgent: text("user_agent"),
});

export const studyOrdersTable = pgTable(
  "study_orders",
  {
  id: serial("id").primaryKey(),
  patientId: integer("patient_id").notNull(),
  professionalId: integer("professional_id").notNull(),
  consultationId: integer("consultation_id"),
  turnoId: integer("turno_id"), // si la orden se generó automáticamente al recepcionar un turno de práctica
  studyType: text("study_type").notNull().default("laboratorio"),
  studyName: text("study_name").notNull(),
  // Asistente de órdenes: práctica del catálogo elegida + contraste + snapshot
  // de códigos de facturación (IOMA) listos para el robot.
  practicaId: integer("practica_id"),
  contraste: boolean("contraste").notNull().default(false),
  billingCodes: text("billing_codes"),
  clinicalJustification: text("clinical_justification"),
  // Resumen de historia clínica para la planilla de alta complejidad (IOMA);
  // lo redacta el médico o el asistente IA a partir de la HCE.
  resumenHc: text("resumen_hc"),
  priority: text("priority").notNull().default("normal"),
  preparationRequired: text("preparation_required"),
  observations: text("observations"),
  // Circuito de gestión: solicitado → pendiente_programacion → programado →
  // en_realizacion → realizado → informado → entregado (+ anulada)
  status: text("status").notNull().default("solicitado"),
  // ── Workspace PACS v1.0 (detrás de PACS_WORKSPACE_ENABLED) ──
  // CM-1: accession por secuencia propia C{AA}-{12 dígitos}; único e inmutable.
  accessionNumber: text("accession_number"),
  modality: text("modality"),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  observacionesTecnico: text("observaciones_tecnico"),
  statusUpdatedAt: timestamp("status_updated_at", { withTimezone: true }),
  // ── Aprobación y firma de la planilla IOMA (alta complejidad) ──
  // El PDF solo estampa firma y sello cuando firma_estado = 'firmada'; ese
  // estado sale EXCLUSIVAMENTE de la base (nunca de un flag del frontend).
  // pendiente_firma → firmada | rechazada | reemplazada (nueva versión)
  // Token de verificación pública (QR/link impreso en la orden de baja
  // complejidad); se genera perezosamente al armar el primer PDF.
  verificationCode: text("verification_code"),
  firmaEstado: text("firma_estado").notNull().default("pendiente_firma"),
  firmaVersion: integer("firma_version").notNull().default(1),
  firmadoEn: timestamp("firmado_en", { withTimezone: true }),
  firmadoPor: integer("firmado_por"), // usuario (médico prescriptor) que aprobó
  firmaHash: text("firma_hash"), // sha256 del contenido de la orden al firmar
  firmaMotivoRechazo: text("firma_motivo_rechazo"),
  reemplazaOrdenId: integer("reemplaza_orden_id"), // versión anterior corregida
  createdBy: integer("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Una sola orden automática por turno (idempotencia real a nivel DB)
    uniqueIndex("study_orders_turno_id_unico").on(t.turnoId).where(sql`${t.turnoId} IS NOT NULL`),
    // CM-1: accession único (parcial, solo cuando existe)
    uniqueIndex("study_orders_accession_unico").on(t.accessionNumber).where(sql`${t.accessionNumber} IS NOT NULL`),
  ],
);

// Registro INMUTABLE de eventos de firma de planillas IOMA: solo se insertan
// filas (nunca update/delete). Cada evento guarda documento, versión, hash del
// contenido, usuario y profesional actuantes y estado anterior/nuevo.
export const studyOrdersFirmaLogTable = pgTable("study_orders_firma_log", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").notNull(),
  version: integer("version").notNull(),
  accion: text("accion").notNull(), // firmada | rechazada | nueva_version
  estadoAnterior: text("estado_anterior").notNull(),
  estadoNuevo: text("estado_nuevo").notNull(),
  hash: text("hash"),
  usuarioId: integer("usuario_id").notNull(),
  profesionalId: integer("profesional_id").notNull(),
  detalle: text("detalle"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const pdfDocumentsTable = pgTable("pdf_documents", {
  id: serial("id").primaryKey(),
  patientId: integer("patient_id").notNull(),
  professionalId: integer("professional_id").notNull(),
  consultationId: integer("consultation_id"),
  sourceType: text("source_type").notNull(),
  sourceId: integer("source_id").notNull(),
  pdfContentReference: text("pdf_content_reference").notNull(),
  createdBy: integer("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertReferralSchema = createInsertSchema(referralsTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertCertificateSchema = createInsertSchema(certificatesTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertStudyOrderSchema = createInsertSchema(studyOrdersTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertPdfDocumentSchema = createInsertSchema(pdfDocumentsTable).omit({ id: true, createdAt: true });

export type Referral = typeof referralsTable.$inferSelect;
export type Certificate = typeof certificatesTable.$inferSelect;
export type StudyOrder = typeof studyOrdersTable.$inferSelect;
export type PdfDocument = typeof pdfDocumentsTable.$inferSelect;
export type InsertReferral = z.infer<typeof insertReferralSchema>;
export type InsertCertificate = z.infer<typeof insertCertificateSchema>;
export type InsertStudyOrder = z.infer<typeof insertStudyOrderSchema>;
export type InsertPdfDocument = z.infer<typeof insertPdfDocumentSchema>;
