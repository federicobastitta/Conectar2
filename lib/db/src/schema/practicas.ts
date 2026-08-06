import { pgTable, text, serial, integer, date, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const practicasTable = pgTable("practicas", {
  id: serial("id").primaryKey(),
  pacienteId: integer("paciente_id").notNull(),
  profesionalId: integer("profesional_id").notNull(),
  encounterId: integer("encounter_id"),
  turnoId: integer("turno_id"),
  nombre: text("nombre").notNull(),
  estado: text("estado").notNull().default("indicada"),
  fecha: date("fecha", { mode: "string" }).notNull(),
  notas: text("notas"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertPracticaSchema = createInsertSchema(practicasTable).omit({ id: true, createdAt: true });
export type InsertPractica = z.infer<typeof insertPracticaSchema>;
export type Practica = typeof practicasTable.$inferSelect;
