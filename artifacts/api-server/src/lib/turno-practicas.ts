import { eq, asc, inArray, sql } from "drizzle-orm";
import { db, turnoPracticasTable, turnosTable, klinicosPracticas } from "@workspace/db";
import { logger } from "./logger";

// ── Varias prácticas (estudios) por turno ──────────────────────────────────
// turno_practicas guarda el conjunto completo; turnos.klinicos_practica_id
// queda como práctica principal (la primera) por compatibilidad con los
// circuitos existentes (PACS, checklist, ficha de recepción).

/** Migración idempotente de arranque: crea la tabla si falta. */
export async function migrarTurnoPracticas(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS turno_practicas (
      id serial PRIMARY KEY,
      turno_id integer NOT NULL,
      klinicos_practica_id integer NOT NULL,
      CONSTRAINT turno_practicas_turno_practica_uidx UNIQUE (turno_id, klinicos_practica_id)
    )
  `);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS turno_practicas_turno_idx ON turno_practicas (turno_id)`,
  );
  logger.info("migraciones: turno_practicas lista");
}

/** Filtra los ids que existen en el catálogo (conserva el orden recibido). */
export async function filtrarPracticasValidas(practicaIds: number[]): Promise<number[]> {
  const unicos = [...new Set(practicaIds.filter((n) => Number.isInteger(n) && n > 0))];
  if (unicos.length === 0) return [];
  const filas = await db
    .select({ id: klinicosPracticas.id })
    .from(klinicosPracticas)
    .where(inArray(klinicosPracticas.id, unicos));
  const existentes = new Set(filas.map((f) => f.id));
  return unicos.filter((id) => existentes.has(id));
}

/**
 * Reemplaza el conjunto de prácticas de un turno y sincroniza la práctica
 * principal (primera del listado) en turnos.klinicos_practica_id, todo en
 * una única transacción. Ids inexistentes del catálogo se descartan.
 */
export async function guardarPracticasDeTurno(
  turnoId: number,
  practicaIds: number[],
): Promise<number[]> {
  const validos = await filtrarPracticasValidas(practicaIds);
  await db.transaction(async (tx) => {
    await tx.delete(turnoPracticasTable).where(eq(turnoPracticasTable.turnoId, turnoId));
    if (validos.length > 0) {
      await tx.insert(turnoPracticasTable).values(
        validos.map((klinicosPracticaId) => ({ turnoId, klinicosPracticaId })),
      );
    }
    await tx
      .update(turnosTable)
      .set({ klinicosPracticaId: validos[0] ?? null })
      .where(eq(turnosTable.id, turnoId));
  });
  return validos;
}

/** Prácticas del turno (id, nombre, códigos) en orden de carga. */
export async function practicasDeTurno(
  turnoId: number,
): Promise<Array<{ id: number; nombre: string; codigos: string[] }>> {
  const filas = await db
    .select({
      id: klinicosPracticas.id,
      nombre: klinicosPracticas.nombre,
      codigos: klinicosPracticas.codigos,
    })
    .from(turnoPracticasTable)
    .innerJoin(klinicosPracticas, eq(klinicosPracticas.id, turnoPracticasTable.klinicosPracticaId))
    .where(eq(turnoPracticasTable.turnoId, turnoId))
    .orderBy(asc(turnoPracticasTable.id));
  return filas.map((f) => ({ id: f.id, nombre: f.nombre, codigos: f.codigos ?? [] }));
}
