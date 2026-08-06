import {
  pgTable, uuid, text, boolean, timestamp, integer, pgEnum, smallint,
} from "drizzle-orm/pg-core";
import { origenDatoEnum } from "./pacientes.js";

export const estadoEvolucionEnum = pgEnum("estado_evolucion", [
  "borrador", "firmada", "anulada",
]);

export const estadoInformeEnum = pgEnum("estado_informe", [
  "borrador", "firmado", "publicado", "corregido", "anulado",
]);

// ── Evoluciones clínicas ─────────────────────────────────────────────────────

export const evoluciones = pgTable("evoluciones", {
  id: uuid("id").defaultRandom().primaryKey(),
  episodioId: uuid("episodio_id").notNull(),
  pacienteId: uuid("paciente_id").notNull(),
  version: integer("version").notNull().default(1),
  versionAnteriorId: uuid("version_anterior_id"),
  esVersionActiva: boolean("es_version_activa").notNull().default(true),
  subjetivo: text("subjetivo"),
  objetivo: text("objetivo"),
  evaluacion: text("evaluacion"),
  plan: text("plan"),
  textoLibre: text("texto_libre"),
  estado: estadoEvolucionEnum("estado").notNull().default("borrador"),
  firmadaPor: uuid("firmada_por"),
  firmadaPorNombre: text("firmada_por_nombre"),
  firmadaPorMatricula: text("firmada_por_matricula"),
  firmadaEn: timestamp("firmada_en", { withTimezone: true }),
  firmaHash: text("firma_hash"),
  anuladaPor: uuid("anulada_por"),
  anuladaEn: timestamp("anulada_en", { withTimezone: true }),
  motivoAnulacion: text("motivo_anulacion"),
  corrigeA: uuid("corrige_a"),
  motivoCorreccion: text("motivo_correccion"),
  profesionalId: uuid("profesional_id"),
  especialidad: text("especialidad"),
  origen: origenDatoEnum("origen").notNull().default("interfaz_clinica"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  createdBy: uuid("created_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  updatedBy: uuid("updated_by"),
});

export type Evolucion = typeof evoluciones.$inferSelect;
export type NuevaEvolucion = typeof evoluciones.$inferInsert;

// ── Diagnósticos ─────────────────────────────────────────────────────────────

export const tipoDiagnosticoEnum = pgEnum("tipo_diagnostico", [
  "principal", "secundario", "presuntivo", "definitivo", "descartado", "diferencial",
]);

export const diagnosticos = pgTable("diagnosticos", {
  id: uuid("id").defaultRandom().primaryKey(),
  pacienteId: uuid("paciente_id").notNull(),
  episodioId: uuid("episodio_id"),
  evolucionId: uuid("evolucion_id"),
  codigoCie10: text("codigo_cie10").notNull(),
  descripcion: text("descripcion").notNull(),
  tipo: tipoDiagnosticoEnum("tipo").notNull().default("presuntivo"),
  activo: boolean("activo").notNull().default(true),
  fechaInicio: text("fecha_inicio"),
  fechaResolucion: text("fecha_resolucion"),
  notas: text("notas"),
  origen: origenDatoEnum("origen").notNull().default("interfaz_clinica"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  createdBy: uuid("created_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  updatedBy: uuid("updated_by"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: uuid("deleted_by"),
});

export type Diagnostico = typeof diagnosticos.$inferSelect;

// ── Signos vitales ────────────────────────────────────────────────────────────

export const signosVitales = pgTable("signos_vitales", {
  id: uuid("id").defaultRandom().primaryKey(),
  pacienteId: uuid("paciente_id").notNull(),
  episodioId: uuid("episodio_id"),
  evolucionId: uuid("evolucion_id"),
  paSistolica: smallint("pa_sistolica"),
  paDiastolica: smallint("pa_diastolica"),
  fc: smallint("fc"),
  fr: smallint("fr"),
  temperatura: text("temperatura"),  // NUMERIC como texto para simplicidad en ORM
  spo2: smallint("spo2"),
  pesoKg: text("peso_kg"),
  tallaCm: text("talla_cm"),
  imc: text("imc"),
  glucemiaMgDl: text("glucemia_mg_dl"),
  hgt: text("hgt"),
  medicionesExtra: text("mediciones_extra"),  // JSON como texto
  tomadoEn: timestamp("tomado_en", { withTimezone: true }).defaultNow().notNull(),
  tomadoPor: uuid("tomado_por"),
  tomadoPorNombre: text("tomado_por_nombre"),
  dispositivo: text("dispositivo"),
  observaciones: text("observaciones"),
  origen: origenDatoEnum("origen").notNull().default("interfaz_clinica"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  createdBy: uuid("created_by").notNull(),
});

export type SignoVital = typeof signosVitales.$inferSelect;
export type NuevoSignoVital = typeof signosVitales.$inferInsert;
