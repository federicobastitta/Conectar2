import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const informesTable = pgTable("informes", {
  id: serial("id").primaryKey(),
  turnoId: integer("turno_id").notNull(),
  pacienteId: integer("paciente_id").notNull(),
  profesionalId: integer("profesional_id"),
  texto: text("texto").notNull().default(""),
  firma: text("firma"),
  firmadoEn: timestamp("firmado_en", { withTimezone: true }),
  estado: text("estado").notNull().default("borrador"),
  pacsStudyId: text("pacs_study_id"),
  pacsViewerUrl: text("pacs_viewer_url"),
  observaciones: text("observaciones"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Plantillas de informe personales de cada médico (no compartidas).
export const informePlantillasTable = pgTable("informe_plantillas", {
  id: serial("id").primaryKey(),
  profesionalId: integer("profesional_id").notNull(),
  nombre: text("nombre").notNull(),
  texto: text("texto").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type InformePlantilla = typeof informePlantillasTable.$inferSelect;

export const insertInformeSchema = createInsertSchema(informesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertInforme = z.infer<typeof insertInformeSchema>;
export type Informe = typeof informesTable.$inferSelect;
