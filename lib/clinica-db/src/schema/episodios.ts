import {
  pgTable, uuid, text, boolean, timestamp, jsonb, pgEnum, index,
} from "drizzle-orm/pg-core";
import { origenDatoEnum } from "./pacientes.js";

export const estadoEpisodioEnum = pgEnum("estado_episodio", [
  "programado", "en_espera", "en_atencion", "cerrado", "derivado", "cancelado", "ausente",
]);

export const modalidadAtencionEnum = pgEnum("modalidad_atencion", [
  "presencial", "videollamada", "telefonica", "domiciliaria", "guardia", "teleconsulta",
]);

export const estadoOrdenEnum = pgEnum("estado_orden", [
  "borrador", "emitida", "enviada_pacs", "realizada", "informada", "entregada", "anulada", "vencida",
]);

export const tipoOrdenEnum = pgEnum("tipo_orden", [
  "estudio_imagen", "laboratorio", "interconsulta", "procedimiento", "internacion", "kinesiologia", "otra",
]);

// ── Episodios ────────────────────────────────────────────────────────────────

export const episodios = pgTable("episodios", {
  id: uuid("id").defaultRandom().primaryKey(),
  pacienteId: uuid("paciente_id").notNull(),
  motivoConsulta: text("motivo_consulta").notNull(),
  descripcion: text("descripcion"),
  estado: estadoEpisodioEnum("estado").notNull().default("programado"),
  turnoIdExterno: text("turno_id_externo"),
  turnoFecha: timestamp("turno_fecha", { withTimezone: true }),
  modalidad: modalidadAtencionEnum("modalidad").notNull().default("presencial"),
  profesionalId: uuid("profesional_id"),
  sedeNombre: text("sede_nombre"),
  especialidad: text("especialidad"),
  coberturaId: uuid("cobertura_id"),
  coberturaSnapshot: jsonb("cobertura_snapshot"),
  cerradoEn: timestamp("cerrado_en", { withTimezone: true }),
  cerradoPor: uuid("cerrado_por"),
  motivoCierre: text("motivo_cierre"),
  origen: origenDatoEnum("origen").notNull().default("interfaz_clinica"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  createdBy: uuid("created_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  updatedBy: uuid("updated_by"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: uuid("deleted_by"),
});

export type Episodio = typeof episodios.$inferSelect;
export type NuevoEpisodio = typeof episodios.$inferInsert;

// ── Transiciones de episodio ─────────────────────────────────────────────────

export const episodioTransiciones = pgTable("episodio_transiciones", {
  id: uuid("id").defaultRandom().primaryKey(),
  episodioId: uuid("episodio_id").notNull(),
  estadoAnterior: estadoEpisodioEnum("estado_anterior"),
  estadoNuevo: estadoEpisodioEnum("estado_nuevo").notNull(),
  motivo: text("motivo"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  createdBy: uuid("created_by"),
});

export type EpisodioTransicion = typeof episodioTransiciones.$inferSelect;
