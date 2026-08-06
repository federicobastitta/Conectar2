import { pgTable, text, serial, integer, real, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const clinicalRecordsTable = pgTable("clinical_records", {
  id: serial("id").primaryKey(),
  patientId: integer("patient_id").notNull().unique(),
  bloodType: text("blood_type"),
  allergies: text("allergies"),
  chronicDiseases: text("chronic_diseases"),
  surgeries: text("surgeries"),
  familyHistory: text("family_history"),
  currentMedications: text("current_medications"),
  vaccinations: text("vaccinations"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertClinicalRecordSchema = createInsertSchema(clinicalRecordsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertClinicalRecord = z.infer<typeof insertClinicalRecordSchema>;
export type ClinicalRecord = typeof clinicalRecordsTable.$inferSelect;

export const encountersTable = pgTable("encounters", {
  id: serial("id").primaryKey(),
  clinicalRecordId: integer("clinical_record_id").notNull(),
  professionalId: integer("professional_id"),
  specialty: text("specialty"),
  encounterDate: timestamp("encounter_date", { withTimezone: true }).notNull().defaultNow(),
  encounterType: text("encounter_type").notNull().default("consulta"),
  chiefComplaint: text("chief_complaint"),
  anamnesis: text("anamnesis"),
  physicalExam: text("physical_exam"),
  assessment: text("assessment"),
  plan: text("plan"),
  diagnosis: text("diagnosis"),
  cie10: text("cie10"),
  status: text("status").notNull().default("finalizada"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Última corrección de la evolución por su autor (null = nunca editada)
  updatedAt: timestamp("updated_at", { withTimezone: true }),
});

export const insertEncounterSchema = createInsertSchema(encountersTable).omit({
  id: true,
  createdAt: true,
  encounterDate: true,
});
export type InsertEncounter = z.infer<typeof insertEncounterSchema>;
export type Encounter = typeof encountersTable.$inferSelect;

export const vitalSignsTable = pgTable("vital_signs", {
  id: serial("id").primaryKey(),
  encounterId: integer("encounter_id").notNull(),
  bloodPressure: text("blood_pressure"),
  heartRate: integer("heart_rate"),
  respiratoryRate: integer("respiratory_rate"),
  temperature: real("temperature"),
  oxygenSaturation: real("oxygen_saturation"),
  weight: real("weight"),
  height: real("height"),
  bmi: real("bmi"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertVitalSignsSchema = createInsertSchema(vitalSignsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertVitalSigns = z.infer<typeof insertVitalSignsSchema>;
export type VitalSigns = typeof vitalSignsTable.$inferSelect;

export const prescriptionsTable = pgTable("prescriptions", {
  id: serial("id").primaryKey(),
  // Nullable: recetas emitidas desde Consultorio Digital pueden no estar ligadas a un encuentro
  encounterId: integer("encounter_id"),
  medication: text("medication").notNull(),
  dosage: text("dosage"),
  frequency: text("frequency"),
  duration: text("duration"),
  instructions: text("instructions"),
  // Sprint 2 — Resolución clínica (nullable para compatibilidad con filas HCE previas)
  patientId: integer("patient_id"),
  professionalId: integer("professional_id"),
  consultationId: integer("consultation_id"),
  type: text("type").default("medicamento"),
  status: text("status").default("emitida"),
  // Token de verificación pública (QR "Validación de veracidad"); se genera
  // perezosamente al armar el primer PDF de la receta.
  verificationCode: text("verification_code"),
  createdBy: integer("created_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertPrescriptionSchema = createInsertSchema(prescriptionsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertPrescription = z.infer<typeof insertPrescriptionSchema>;
export type Prescription = typeof prescriptionsTable.$inferSelect;

export const encounterAttachmentsTable = pgTable("encounter_attachments", {
  id: serial("id").primaryKey(),
  encounterId: integer("encounter_id").notNull(),
  type: text("type").notNull().default("estudio"),
  fileUrl: text("file_url"),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertEncounterAttachmentSchema = createInsertSchema(encounterAttachmentsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertEncounterAttachment = z.infer<typeof insertEncounterAttachmentSchema>;
export type EncounterAttachment = typeof encounterAttachmentsTable.$inferSelect;
