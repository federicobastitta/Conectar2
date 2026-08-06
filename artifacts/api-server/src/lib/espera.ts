// Estimación de espera compartida entre /sala-espera/mi-posicion (paciente)
// y /sala-espera/cola (staff).
//
// Modelo (definido por el usuario, ago 2026): la duración de cada atención se
// mide desde que el médico pone "Llamar" (llamado_en) hasta que aprieta
// "Finalizar Consulta" (finalizado_en), y en guardia/demanda espontánea la
// cola se reparte entre el POOL de médicos que están atendiendo: con 3 médicos
// activos, el 6º de la fila espera ~2 rondas, no 6.
//
// Ritmo del día = promedio de (finalizado_en - llamado_en) de las consultas
// terminadas hoy en la turnera. Fallback: duración configurada de la turnera;
// si no hay nada, null (el caller decide qué mostrar).
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db, turnosTable } from "@workspace/db";

const RITMO_MIN = 3;
const RITMO_MAX = 120;
// Un médico cuenta como "atendiendo ahora" si llamó a alguien hace menos de
// esta ventana (o tiene un paciente en consulta en este momento).
const VENTANA_POOL_MIN = 90;

export interface EstimadorEspera {
  /**
   * Espera estimada en minutos para el paciente en `posicion` (1 = próximo)
   * de la cola de la turnera. Devuelve null si no hay datos para estimar.
   */
  estimar(turneraId: number, posicion: number): number | null;
}

/**
 * Construye un estimador de espera para las turneras dadas en la fecha dada.
 * `duracionPorTurnera` provee el fallback (duracionMinutos de cada turnera)
 * cuando todavía no hay consultas terminadas hoy.
 */
export async function crearEstimadorEspera(
  fecha: string,
  turneraIds: number[],
  duracionPorTurnera: Map<number, number | null | undefined>,
): Promise<EstimadorEspera> {
  if (turneraIds.length === 0) {
    return { estimar: () => null };
  }

  const ahora = Date.now();

  // Turnos de hoy con llamado registrado: dan las duraciones reales
  // (los terminados) y los médicos activos ahora (los llamados recientes).
  const filas = await db.select({
    turneraId: turnosTable.turneraId,
    estado: turnosTable.estado,
    llamadoEn: turnosTable.llamadoEn,
    finalizadoEn: turnosTable.finalizadoEn,
    llamadoPor: turnosTable.llamadoPorProfesionalId,
  })
    .from(turnosTable)
    .where(and(
      eq(turnosTable.fecha, fecha),
      inArray(turnosTable.turneraId, turneraIds),
      isNotNull(turnosTable.llamadoEn),
    ));

  // NOTA: NO usamos el flag "acepta demanda espontánea" para el pool — los
  // médicos lo dejan prendido para siempre (26 activos en la base) y dividir
  // la fila por eso daría esperas irrealmente cortas. El pool se mide por
  // actividad real: quién llamó pacientes en esta cola recientemente.
  const ritmoPorTurnera = new Map<number, number | null>();
  const poolPorTurnera = new Map<number, number>();
  const enConsultaDesde = new Map<number, number>();

  for (const turneraId of turneraIds) {
    const deTurnera = filas.filter((f) => f.turneraId === turneraId);

    // Ritmo: promedio llamado → finalizado de la ÚLTIMA HORA (pedido del
    // usuario: el promedio es por hora, para que refleje el ritmo actual y no
    // arrastre la mañana entera). Si en la última hora no terminó ninguna
    // consulta, se usa el promedio del día como respaldo.
    const duracionesHora: number[] = [];
    const duracionesDia: number[] = [];
    for (const f of deTurnera) {
      if (!f.llamadoEn || !f.finalizadoEn) continue;
      const min = (f.finalizadoEn.getTime() - f.llamadoEn.getTime()) / 60000;
      if (min <= 0 || min > RITMO_MAX) continue;
      duracionesDia.push(min);
      if ((ahora - f.finalizadoEn.getTime()) / 60000 <= 60) duracionesHora.push(min);
    }
    const duraciones = duracionesHora.length > 0 ? duracionesHora : duracionesDia;
    let ritmo: number | null = null;
    if (duraciones.length > 0) {
      const promedio = duraciones.reduce((a, b) => a + b, 0) / duraciones.length;
      ritmo = Math.min(RITMO_MAX, Math.max(RITMO_MIN, promedio));
    } else {
      const dur = duracionPorTurnera.get(turneraId);
      if (dur && dur > 0) ritmo = Math.min(RITMO_MAX, dur);
    }
    ritmoPorTurnera.set(turneraId, ritmo);

    // Pool: médicos distintos atendiendo esta cola ahora
    const medicosActivos = new Set<number>();
    for (const f of deTurnera) {
      if (f.llamadoPor == null || !f.llamadoEn) continue;
      // Un llamado que terminó en cancelación/ausencia sin consulta no cuenta
      // como actividad: solo consultas abiertas ahora o terminadas hace poco.
      if (["cancelado", "anulado", "ausente", "a_reprogramar"].includes(f.estado) && !f.finalizadoEn) continue;
      const enCurso = ["llamado", "en_atencion"].includes(f.estado) && !f.finalizadoEn;
      const reciente = (ahora - (f.finalizadoEn ?? f.llamadoEn).getTime()) / 60000 <= VENTANA_POOL_MIN;
      if (enCurso || reciente) medicosActivos.add(f.llamadoPor);
    }
    poolPorTurnera.set(turneraId, Math.max(1, medicosActivos.size));

    // Si hay alguien en consulta ahora, descontamos lo ya transcurrido del
    // llamado más viejo aún abierto.
    const abiertos = deTurnera
      .filter((f) => ["llamado", "en_atencion"].includes(f.estado) && !f.finalizadoEn && f.llamadoEn)
      .map((f) => f.llamadoEn!.getTime())
      .sort((a, b) => a - b);
    if (abiertos.length > 0) enConsultaDesde.set(turneraId, abiertos[0]!);
  }

  return {
    estimar(turneraId: number, posicion: number): number | null {
      const ritmo = ritmoPorTurnera.get(turneraId);
      if (ritmo == null) return null;
      const pool = poolPorTurnera.get(turneraId) ?? 1;
      // Con N médicos, el paciente en posición P espera ~ceil(P/N) rondas.
      let estimado = Math.ceil(posicion / pool) * ritmo;
      const desde = enConsultaDesde.get(turneraId);
      if (desde !== undefined) {
        const transcurrido = Math.min((Date.now() - desde) / 60000, ritmo);
        estimado -= Math.max(0, transcurrido);
      }
      return Math.max(0, Math.round(estimado));
    },
  };
}
