// Helper compartido: inserta un turno en una bolsa esGuardia con
// posicionamiento correcto (detrás del último recepcionado de agendas
// programadas de la misma especialidad) y retry automático en colisiones de slot.
//
// Usado tanto por la demanda espontánea presencial (vía POST /turnos, que
// llama directamente su lógica inline por compatibilidad) como por la guardia
// virtual (guardia_virtual.ts), que es el consumidor principal de este módulo.

import { and, eq, inArray } from "drizzle-orm";
import { db, turnosTable, turnerasTable } from "@workspace/db";
import { esViolacionUnique } from "./pg";
import { reservarConCupo } from "./cupos-obra-social";

const MAX_REINTENTOS = 30;

export interface ParamsInsertarTurnoGuardia {
  turneraId: number;
  especialidadId?: number | null;
  pacienteId: number;
  profesionalId?: number | null;
  fecha: string; // YYYY-MM-DD
  /** HH:MM — hora de llegada; se ajusta si hay recepcionados más tardíos */
  horaInicioBase: string;
  duracionMinutos?: number;
  estado?: "arribo" | "pendiente" | "confirmado";
  admitidoEn?: Date;
  admitidoPor?: string;
  modalidad?: string;
  motivoConsulta?: string;
  observaciones?: string;
  cobertura?: string | null;
  nroAfiliado?: string | null;
  /**
   * Reserva exacta (Check in): usa horaInicioBase tal cual (sin reubicar
   * detrás de la fila) y ante colisión de slot lanza ErrorSlotOcupado en vez
   * de correr la hora de a 1 minuto. El llamador elige otro slot de la grilla.
   */
  horaExacta?: boolean;
}

/** Colisión de slot en modo horaExacta: el horario pedido ya está tomado. */
export class ErrorSlotOcupado extends Error {
  constructor(public readonly hora: string) {
    super(`El horario ${hora} ya está ocupado.`);
    this.name = "ErrorSlotOcupado";
  }
}

export interface ResultadoInsertarTurnoGuardia {
  turno: typeof turnosTable.$inferSelect;
}

/**
 * Calcula la horaInicio efectiva para un nuevo arribo a la guardia:
 * si ya hay turnos recepcionados de agendas programadas de la misma
 * especialidad con horaInicio mayor a `horaBase`, la demanda espontánea
 * se ubica un minuto después del último (no rompe la fila programada).
 */
export async function calcularHoraInicioGuardia(
  especialidadId: number | null | undefined,
  fecha: string,
  horaBase: string,
): Promise<string> {
  let hora = horaBase.substring(0, 5);
  if (especialidadId == null) return hora;

  const ESTADOS_RECEPCIONADO = ["arribo", "recepcionado", "en_sala", "llamado"];
  const turnerasEsp = await db
    .select({ id: turnerasTable.id })
    .from(turnerasTable)
    .where(and(eq(turnerasTable.especialidadId, especialidadId), eq(turnerasTable.esGuardia, false)));

  if (turnerasEsp.length === 0) return hora;

  const recepcionados = await db
    .select({ horaInicio: turnosTable.horaInicio })
    .from(turnosTable)
    .where(
      and(
        inArray(
          turnosTable.turneraId,
          turnerasEsp.map((t) => t.id),
        ),
        eq(turnosTable.fecha, fecha),
        inArray(turnosTable.estado, ESTADOS_RECEPCIONADO),
      ),
    );

  const ultima = recepcionados
    .map((t) => t.horaInicio.substring(0, 5))
    .sort()
    .pop();

  if (ultima && ultima >= hora) {
    const [hU, mU] = ultima.split(":").map(Number);
    const sig = Math.min((hU ?? 0) * 60 + (mU ?? 0) + 1, 23 * 60 + 59);
    hora = `${Math.floor(sig / 60).toString().padStart(2, "0")}:${(sig % 60).toString().padStart(2, "0")}`;
  }
  return hora;
}

/**
 * Inserta el turno en la bolsa esGuardia, reintentando la hora si hay
 * colisión de slot (hasta 30 intentos, avanza 1 minuto por intento).
 * Lanza un Error si no pudo encontrar slot disponible.
 */
export async function insertarTurnoGuardia(
  params: ParamsInsertarTurnoGuardia,
): Promise<ResultadoInsertarTurnoGuardia> {
  const {
    turneraId,
    especialidadId,
    pacienteId,
    profesionalId,
    fecha,
    horaInicioBase,
    duracionMinutos = 15,
    estado = "arribo",
    admitidoEn,
    admitidoPor,
    modalidad = "presencial",
    motivoConsulta,
    observaciones,
    cobertura,
    nroAfiliado,
    horaExacta = false,
  } = params;

  let horaIntento = horaExacta
    ? horaInicioBase
    : await calcularHoraInicioGuardia(especialidadId, fecha, horaInicioBase);

  for (let intento = 0; intento < MAX_REINTENTOS; intento++) {
    try {
      const [hI, mI] = horaIntento.split(":").map(Number);
      const finMin = Math.min((hI ?? 0) * 60 + (mI ?? 0) + duracionMinutos, 23 * 60 + 59);
      const horaFin = `${Math.floor(finMin / 60).toString().padStart(2, "0")}:${(finMin % 60).toString().padStart(2, "0")}`;

      const r = await reservarConCupo(
        { turneraId, fecha, cobertura: cobertura ?? null },
        async (tx) => {
          const [creado] = await tx
            .insert(turnosTable)
            .values({
              turneraId,
              pacienteId,
              profesionalId: profesionalId ?? undefined,
              fecha,
              horaInicio: horaIntento,
              horaFin,
              estado,
              ...(admitidoEn != null
                ? { admitidoEn, admitidoPor: admitidoPor ?? "guardia virtual" }
                : {}),
              modalidad,
              motivoConsulta: motivoConsulta ?? undefined,
              observaciones: observaciones ?? undefined,
              cobertura: cobertura ?? undefined,
              nroAfiliado: nroAfiliado ?? undefined,
            })
            .returning();
          return creado;
        },
      );

      if (!r.ok) {
        throw new Error(r.error);
      }
      return { turno: r.valor };
    } catch (err) {
      if (esViolacionUnique(err)) {
        // Modo reserva exacta (Check in): no corremos la hora — el llamador
        // decide el próximo slot de la grilla.
        if (horaExacta) throw new ErrorSlotOcupado(horaIntento);
        const [hI, mI] = horaIntento.split(":").map(Number);
        const sig = (hI ?? 0) * 60 + (mI ?? 0) + 1;
        if (sig > 23 * 60 + 59) break;
        horaIntento = `${Math.floor(sig / 60).toString().padStart(2, "0")}:${(sig % 60).toString().padStart(2, "0")}`;
        continue;
      }
      throw err;
    }
  }

  throw new Error("No se pudo asignar un lugar en la guardia. Intentá de nuevo.");
}
