import { pgTable, text, serial, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const especialidadesTable = pgTable("especialidades", {
  id: serial("id").primaryKey(),
  nombre: text("nombre").notNull(),
  codigo: text("codigo"),
  descripcion: text("descripcion"),
  color: text("color"),
  // Integración PACS por worklist: los turnos de esta especialidad se
  // publican como ítems de worklist en el PACS (configurable, no hardcodeado).
  enviaAlPacs: boolean("envia_al_pacs").notNull().default(false),
  // Modalidad DICOM que se informa en el ítem de worklist (ej: US, MR, CR, MG, ECG)
  modalidadDicom: text("modalidad_dicom"),
});

export const insertEspecialidadSchema = createInsertSchema(especialidadesTable).omit({ id: true });
export type InsertEspecialidad = z.infer<typeof insertEspecialidadSchema>;
export type Especialidad = typeof especialidadesTable.$inferSelect;
