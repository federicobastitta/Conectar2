import {
  pgTable, uuid, text, boolean, timestamp, smallint, pgEnum,
} from "drizzle-orm/pg-core";
import { origenDatoEnum } from "./pacientes.js";

export const rolClinicoEnum = pgEnum("rol_clinico", [
  "super_admin", "admin_clinica", "medico", "medico_jefe", "kinesiologo",
  "enfermero", "tecnico", "farmaceutico", "recepcionista", "auditor", "paciente", "sistema",
]);

export const accionPermisoEnum = pgEnum("accion_permiso", [
  "leer", "crear", "editar", "firmar", "publicar", "anular", "exportar", "administrar", "auditar",
]);

export const estadoTokenKlinicosEnum = pgEnum("estado_token_klinicos", [
  "pendiente", "validado", "expirado", "rechazado", "anulado",
]);

// ── Usuarios ─────────────────────────────────────────────────────────────────

export const usuarios = pgTable("usuarios", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull(),
  nombre: text("nombre").notNull(),
  apellido: text("apellido").notNull(),
  rol: rolClinicoEnum("rol").notNull().default("recepcionista"),
  passwordHash: text("password_hash"),
  mfaSecretCifrado: text("mfa_secret_cifrado"),
  ultimoLogin: timestamp("ultimo_login", { withTimezone: true }),
  intentosFallidos: smallint("intentos_fallidos").notNull().default(0),
  bloqueadoHasta: timestamp("bloqueado_hasta", { withTimezone: true }),
  matricula: text("matricula"),
  especialidad: text("especialidad"),
  cuit: text("cuit"),
  pacienteId: uuid("paciente_id"),
  activo: boolean("activo").notNull().default(true),
  emailVerificado: boolean("email_verificado").notNull().default(false),
  aceptaToc: boolean("acepta_toc").notNull().default(false),
  aceptaTocEn: timestamp("acepta_toc_en", { withTimezone: true }),
  origen: origenDatoEnum("origen").notNull().default("interfaz_clinica"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  createdBy: uuid("created_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  updatedBy: uuid("updated_by"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: uuid("deleted_by"),
});

export type Usuario = typeof usuarios.$inferSelect;
export type NuevoUsuario = typeof usuarios.$inferInsert;

// ── Permisos de rol ───────────────────────────────────────────────────────────

export const permisosRol = pgTable("permisos_rol", {
  id: uuid("id").defaultRandom().primaryKey(),
  rol: rolClinicoEnum("rol").notNull(),
  recurso: text("recurso").notNull(),
  accion: accionPermisoEnum("accion").notNull(),
  condicion: text("condicion"),
  activo: boolean("activo").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  createdBy: uuid("created_by"),
});

export type PermisoRol = typeof permisosRol.$inferSelect;

// ── Sesiones ──────────────────────────────────────────────────────────────────

export const sesiones = pgTable("sesiones", {
  id: uuid("id").defaultRandom().primaryKey(),
  usuarioId: uuid("usuario_id").notNull(),
  tokenHash: text("token_hash").notNull(),
  expiraEn: timestamp("expira_en", { withTimezone: true }).notNull(),
  ipOrigen: text("ip_origen"),
  userAgent: text("user_agent"),
  activa: boolean("activa").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  revocadaEn: timestamp("revocada_en", { withTimezone: true }),
  revocadaMotivo: text("revocada_motivo"),
});

export type Sesion = typeof sesiones.$inferSelect;

// ── Tokens Klinicos ───────────────────────────────────────────────────────────

export const tokensKlinicos = pgTable("tokens_klinicos", {
  id: uuid("id").defaultRandom().primaryKey(),
  pacienteId: uuid("paciente_id").notNull(),
  ordenId: uuid("orden_id"),
  tokenHash: text("token_hash").notNull(),
  estado: estadoTokenKlinicosEnum("estado").notNull().default("pendiente"),
  klinicosEstablecimiento: text("klinicos_establecimiento"),
  klinicosSector: text("klinicos_sector"),
  klinicosTurnoId: text("klinicos_turno_id"),
  validadoEn: timestamp("validado_en", { withTimezone: true }),
  validadoPorSistema: text("validado_por_sistema"),
  respuestaKlinicos: text("respuesta_klinicos"),  // JSONB como texto
  expiraEn: timestamp("expira_en", { withTimezone: true }).notNull(),
  anuladoEn: timestamp("anulado_en", { withTimezone: true }),
  anuladoPor: uuid("anulado_por"),
  motivoAnulacion: text("motivo_anulacion"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  createdBy: uuid("created_by"),
});

export type TokenKlinicos = typeof tokensKlinicos.$inferSelect;
