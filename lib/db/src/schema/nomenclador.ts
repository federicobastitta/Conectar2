import { pgTable, text, serial, integer, timestamp, doublePrecision, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { obrasSocialesTable } from "./obras_sociales";

// Nomenclador valorizado de prácticas por obra social.
// Se carga desde archivos Excel (xls/xlsx) y lo consume CAJA para tomar
// códigos y valores al registrar movimientos.
export const nomencladorPracticasTable = pgTable(
  "nomenclador_practicas",
  {
    id: serial("id").primaryKey(),
    obraSocialId: integer("obra_social_id")
      .notNull()
      .references(() => obrasSocialesTable.id, { onDelete: "cascade" }),
    codigo: text("codigo").notNull(),
    descripcion: text("descripcion").notNull(),
    capitulo: text("capitulo"),
    honorarios: doublePrecision("honorarios"),
    gastos: doublePrecision("gastos"),
    valorTotal: doublePrecision("valor_total").notNull(),
    origen: text("origen"), // archivo/hoja de donde salió
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("nomenclador_os_codigo_unique").on(t.obraSocialId, t.codigo)],
);

export const insertNomencladorPracticaSchema = createInsertSchema(nomencladorPracticasTable).omit({
  id: true,
  createdAt: true,
});
export type InsertNomencladorPractica = z.infer<typeof insertNomencladorPracticaSchema>;
export type NomencladorPractica = typeof nomencladorPracticasTable.$inferSelect;
