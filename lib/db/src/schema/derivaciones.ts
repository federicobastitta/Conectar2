import { pgTable, text, serial, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Sprint 4 — Motor de derivación directa y resolución clínica.
// Catálogo configurable de servicios + solicitudes con máquina de estados
// + notificaciones salientes auditadas.

export const serviciosTable = pgTable("servicios", {
  id: serial("id").primaryKey(),
  nombre: text("nombre").notNull(),
  slug: text("slug").notNull().unique(),
  especialidadId: integer("especialidad_id"),
  requiereAutorizacion: boolean("requiere_autorizacion").notNull().default(false),
  activo: boolean("activo").notNull().default(true),
  orden: integer("orden").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertServicioSchema = createInsertSchema(serviciosTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertServicio = z.infer<typeof insertServicioSchema>;
export type Servicio = typeof serviciosTable.$inferSelect;

// Estados: indicada | pre_reservada | pendiente_validacion | validada |
// programada | en_sala | realizada | informada | cancelada | rechazada
export const solicitudesTable = pgTable("solicitudes", {
  id: serial("id").primaryKey(),
  patientId: integer("patient_id").notNull(),
  professionalId: integer("professional_id").notNull(),
  servicioId: integer("servicio_id").notNull(),
  tipo: text("tipo").notNull().default("estudio"),
  encounterId: integer("encounter_id"),
  studyOrderId: integer("study_order_id"),
  referralId: integer("referral_id"),
  turnoId: integer("turno_id"),
  estado: text("estado").notNull().default("indicada"),
  estadoUpdatedAt: timestamp("estado_updated_at", { withTimezone: true }).notNull().defaultNow(),
  detalle: text("detalle"),
  prioridad: text("prioridad").notNull().default("normal"),
  cobertura: text("cobertura"),
  token: text("token"),
  tokenValidado: boolean("token_validado").notNull().default(false),
  coberturaValidada: boolean("cobertura_validada").notNull().default(false),
  validadoPor: integer("validado_por"),
  observaciones: text("observaciones"),
  createdBy: integer("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertSolicitudSchema = createInsertSchema(solicitudesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertSolicitud = z.infer<typeof insertSolicitudSchema>;
export type Solicitud = typeof solicitudesTable.$inferSelect;

// Notificaciones salientes al paciente (WhatsApp y futuros canales), auditadas.
// estadoEntrega: pendiente | enviada | fallida | simulada
export const notificacionesSalientesTable = pgTable("notificaciones_salientes", {
  id: serial("id").primaryKey(),
  patientId: integer("patient_id").notNull(),
  solicitudId: integer("solicitud_id"),
  canal: text("canal").notNull().default("whatsapp"),
  evento: text("evento").notNull(),
  destinatario: text("destinatario"),
  contenido: text("contenido").notNull(),
  estadoEntrega: text("estado_entrega").notNull().default("pendiente"),
  errorDetalle: text("error_detalle"),
  // Nombre del template de Whaticket a usar cuando se conecte el proveedor real
  template: text("template"),
  // Agrupa envíos masivos (ej: cancelación de turnera) en un lote auditable
  loteId: text("lote_id"),
  // Turno asociado al aviso (cancelaciones masivas)
  turnoId: integer("turno_id"),
  usuarioOrigenId: integer("usuario_origen_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertNotificacionSalienteSchema = createInsertSchema(notificacionesSalientesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertNotificacionSaliente = z.infer<typeof insertNotificacionSalienteSchema>;
export type NotificacionSaliente = typeof notificacionesSalientesTable.$inferSelect;
