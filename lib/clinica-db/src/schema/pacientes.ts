import {
  pgTable,
  uuid,
  text,
  boolean,
  date,
  timestamp,
  pgEnum,
  char,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const sexoBiologicoEnum = pgEnum("sexo_biologico", [
  "masculino",
  "femenino",
  "indeterminado",
  "desconocido",
]);

export const tipoDocumentoEnum = pgEnum("tipo_documento", [
  "dni",
  "pasaporte",
  "cedula_extranjera",
  "cuil",
  "cuit",
  "otro",
]);

export const origenDatoEnum = pgEnum("origen_dato", [
  "interfaz_clinica",
  "importacion_alephoo",
  "integracion_phirit",
  "integracion_pulso",
  "integracion_klinicos",
  "migracion_inicial",
  "api_externa",
  "sistema",
]);

export const sistemaExternoEnum = pgEnum("sistema_externo", [
  "alephoo",
  "pulso",
  "klinicos",
  "phirit",
  "pacs",
  "obra_social",
  "ministerio_salud",
  "anses",
  "otro",
]);

export const planModalidadEnum = pgEnum("plan_modalidad", [
  "prepaga",
  "obra_social",
  "particular",
  "estatal",
  "otro",
]);

// ── Pacientes ────────────────────────────────────────────────────────────────

export const pacientes = pgTable(
  "pacientes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    apellido: text("apellido").notNull(),
    nombre: text("nombre").notNull(),
    apellido2: text("apellido_2"),
    fechaNacimiento: date("fecha_nacimiento"),
    sexo: sexoBiologicoEnum("sexo").notNull().default("desconocido"),
    generoPreferido: text("genero_preferido"),
    tipoDoc: tipoDocumentoEnum("tipo_doc").notNull().default("dni"),
    nroDoc: text("nro_doc"),
    cuil: text("cuil"),
    nroHistoria: text("nro_historia"),
    emailPrincipal: text("email_principal"),
    telefonoPrincipal: text("telefono_principal"),
    paisResidencia: char("pais_residencia", { length: 2 }).notNull().default("AR"),
    activo: boolean("activo").notNull().default(true),
    fallecido: boolean("fallecido").notNull().default(false),
    fechaFallecimiento: date("fecha_fallecimiento"),
    origen: origenDatoEnum("origen").notNull().default("interfaz_clinica"),
    origenIdExterno: text("origen_id_externo"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    updatedBy: uuid("updated_by"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: uuid("deleted_by"),
    notasInternas: text("notas_internas"),
  },
  (t) => [
    index("idx_pacientes_nro_doc").on(t.nroDoc),
    uniqueIndex("idx_pacientes_cuil_unico").on(t.cuil),
  ],
);

export type Paciente = typeof pacientes.$inferSelect;
export type NuevoPaciente = typeof pacientes.$inferInsert;

// ── Identificadores externos ────────────────────────────────────────────────

export const identificadoresExternos = pgTable("identificadores_externos", {
  id: uuid("id").defaultRandom().primaryKey(),
  pacienteId: uuid("paciente_id").notNull(),
  sistema: sistemaExternoEnum("sistema").notNull(),
  sistemaNombre: text("sistema_nombre"),
  identificador: text("identificador").notNull(),
  activo: boolean("activo").notNull().default(true),
  verificado: boolean("verificado").notNull().default(false),
  verificadoEn: timestamp("verificado_en", { withTimezone: true }),
  notas: text("notas"),
  origen: origenDatoEnum("origen").notNull().default("interfaz_clinica"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  createdBy: uuid("created_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  updatedBy: uuid("updated_by"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: uuid("deleted_by"),
});

export type IdentificadorExterno = typeof identificadoresExternos.$inferSelect;

// ── Coberturas ───────────────────────────────────────────────────────────────

export const coberturas = pgTable("coberturas", {
  id: uuid("id").defaultRandom().primaryKey(),
  pacienteId: uuid("paciente_id").notNull(),
  modalidad: planModalidadEnum("modalidad").notNull().default("particular"),
  financiador: text("financiador").notNull(),
  codigoRnos: text("codigo_rnos"),
  plan: text("plan"),
  nroAfiliado: text("nro_afiliado"),
  nroCredencial: text("nro_credencial"),
  vigenteDesde: date("vigente_desde"),
  vigenteHasta: date("vigente_hasta"),
  esPrincipal: boolean("es_principal").notNull().default(false),
  activa: boolean("activa").notNull().default(true),
  origen: origenDatoEnum("origen").notNull().default("interfaz_clinica"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  createdBy: uuid("created_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  updatedBy: uuid("updated_by"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: uuid("deleted_by"),
});

export type Cobertura = typeof coberturas.$inferSelect;
export type NuevaCobertura = typeof coberturas.$inferInsert;

// ── Contactos ────────────────────────────────────────────────────────────────

export const tipoContactoEnum = pgEnum("tipo_contacto", [
  "telefono_celular",
  "telefono_fijo",
  "email",
  "whatsapp",
  "domicilio",
  "contacto_emergencia",
  "otro",
]);

export const contactos = pgTable("contactos", {
  id: uuid("id").defaultRandom().primaryKey(),
  pacienteId: uuid("paciente_id").notNull(),
  tipo: tipoContactoEnum("tipo").notNull(),
  valor: text("valor").notNull(),
  descripcion: text("descripcion"),
  esPrincipal: boolean("es_principal").notNull().default(false),
  verificado: boolean("verificado").notNull().default(false),
  aceptaNotif: boolean("acepta_notif").notNull().default(false),
  calle: text("calle"),
  numero: text("numero"),
  piso: text("piso"),
  depto: text("depto"),
  localidad: text("localidad"),
  provincia: text("provincia"),
  codigoPostal: text("codigo_postal"),
  pais: char("pais", { length: 2 }).default("AR"),
  origen: origenDatoEnum("origen").notNull().default("interfaz_clinica"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  createdBy: uuid("created_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  updatedBy: uuid("updated_by"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: uuid("deleted_by"),
});

export type Contacto = typeof contactos.$inferSelect;
