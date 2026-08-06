import {
  pgTable,
  text,
  serial,
  integer,
  boolean,
  timestamp,
  jsonb,
  date,
  unique,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Espejo local de los estudios/informes cuya fuente de verdad es Pulso (el
// sistema de gestión de informes médicos de la clínica). Conectar NO edita
// estos estudios: solo refleja su estado para poder mostrarlos en la ficha del
// paciente y mantenerse al día con lo que pasa en la clínica. El contenido del
// informe (hallazgos/conclusión) y el PDF firmado se consultan EN VIVO a Pulso
// on-demand; acá guardamos solo la metadata y el resumen del informe.
export const pulsoEstudiosTable = pgTable(
  "pulso_estudios",
  {
    id: serial("id").primaryKey(),
    // Id de dominio de Pulso (UUID). Clave de deduplicación.
    pulsoId: text("pulso_id").notNull(),
    // Paciente de Conectar vinculado (si se pudo matchear por id externo o DNI).
    patientId: integer("patient_id"),
    // DNI reportado por Pulso: permite mostrar el estudio en la ficha aun si el
    // paciente todavía no está vinculado.
    pacienteDni: text("paciente_dni"),
    idLegible: text("id_legible"),
    modalidad: text("modalidad"),
    tipoEstudio: text("tipo_estudio"),
    sedeNombre: text("sede_nombre"),
    estado: text("estado"),
    fechaEstudio: date("fecha_estudio", { mode: "string" }),
    medicoAsignado: text("medico_asignado"),
    medicoDerivante: text("medico_derivante"),
    tieneInforme: boolean("tiene_informe").notNull().default(false),
    informePulsoId: text("informe_pulso_id"),
    informeFirmado: boolean("informe_firmado").notNull().default(false),
    informeFirmadoAt: timestamp("informe_firmado_at", { withTimezone: true }),
    observaciones: text("observaciones"),
    // Payload crudo del estudio de Pulso (para flexibilidad / debugging).
    raw: jsonb("raw"),
    createdAtPulso: timestamp("created_at_pulso", { withTimezone: true }),
    updatedAtPulso: timestamp("updated_at_pulso", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("pulso_estudios_pulso_id_unique").on(t.pulsoId),
    index("pulso_estudios_patient_idx").on(t.patientId),
    index("pulso_estudios_dni_idx").on(t.pacienteDni),
  ],
);

export const insertPulsoEstudioSchema = createInsertSchema(pulsoEstudiosTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertPulsoEstudio = z.infer<typeof insertPulsoEstudioSchema>;
export type PulsoEstudio = typeof pulsoEstudiosTable.$inferSelect;
