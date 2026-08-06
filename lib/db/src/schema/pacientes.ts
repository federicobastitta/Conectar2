import { pgTable, text, serial, timestamp, boolean, uniqueIndex, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const pacientesTable = pgTable(
  "pacientes",
  {
    id: serial("id").primaryKey(),
    // MPI — identificador inmutable generado al crear
    numeroHc: text("numero_hc").unique(),
    // Datos personales
    nombre: text("nombre").notNull(),
    apellido: text("apellido").notNull(),
    dni: text("dni"),
    fechaNacimiento: text("fecha_nacimiento"),
    sexo: text("sexo"),
    estadoCivil: text("estado_civil"),
    nacionalidad: text("nacionalidad"),
    grupoSanguineo: text("grupo_sanguineo"),
    // Contacto
    email: text("email"),
    telefono: text("telefono"),
    telefonoAlternativo: text("telefono_alternativo"),
    // Domicilio
    direccion: text("direccion"),
    localidad: text("localidad"),
    provincia: text("provincia"),
    codigoPostal: text("codigo_postal"),
    // Cobertura médica
    cobertura: text("cobertura"),
    planCobertura: text("plan_cobertura"),
    nroAfiliado: text("nro_afiliado"),
    // Notas
    observaciones: text("observaciones"),
    observacionesAdmin: text("observaciones_admin"),
    // Baja lógica
    activo: boolean("activo").notNull().default(true),
    // Auditoría
    creadoPor: integer("creado_por"),
    modificadoPor: integer("modificado_por"),
    modificadoEn: timestamp("modificado_en", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    dniUnico: uniqueIndex("pacientes_dni_unique").on(t.dni),
  }),
);

export const insertPacienteSchema = createInsertSchema(pacientesTable).omit({
  id: true,
  numeroHc: true,
  createdAt: true,
  modificadoEn: true,
});
export type InsertPaciente = z.infer<typeof insertPacienteSchema>;
export type Paciente = typeof pacientesTable.$inferSelect;
