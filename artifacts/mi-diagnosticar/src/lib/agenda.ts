import type { Turnera } from "@workspace/api-client-react";

const TZ = "America/Argentina/Buenos_Aires";

export const DIAS_CORTOS = ["D", "L", "M", "X", "J", "V", "S"];
export const DIAS_LABEL = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

export function ahoraArgentina(): { fecha: string; hora: string; diaSemana: number } {
  const now = new Date();
  const fecha = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(now);
  const hora = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(now);
  const diaSemana = new Date(`${fecha}T00:00:00.000Z`).getUTCDay();
  return { fecha, hora, diaSemana };
}

export function atendiendoAhora(
  t: Turnera,
  ahora: ReturnType<typeof ahoraArgentina>,
): boolean {
  if (!t.activa) return false;
  const dias = t.diasAtencion ?? [];
  if (!dias.includes(ahora.diaSemana)) return false;
  if (!t.horaInicio || !t.horaFin) return false;
  return ahora.hora >= t.horaInicio && ahora.hora < t.horaFin;
}

export function nombreProfesional(t: Turnera): string {
  if (!t.profesional) return t.nombre;
  const { apellido, nombre } = t.profesional;
  return `${apellido ?? ""}${apellido && nombre ? ", " : ""}${nombre ?? ""}` || t.nombre;
}

export function diasLegibles(dias: number[]): string {
  return dias.length ? dias.map((d) => DIAS_LABEL[d] ?? "?").join(" · ") : "Sin días configurados";
}
