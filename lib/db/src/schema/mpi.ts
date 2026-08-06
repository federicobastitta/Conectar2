import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ── Contacto de emergencia ────────────────────────────────────────────────
export const contactosEmergenciaTable = pgTable("contactos_emergencia_paciente", {
  id: serial("id").primaryKey(),
  pacienteId: integer("paciente_id").notNull(),
  nombre: text("nombre").notNull(),
  apellido: text("apellido"),
  relacion: text("relacion"),
  telefono: text("telefono").notNull(),
  telefonoAlternativo: text("telefono_alternativo"),
  observaciones: text("observaciones"),
  creadoPor: integer("creado_por"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertContactoEmergenciaSchema = createInsertSchema(contactosEmergenciaTable).omit({
  id: true,
  createdAt: true,
});
export type InsertContactoEmergencia = z.infer<typeof insertContactoEmergenciaSchema>;
export type ContactoEmergencia = typeof contactosEmergenciaTable.$inferSelect;

// ── Documentos adjuntos del paciente ─────────────────────────────────────
export const documentosPacienteTable = pgTable("documentos_paciente", {
  id: serial("id").primaryKey(),
  pacienteId: integer("paciente_id").notNull(),
  nombre: text("nombre").notNull(),
  tipo: text("tipo"),
  descripcion: text("descripcion"),
  url: text("url"),
  fuente: text("fuente"),
  creadoPor: integer("creado_por"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertDocumentoPacienteSchema = createInsertSchema(documentosPacienteTable).omit({
  id: true,
  createdAt: true,
});
export type InsertDocumentoPaciente = z.infer<typeof insertDocumentoPacienteSchema>;
export type DocumentoPaciente = typeof documentosPacienteTable.$inferSelect;

// ── Grupo familiar (vínculos) ──────────────────────────────────────────────
export const grupoFamiliarTable = pgTable("grupo_familiar_vinculo", {
  id: serial("id").primaryKey(),
  pacienteId: integer("paciente_id").notNull(),
  nombre: text("nombre").notNull(),
  apellido: text("apellido"),
  relacion: text("relacion").notNull(),
  dni: text("dni"),
  fechaNacimiento: text("fecha_nacimiento"),
  telefono: text("telefono"),
  pacienteVinculadoId: integer("paciente_vinculado_id"),
  observaciones: text("observaciones"),
  creadoPor: integer("creado_por"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertGrupoFamiliarSchema = createInsertSchema(grupoFamiliarTable).omit({
  id: true,
  createdAt: true,
});
export type InsertGrupoFamiliar = z.infer<typeof insertGrupoFamiliarSchema>;
export type GrupoFamiliarVinculo = typeof grupoFamiliarTable.$inferSelect;

// ── Historial de cambios (auditoría de pacientes) ─────────────────────────
export const auditoriaPacientesTable = pgTable("auditoria_pacientes", {
  id: serial("id").primaryKey(),
  pacienteId: integer("paciente_id").notNull(),
  usuarioId: integer("usuario_id").notNull(),
  usuarioEmail: text("usuario_email").notNull(),
  accion: text("accion").notNull(),
  camposModificados: text("campos_modificados"),
  valorAnterior: text("valor_anterior"),
  valorNuevo: text("valor_nuevo"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type AuditoriaPaciente = typeof auditoriaPacientesTable.$inferSelect;
