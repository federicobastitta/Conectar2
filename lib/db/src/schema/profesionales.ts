import { pgTable, text, serial, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const profesionalesTable = pgTable("profesionales", {
  id: serial("id").primaryKey(),
  nombre: text("nombre").notNull(),
  apellido: text("apellido"),
  matricula: text("matricula"),
  matriculaEspecialista: text("matricula_especialista"),
  tipoDocumento: text("tipo_documento").default("DNI"),
  documento: text("documento"),
  email: text("email"),
  telefono: text("telefono"),
  telefonoMovil: text("telefono_movil"),
  tipoProfesional: text("tipo_profesional"),
  // sedeId y consultorioId quedan como sede/consultorio "principal" del profesional
  // pero NO se usan para deduplicar — el consultorio real está en cada agenda (turnera).
  sedeId: integer("sede_id"),
  consultorioId: integer("consultorio_id"),
  // Sala de espera (con pantalla TV) desde donde se anuncia su llamado.
  salaLlamadoId: integer("sala_llamado_id"),
  especialidadId: integer("especialidad_id"),
  activo: boolean("activo").notNull().default(true),
  // Si atiende pacientes de guardia: ve en su agenda los turnos de las
  // turneras de guardia (grupales) de su especialidad.
  atiendeGuardia: boolean("atiende_guardia").notNull().default(true),
  // Casillero que el médico prende desde su consultorio cuando está atendiendo
  // y acepta pacientes sin turno (demanda espontánea). Recepción ve el listado.
  aceptaDemandaEspontanea: boolean("acepta_demanda_espontanea").notNull().default(false),
  // Nombre normalizado para deduplicación idempotente en importaciones
  // Formato: "apellido nombre" todo minúsculas sin acentos, espacios simples
  nombreNormalizado: text("nombre_normalizado"),
  // Vínculo con Klinicos: usuario espejo del profesional en el portal
  klinicosUsuario: text("klinicos_usuario"), // login nombre.apellido en Klinicos
  klinicosEspecialidad: text("klinicos_especialidad"), // especialidad tal como figura en Klinicos
  klinicosSector: text("klinicos_sector"), // sector habitual en Klinicos
  // Firma hológrafa escaneada (data URL PNG/JPEG) — se estampa en órdenes
  // médicas, recetas, derivaciones, certificados e informes.
  firmaImagen: text("firma_imagen"),
  // Caligrafía manuscrita elegida por el médico (0-4). Se elige UNA sola vez
  // y no se puede cambiar; null = todavía no eligió (se usa id % 5).
  caligrafia: integer("caligrafia"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertProfesionalSchema = createInsertSchema(profesionalesTable).omit({ id: true, createdAt: true });
export type InsertProfesional = z.infer<typeof insertProfesionalSchema>;
export type Profesional = typeof profesionalesTable.$inferSelect;
