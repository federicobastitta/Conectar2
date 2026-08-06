import { eq, or, and, inArray } from "drizzle-orm";
import { db, turnerasTable, turneraParticipantesTable, turnosTable } from "@workspace/db";

/**
 * Alcance de datos del perfil médico: un médico solo puede ver turnos y
 * pacientes de sus propias turneras (como titular) o de turneras grupales
 * en las que participa.
 */
export async function turneraIdsDelProfesional(profesionalId: number): Promise<number[]> {
  const [propias, participa] = await Promise.all([
    db.select({ id: turnerasTable.id }).from(turnerasTable)
      .where(eq(turnerasTable.profesionalId, profesionalId)),
    db.select({ id: turneraParticipantesTable.turneraId }).from(turneraParticipantesTable)
      .where(eq(turneraParticipantesTable.profesionalId, profesionalId)),
  ]);
  return [...new Set([...propias.map((r) => r.id), ...participa.map((r) => r.id)])];
}

/**
 * Turneras de guardia (bolsa compartida de demanda espontánea). Se incluyen
 * SIN filtrar por activa: hay guardias desactivadas (duplicadas) que igual
 * reciben pacientes, y esos turnos deben ser visibles para los médicos.
 */
export async function turneraIdsGuardia(): Promise<number[]> {
  const filas = await db.select({ id: turnerasTable.id }).from(turnerasTable)
    .where(eq(turnerasTable.esGuardia, true));
  return filas.map((r) => r.id);
}

/** true si el paciente tiene (o tuvo) algún turno dentro del alcance del médico. */
export async function medicoPuedeVerPaciente(profesionalId: number, pacienteId: number): Promise<boolean> {
  // La bolsa de guardia es compartida: cualquier médico puede atender a esos
  // pacientes, así que también entra en el alcance (igual que en recepción).
  // Sin esto, los médicos de guardia no podían abrir la HCE de sus pacientes
  // (los turnos de guardia no tienen profesional asignado).
  const [propias, guardias] = await Promise.all([
    turneraIdsDelProfesional(profesionalId),
    turneraIdsGuardia(),
  ]);
  const ids = [...new Set([...propias, ...guardias])];
  const condTurnera = ids.length ? [inArray(turnosTable.turneraId, ids)] : [];
  const [fila] = await db
    .select({ id: turnosTable.id })
    .from(turnosTable)
    .where(and(
      eq(turnosTable.pacienteId, pacienteId),
      or(eq(turnosTable.profesionalId, profesionalId), ...condTurnera),
    ))
    .limit(1);
  return Boolean(fila);
}

/** true si el turno está dentro del alcance del médico (turnera propia/grupal o asignado a él). */
export async function turnoEnAlcanceMedico(
  profesionalId: number,
  turno: { turneraId: number; profesionalId: number | null },
): Promise<boolean> {
  if (turno.profesionalId === profesionalId) return true;
  const [propias, guardias] = await Promise.all([
    turneraIdsDelProfesional(profesionalId),
    turneraIdsGuardia(),
  ]);
  return propias.includes(turno.turneraId) || guardias.includes(turno.turneraId);
}

/**
 * Estados en los que el turno ya fue atendido (consulta cerrada o posterior).
 * En listados del día para el rol médico, los turnos de turneras compartidas
 * en estos estados se ocultan si los atendió otro profesional.
 */
export const ESTADOS_ATENDIDO_CERRADO = new Set([
  "atendido", "visto", "pendiente_informe", "informando", "informado", "publicado", "visto_usuario",
]);

/**
 * Estados en los que el paciente está EN CONSULTA (llamado o siendo atendido).
 * Regla 03-ago-2026: en turneras compartidas (grupales/guardia), un paciente
 * en consulta solo lo ve el médico que lo llamó; los demás dejan de verlo
 * hasta que vuelva a la sala o se cierre la consulta (y ahí aplica la regla
 * de atendidos). Los "esperando" (pendiente/confirmado/arribo/en_sala) siguen
 * siendo bolsa compartida visible para todos.
 */
export const ESTADOS_EN_CONSULTA = new Set(["llamado", "en_atencion"]);

/**
 * ¿Este turno de listado diario debe ocultarse al médico `pid`?
 * Aplica la atribución (quién lo llamó, o el profesional asignado) tanto a
 * los turnos en consulta como a los ya atendidos/cerrados. Sin atribución
 * (p. ej. recepción lo marcó a mano) se deja visible.
 */
export function ocultarTurnoAjeno(
  turno: { estado: string; llamadoPorProfesionalId: number | null; profesionalId: number | null },
  pid: number | null,
): boolean {
  if (!ESTADOS_ATENDIDO_CERRADO.has(turno.estado) && !ESTADOS_EN_CONSULTA.has(turno.estado)) return false;
  const atribuido = turno.llamadoPorProfesionalId ?? turno.profesionalId;
  return atribuido != null && atribuido !== pid;
}

/** profesionalId numérico del usuario, o null si no tiene. */
export function profesionalIdDe(user: { profesionalId: string | number | null }): number | null {
  if (user.profesionalId == null) return null;
  const n = Number(user.profesionalId);
  return Number.isInteger(n) ? n : null;
}
