/**
 * Reutilización de turneras en importaciones (anti-duplicados).
 *
 * Regla (jul 2026): antes de crear una turnera nueva, los importadores deben
 * buscar una ACTIVA del mismo profesional + sede (+ especialidad) cuyo horario
 * cubra o coincida (se superponga) con el bloque nuevo, y reutilizarla —
 * uniendo días y ensanchando el horario — en vez de insertar otra.
 *
 * Lógica pura, sin acceso a DB: el caller consulta las candidatas
 * (mismo profesional/sede/especialidad) y este módulo decide cuál reutilizar
 * y qué cambios aplicarle.
 */

export interface TurneraCandidata {
  id: number;
  activa: boolean;
  diasAtencion: string; // "1,3,5"
  horaInicio: string; // "HH:MM"
  horaFin: string; // "HH:MM"
}

export interface BloqueNuevo {
  dias: number[]; // días de la semana del bloque nuevo
  horaInicio: string; // "HH:MM"
  horaFin: string; // "HH:MM"
}

export interface ReusoElegido {
  turneraId: number;
  cambios: {
    diasAtencion: string;
    horaInicio?: string;
    horaFin?: string;
    activa: true;
  };
  /** true si el horario existente ya cubría por completo al nuevo */
  horarioCubierto: boolean;
}

export function horaAMinutos(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm.trim());
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

function parseDias(s: string): number[] {
  return s
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isInteger(n));
}

/** ¿El horario de la candidata coincide o se superpone con el bloque nuevo? */
export function horariosSuperpuestos(c: TurneraCandidata, b: BloqueNuevo): boolean {
  const ci = horaAMinutos(c.horaInicio);
  const cf = horaAMinutos(c.horaFin);
  const bi = horaAMinutos(b.horaInicio);
  const bf = horaAMinutos(b.horaFin);
  if ([ci, cf, bi, bf].some(Number.isNaN)) return false;
  // superposición estricta (bloques disjuntos como mañana/tarde NO se fusionan)
  return ci < bf && bi < cf;
}

/**
 * Elige una turnera existente a reutilizar para el bloque nuevo.
 * Candidatas: turneras del MISMO profesional + sede (+ especialidad), en orden
 * arbitrario. Devuelve null si ninguna activa coincide/cubre el horario.
 * Determinístico: entre varias activas superpuestas gana la de menor id.
 */
export function elegirTurneraReutilizable(
  candidatas: TurneraCandidata[],
  bloque: BloqueNuevo,
): ReusoElegido | null {
  const activas = candidatas
    .filter((c) => c.activa && horariosSuperpuestos(c, bloque))
    .sort((a, b) => a.id - b.id);
  const elegida = activas[0];
  if (!elegida) return null;

  const dias = new Set(parseDias(elegida.diasAtencion));
  for (const d of bloque.dias) dias.add(d);

  const cambios: ReusoElegido["cambios"] = {
    diasAtencion: [...dias].sort((a, b) => a - b).join(","),
    activa: true,
  };

  const cubierto =
    horaAMinutos(elegida.horaInicio) <= horaAMinutos(bloque.horaInicio) &&
    horaAMinutos(elegida.horaFin) >= horaAMinutos(bloque.horaFin);

  // Ampliar horario si el bloque nuevo se extiende más allá del existente
  if (horaAMinutos(bloque.horaInicio) < horaAMinutos(elegida.horaInicio)) {
    cambios.horaInicio = bloque.horaInicio;
  }
  if (horaAMinutos(bloque.horaFin) > horaAMinutos(elegida.horaFin)) {
    cambios.horaFin = bloque.horaFin;
  }

  return { turneraId: elegida.id, cambios, horarioCubierto: cubierto };
}
