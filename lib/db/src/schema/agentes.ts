import { integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ── Tipos de agente disponibles ───────────────────────────────────────────
// recepcion  → Agente de Recepción  (rol: recepcionista, admin)
// medico     → Agente del Médico    (rol: medico)
// admin      → Agente Administrativo (rol: admin)
// paciente   → Agente del Paciente  (rol: paciente — portal/app)

export const agenteSesiones = pgTable("agente_sesiones", {
  id: serial("id").primaryKey(),

  // Identidad del agente y del usuario que inicia la sesión
  agenteTipo: text("agente_tipo").notNull(),     // "recepcion" | "medico" | "admin" | "paciente"
  usuarioId: integer("usuario_id"),              // FK lógica a users.id (nullable: portal público)
  usuarioRol: text("usuario_rol"),               // "admin" | "recepcionista" | "medico" | "paciente"
  usuarioNombre: text("usuario_nombre"),

  // Contexto opcional inyectado en el sistema
  pacienteId: integer("paciente_id"),            // Set cuando el médico abre HC de un paciente
  profesionalId: integer("profesional_id"),      // Set cuando recepción filtra por profesional
  contextoExtra: jsonb("contexto_extra"),        // Datos adicionales (fecha, sede, etc.)

  // Estado
  estado: text("estado").notNull().default("activa"),  // "activa" | "cerrada"
  titulo: text("titulo"),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const agenteMensajes = pgTable("agente_mensajes", {
  id: serial("id").primaryKey(),
  sesionId: integer("sesion_id")
    .notNull()
    .references(() => agenteSesiones.id, { onDelete: "cascade" }),
  rol: text("rol").notNull(),       // "user" | "assistant" | "system"
  contenido: text("contenido").notNull(),
  metadata: jsonb("metadata"),      // tokens usados, latencia, contexto inyectado, etc.
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ── Zod schemas ───────────────────────────────────────────────────────────

export const insertAgenteSesionSchema = createInsertSchema(agenteSesiones).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertAgenteMensajeSchema = createInsertSchema(agenteMensajes).omit({
  id: true,
  createdAt: true,
});

export type AgenteSesion = typeof agenteSesiones.$inferSelect;
export type InsertAgenteSesion = z.infer<typeof insertAgenteSesionSchema>;
export type AgenteMensaje = typeof agenteMensajes.$inferSelect;
export type InsertAgenteMensaje = z.infer<typeof insertAgenteMensajeSchema>;
