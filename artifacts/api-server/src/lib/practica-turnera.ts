import { eq } from "drizzle-orm";
import { db, turneraPracticasTable, klinicosPracticas } from "@workspace/db";

// ── Tipo de estudio de una agenda ─────────────────────────────────────────
// Las agendas tienen códigos del nomenclador asociados (turnera_practicas,
// una fila por código). Una práctica del catálogo Klinicos "corresponde" a
// la agenda cuando TODOS sus códigos (distintos) están entre los de la
// agenda. El Robot necesita el klinicos_practicas.id para resolver el
// practice_code exacto de la planilla Conectar (nunca se inventan códigos).

/**
 * Devuelve el id de la práctica del catálogo si la agenda corresponde a UNA
 * sola práctica; null si no tiene códigos asociados o si corresponde a varias
 * (en ese caso el cliente debe elegir el tipo de estudio explícitamente).
 */
export async function practicaUnicaDeTurnera(turneraId: number): Promise<number | null> {
  const filas = await db
    .select({ codigo: turneraPracticasTable.codigo })
    .from(turneraPracticasTable)
    .where(eq(turneraPracticasTable.turneraId, turneraId));
  const codigosAgenda = new Set(filas.map((f) => f.codigo.trim()).filter(Boolean));
  if (codigosAgenda.size === 0) return null;

  const practicas = await db
    .select({ id: klinicosPracticas.id, codigos: klinicosPracticas.codigos })
    .from(klinicosPracticas)
    .where(eq(klinicosPracticas.activo, true));
  const matches = practicas.filter((p) => {
    const cods = (p.codigos ?? []).map((c) => c.trim()).filter(Boolean);
    return cods.length > 0 && cods.every((c) => codigosAgenda.has(c));
  });
  return matches.length === 1 ? matches[0].id : null;
}
