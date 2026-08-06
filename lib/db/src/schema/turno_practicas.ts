import { pgTable, serial, integer, index, uniqueIndex } from "drizzle-orm/pg-core";

// ── Prácticas (estudios) de un turno ───────────────────────────────────────
// Un turno puede llevar VARIOS estudios en la misma visita (ej: eco abdomen +
// eco tiroides). Cada fila vincula el turno con una práctica del catálogo
// klinicos_practicas. La columna turnos.klinicos_practica_id se mantiene como
// práctica "principal" (la primera) por compatibilidad con los circuitos
// existentes (PACS, checklist, ficha de recepción).
export const turnoPracticasTable = pgTable("turno_practicas", {
  id: serial("id").primaryKey(),
  turnoId: integer("turno_id").notNull(),
  klinicosPracticaId: integer("klinicos_practica_id").notNull(),
}, (t) => [
  uniqueIndex("turno_practicas_turno_practica_uidx").on(t.turnoId, t.klinicosPracticaId),
  index("turno_practicas_turno_idx").on(t.turnoId),
]);

export type TurnoPractica = typeof turnoPracticasTable.$inferSelect;
