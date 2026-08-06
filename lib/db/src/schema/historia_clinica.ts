import { pgTable, text, serial, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const evolucionesTable = pgTable("evoluciones", {
  id: serial("id").primaryKey(),
  pacienteId: integer("paciente_id").notNull(),
  turnoId: integer("turno_id"),
  profesionalId: integer("profesional_id"),
  texto: text("texto").notNull(),
  motivoConsulta: text("motivo_consulta"),
  exploracion: text("exploracion"),
  plan: text("plan"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertEvolucionSchema = createInsertSchema(evolucionesTable).omit({ id: true, createdAt: true });
export type InsertEvolucion = z.infer<typeof insertEvolucionSchema>;
export type Evolucion = typeof evolucionesTable.$inferSelect;

export const recetasTable = pgTable("recetas", {
  id: serial("id").primaryKey(),
  pacienteId: integer("paciente_id").notNull(),
  profesionalId: integer("profesional_id"),
  medicamentos: text("medicamentos").notNull(),
  indicaciones: text("indicaciones"),
  diagnostico: text("diagnostico"),
  vigencia: text("vigencia"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertRecetaSchema = createInsertSchema(recetasTable).omit({ id: true, createdAt: true });
export type InsertReceta = z.infer<typeof insertRecetaSchema>;
export type Receta = typeof recetasTable.$inferSelect;

export const diagnosticosTable = pgTable("diagnosticos", {
  id: serial("id").primaryKey(),
  pacienteId: integer("paciente_id").notNull(),
  profesionalId: integer("profesional_id"),
  cie10: text("cie10"),
  descripcion: text("descripcion").notNull(),
  tipo: text("tipo").notNull().default("presuntivo"),
  activo: boolean("activo").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertDiagnosticoSchema = createInsertSchema(diagnosticosTable).omit({ id: true, createdAt: true });
export type InsertDiagnostico = z.infer<typeof insertDiagnosticoSchema>;
export type Diagnostico = typeof diagnosticosTable.$inferSelect;

export const adjuntosTable = pgTable("adjuntos", {
  id: serial("id").primaryKey(),
  pacienteId: integer("paciente_id").notNull(),
  nombre: text("nombre").notNull(),
  tipo: text("tipo").notNull().default("otro"),
  descripcion: text("descripcion"),
  url: text("url"),
  fuente: text("fuente"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertAdjuntoSchema = createInsertSchema(adjuntosTable).omit({ id: true, createdAt: true });
export type InsertAdjunto = z.infer<typeof insertAdjuntoSchema>;
export type Adjunto = typeof adjuntosTable.$inferSelect;
