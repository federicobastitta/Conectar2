/**
 * Task: evitar que una nueva importación recree agendas duplicadas.
 *
 * El importador de agendas, antes de crear una turnera, busca una ACTIVA del
 * mismo profesional+sede+especialidad cuyo horario cubra o coincida con el
 * bloque nuevo y la reutiliza (uniendo días / ensanchando horario) en vez de
 * insertar otra. La decisión vive en elegirTurneraReutilizable (@workspace/db).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { inArray, and, eq } from "drizzle-orm";
import {
  db,
  turnerasTable,
  profesionalesTable,
  especialidadesTable,
  sedesTable,
  elegirTurneraReutilizable,
  horariosSuperpuestos,
} from "@workspace/db";

const RUN_ID = crypto.randomBytes(6).toString("hex");

let profId: number;
let sedeId: number;
let espId: number;
const turneraIds: number[] = [];

beforeAll(async () => {
  const [prof] = await db
    .insert(profesionalesTable)
    .values({ nombre: "Reuso", apellido: `Import${RUN_ID}` })
    .returning();
  profId = prof!.id;
  const [sede] = await db
    .insert(sedesTable)
    .values({ nombre: `Sede Reuso ${RUN_ID}` })
    .returning();
  sedeId = sede!.id;
  const [esp] = await db
    .insert(especialidadesTable)
    .values({ nombre: `Esp Reuso ${RUN_ID}` })
    .returning();
  espId = esp!.id;
});

afterAll(async () => {
  if (turneraIds.length) await db.delete(turnerasTable).where(inArray(turnerasTable.id, turneraIds));
  await db.delete(profesionalesTable).where(eq(profesionalesTable.id, profId));
  await db.delete(sedesTable).where(eq(sedesTable.id, sedeId));
  await db.delete(especialidadesTable).where(eq(especialidadesTable.id, espId));
});

async function crearTurnera(v: Partial<typeof turnerasTable.$inferInsert>) {
  const [t] = await db
    .insert(turnerasTable)
    .values({
      nombre: `Turnera Reuso ${RUN_ID}`,
      profesionalId: profId,
      sedeId,
      especialidadId: espId,
      diasAtencion: "1,3",
      horaInicio: "08:00",
      horaFin: "12:00",
      activa: true,
      visibilidad: "recepcion",
      ...v,
    })
    .returning();
  turneraIds.push(t!.id);
  return t!;
}

/** Replica la consulta de candidatas del importador (trío prof+sede+esp). */
async function candidatasTrio() {
  return db
    .select({
      id: turnerasTable.id,
      activa: turnerasTable.activa,
      diasAtencion: turnerasTable.diasAtencion,
      horaInicio: turnerasTable.horaInicio,
      horaFin: turnerasTable.horaFin,
    })
    .from(turnerasTable)
    .where(
      and(
        eq(turnerasTable.profesionalId, profId),
        eq(turnerasTable.sedeId, sedeId),
        eq(turnerasTable.especialidadId, espId),
      ),
    )
    .orderBy(turnerasTable.id);
}

describe("horariosSuperpuestos", () => {
  it("detecta coincidencia exacta y cobertura", () => {
    const c = { id: 1, activa: true, diasAtencion: "1", horaInicio: "08:00", horaFin: "12:00" };
    expect(horariosSuperpuestos(c, { dias: [1], horaInicio: "08:00", horaFin: "12:00" })).toBe(true);
    expect(horariosSuperpuestos(c, { dias: [1], horaInicio: "09:00", horaFin: "11:00" })).toBe(true);
  });
  it("no fusiona bloques disjuntos (mañana vs tarde)", () => {
    const c = { id: 1, activa: true, diasAtencion: "1", horaInicio: "08:00", horaFin: "12:00" };
    expect(horariosSuperpuestos(c, { dias: [1], horaInicio: "16:00", horaFin: "20:00" })).toBe(false);
    expect(horariosSuperpuestos(c, { dias: [1], horaInicio: "12:00", horaFin: "16:00" })).toBe(false);
  });
});

describe("elegirTurneraReutilizable (pura)", () => {
  const base = { id: 10, activa: true, diasAtencion: "1,3", horaInicio: "08:00", horaFin: "12:00" };

  it("reutiliza y une días cuando el horario coincide", () => {
    const r = elegirTurneraReutilizable([base], { dias: [2, 5], horaInicio: "08:00", horaFin: "12:00" });
    expect(r).not.toBeNull();
    expect(r!.turneraId).toBe(10);
    expect(r!.cambios.diasAtencion).toBe("1,2,3,5");
    expect(r!.horarioCubierto).toBe(true);
    expect(r!.cambios.horaInicio).toBeUndefined();
    expect(r!.cambios.horaFin).toBeUndefined();
  });

  it("amplía el horario cuando el bloque nuevo se extiende más allá", () => {
    const r = elegirTurneraReutilizable([base], { dias: [1], horaInicio: "07:00", horaFin: "13:00" });
    expect(r!.cambios.horaInicio).toBe("07:00");
    expect(r!.cambios.horaFin).toBe("13:00");
    expect(r!.horarioCubierto).toBe(false);
  });

  it("ignora inactivas y bloques sin superposición", () => {
    expect(
      elegirTurneraReutilizable([{ ...base, activa: false }], { dias: [1], horaInicio: "08:00", horaFin: "12:00" }),
    ).toBeNull();
    expect(
      elegirTurneraReutilizable([base], { dias: [1], horaInicio: "14:00", horaFin: "18:00" }),
    ).toBeNull();
  });

  it("es determinística: entre varias activas gana la de menor id", () => {
    const otra = { ...base, id: 4 };
    const r = elegirTurneraReutilizable([base, otra], { dias: [1], horaInicio: "09:00", horaFin: "11:00" });
    expect(r!.turneraId).toBe(4);
  });
});

describe("reimportación contra la DB (flujo del importador)", () => {
  it("reutiliza la turnera activa existente en vez de crear otra", async () => {
    const existente = await crearTurnera({ diasAtencion: "1,3", horaInicio: "08:00", horaFin: "14:00" });

    // Bloque "nuevo" del padrón reimportado: mismo prof+sede+esp, horario
    // cubierto por la existente pero con otra hora_fin (importKey distinto).
    const bloque = { dias: [2], horaInicio: "08:00", horaFin: "12:00" };
    const reuso = elegirTurneraReutilizable(await candidatasTrio(), bloque);

    expect(reuso).not.toBeNull();
    expect(reuso!.turneraId).toBe(existente.id);

    await db.update(turnerasTable).set(reuso!.cambios).where(eq(turnerasTable.id, reuso!.turneraId));
    const [actualizada] = await db
      .select()
      .from(turnerasTable)
      .where(eq(turnerasTable.id, existente.id));
    expect(actualizada!.diasAtencion).toBe("1,2,3");
    expect(actualizada!.horaFin).toBe("14:00"); // no se achica

    // No se creó ninguna turnera nueva para el trío
    const todas = await candidatasTrio();
    expect(todas.length).toBe(1);
  });

  it("no reutiliza una desactivada (unificada) ni un bloque de otro turno del día", async () => {
    const inactiva = await crearTurnera({ activa: false, horaInicio: "08:00", horaFin: "12:00" });

    // Bloque de tarde: no superpone con la activa de mañana (08-14 del test
    // anterior ya amplió días pero no horario) → el importador debe crear una nueva.
    const tarde = { dias: [1], horaInicio: "16:00", horaFin: "20:00" };
    const reuso = elegirTurneraReutilizable(await candidatasTrio(), tarde);
    expect(reuso?.turneraId).not.toBe(inactiva.id);
    expect(reuso).toBeNull();
  });
});
