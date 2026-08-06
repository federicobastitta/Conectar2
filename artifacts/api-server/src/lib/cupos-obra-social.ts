import { and, eq, notInArray, sql } from "drizzle-orm";
import {
  db,
  turneraObrasSocialesTable,
  obrasSocialesTable,
  turnosTable,
  pacientesTable,
} from "@workspace/db";

export type ResultadoCupoObraSocial =
  | { ok: true }
  | { ok: false; status: number; error: string };

// Ejecutor: la conexión db global o una transacción de drizzle.
type Ejecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Valida la reserva contra el listado de obras sociales de la agenda.
// Si la agenda no tiene obras sociales configuradas, atiende todas sin límite.
// Con listado: la cobertura del paciente debe estar en la lista y, si esa obra
// social tiene cupo diario, no puede superarse la cantidad de turnos del día.
export async function verificarCupoObraSocial(opts: {
  turneraId: number;
  fecha: string;
  cobertura: string | null | undefined;
}, ejecutor: Ejecutor = db): Promise<ResultadoCupoObraSocial> {
  const restricciones = await ejecutor
    .select({
      obraSocialId: turneraObrasSocialesTable.obraSocialId,
      cupoDiario: turneraObrasSocialesTable.cupoDiario,
      nombre: obrasSocialesTable.nombre,
    })
    .from(turneraObrasSocialesTable)
    .innerJoin(obrasSocialesTable, eq(turneraObrasSocialesTable.obraSocialId, obrasSocialesTable.id))
    .where(eq(turneraObrasSocialesTable.turneraId, opts.turneraId));

  if (restricciones.length === 0) return { ok: true };

  const listado = restricciones.map((r) => r.nombre).join(", ");
  const cobertura = (opts.cobertura ?? "").trim();
  if (!cobertura) {
    return {
      ok: false,
      status: 422,
      error: `Esta agenda atiende solo estas obras sociales: ${listado}. Indicá la cobertura del paciente.`,
    };
  }

  const normalizar = (s: string) =>
    s.trim().toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const coberturaNorm = normalizar(cobertura);
  const match = restricciones.find((r) => normalizar(r.nombre) === coberturaNorm);
  if (!match) {
    return {
      ok: false,
      status: 422,
      error: `Esta agenda no atiende la obra social "${cobertura}". Atiende: ${listado}.`,
    };
  }

  if (match.cupoDiario == null) return { ok: true };

  // Turnos activos del día para esta agenda cuya cobertura (del turno o, si no
  // tiene, de la ficha del paciente) corresponde a la misma obra social.
  const [{ usados }] = await ejecutor
    .select({ usados: sql<number>`count(*)::int` })
    .from(turnosTable)
    .leftJoin(pacientesTable, eq(turnosTable.pacienteId, pacientesTable.id))
    .where(and(
      eq(turnosTable.turneraId, opts.turneraId),
      eq(turnosTable.fecha, opts.fecha),
      notInArray(turnosTable.estado, ["cancelado", "ausente"]),
      sql`unaccent(upper(trim(coalesce(${turnosTable.cobertura}, ${pacientesTable.cobertura}, '')))) = unaccent(upper(trim(${match.nombre})))`,
    ));

  if (usados >= match.cupoDiario) {
    return {
      ok: false,
      status: 409,
      error: `Se alcanzó el cupo diario de ${match.nombre} para esta agenda (${match.cupoDiario} ${match.cupoDiario === 1 ? "turno" : "turnos"} por día). Elegí otra fecha.`,
    };
  }
  return { ok: true };
}

// Toma un advisory lock transaccional por agenda+fecha para serializar los
// controles de cupo concurrentes.
export async function lockCupoObraSocial(
  tx: Ejecutor,
  turneraId: number,
  fecha: string,
): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`cupo-os-${turneraId}-${fecha}`}))`);
}

// Verificación + inserción atómicas: si la agenda tiene listado de obras
// sociales, corre `insertar` dentro de una transacción serializada por
// advisory lock (agenda+fecha) para que dos reservas concurrentes no puedan
// superar el cupo. Sin listado, inserta directo sin serializar.
export async function reservarConCupo<T>(
  opts: { turneraId: number; fecha: string; cobertura: string | null | undefined },
  insertar: (tx: Ejecutor) => Promise<T>,
): Promise<{ ok: true; valor: T } | { ok: false; status: number; error: string }> {
  const [restringida] = await db
    .select({ id: turneraObrasSocialesTable.id })
    .from(turneraObrasSocialesTable)
    .where(eq(turneraObrasSocialesTable.turneraId, opts.turneraId))
    .limit(1);
  if (!restringida) return { ok: true, valor: await insertar(db) };

  return db.transaction(async (tx) => {
    await lockCupoObraSocial(tx, opts.turneraId, opts.fecha);
    const cupo = await verificarCupoObraSocial(opts, tx);
    if (!cupo.ok) return cupo;
    return { ok: true as const, valor: await insertar(tx) };
  });
}
