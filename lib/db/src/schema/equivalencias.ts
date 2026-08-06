import { pgTable, text, serial, integer, timestamp, doublePrecision, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { obrasSocialesTable } from "./obras_sociales";

// Equivalencias por código y obra social: cuánto nos paga la obra social
// (si difiere del nomenclador) y cuánto le pagamos al profesional
// (monto fijo en pesos o porcentaje del cobro).
export const equivalenciasTable = pgTable(
  "nomenclador_equivalencias",
  {
    id: serial("id").primaryKey(),
    obraSocialId: integer("obra_social_id")
      .notNull()
      .references(() => obrasSocialesTable.id, { onDelete: "cascade" }),
    codigo: text("codigo").notNull(),
    descripcion: text("descripcion"),
    // Override de lo que nos paga la obra social; si es null se usa el valor del nomenclador
    cobroObraSocial: doublePrecision("cobro_obra_social"),
    // 'fijo' (pesos) o 'porcentaje' (% del cobro)
    pagoTipo: text("pago_tipo").notNull(),
    pagoValor: doublePrecision("pago_valor").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("equivalencias_os_codigo_unique").on(t.obraSocialId, t.codigo)],
);

export const insertEquivalenciaSchema = createInsertSchema(equivalenciasTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertEquivalencia = z.infer<typeof insertEquivalenciaSchema>;
export type Equivalencia = typeof equivalenciasTable.$inferSelect;
