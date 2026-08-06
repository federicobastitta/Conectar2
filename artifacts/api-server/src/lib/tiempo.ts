// Fecha y hora actuales en la zona horaria de la clínica (Argentina).
// El servidor corre en UTC, así que "hoy" y "ahora" deben calcularse
// explícitamente en America/Argentina/Buenos_Aires para no correr un día
// ni ofrecer/aceptar horarios ya pasados.

const TIMEZONE = "America/Argentina/Buenos_Aires";

// "YYYY-MM-DD" de hoy en Argentina.
export function hoyArgentina(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// "HH:MM" (24hs) actual en Argentina.
export function horaArgentina(): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
}

// true si el slot (fecha YYYY-MM-DD + hora HH:MM) ya pasó según la hora argentina.
export function esSlotPasado(fecha: string, hora: string): boolean {
  const hoy = hoyArgentina();
  if (fecha < hoy) return true;
  if (fecha > hoy) return false;
  return hora <= horaArgentina();
}
