import { and, eq } from "drizzle-orm";
import { db, turnosTable, type turnerasTable } from "@workspace/db";
import { esSlotPasado } from "./tiempo";

export interface SlotDisponibilidad {
  turneraId: number;
  fecha: string;
  horaInicio: string;
  horaFin: string;
  disponible: boolean;
  turnoId: number | null;
}

// Calcula los slots de una turnera para una fecha dada (fecha YYYY-MM-DD).
// Devuelve [] si la turnera no atiende ese día de la semana.
export async function calcularSlotsDisponibles(
  turnera: typeof turnerasTable.$inferSelect,
  fecha: string,
  // Si el llamador ya trajo los turnos del día (consultas en lote), se evitan
  // consultas repetidas a la base.
  turnosPrecargados?: (typeof turnosTable.$inferSelect)[],
): Promise<SlotDisponibilidad[]> {
  // fecha es YYYY-MM-DD → parsear como UTC y usar getUTCDay() para que el día
  // de semana no se corra si el server no corre en UTC.
  const fechaDate = new Date(`${fecha}T00:00:00.000Z`);
  const diaSemana = fechaDate.getUTCDay(); // 0=domingo
  const diasArray = turnera.diasAtencion ? turnera.diasAtencion.split(",").map(Number) : [];
  if (!diasArray.includes(diaSemana)) return [];

  // Horario del día: si la turnera define horarios por día, usar el de este
  // día de semana; si no, el rango global horaInicio/horaFin.
  const horarioDia = turnera.horariosDia?.find((h) => h.dia === diaSemana);
  const [hIni, mIni] = (horarioDia?.horaInicio ?? turnera.horaInicio).split(":").map(Number);
  const [hFin, mFin] = (horarioDia?.horaFin ?? turnera.horaFin).split(":").map(Number);
  const duracion = turnera.duracionMinutos;
  const slots: SlotDisponibilidad[] = [];

  let current = hIni * 60 + mIni;
  const end = hFin * 60 + mFin;

  const turnosDelDia = turnosPrecargados ?? await db.select().from(turnosTable)
    .where(and(eq(turnosTable.turneraId, turnera.id), eq(turnosTable.fecha, fecha)));

  while (current + duracion <= end) {
    const slotH = Math.floor(current / 60).toString().padStart(2, "0");
    const slotM = (current % 60).toString().padStart(2, "0");
    const slotHFin = Math.floor((current + duracion) / 60).toString().padStart(2, "0");
    const slotMFin = ((current + duracion) % 60).toString().padStart(2, "0");
    const horaInicioStr = `${slotH}:${slotM}`;
    const horaFinStr = `${slotHFin}:${slotMFin}`;

    const turnoOcupado = turnosDelDia.find(
      (t) => t.horaInicio === horaInicioStr && !["cancelado", "ausente"].includes(t.estado)
    );

    // No ofrecer horarios que ya pasaron (hora argentina).
    if (esSlotPasado(fecha, horaInicioStr)) {
      current += duracion;
      continue;
    }

    slots.push({
      turneraId: turnera.id,
      fecha,
      horaInicio: horaInicioStr,
      horaFin: horaFinStr,
      disponible: !turnoOcupado,
      turnoId: turnoOcupado?.id ?? null,
    });
    current += duracion;
  }
  return slots;
}
