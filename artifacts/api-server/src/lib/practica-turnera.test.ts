import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { inArray, eq } from "drizzle-orm";
import { db, turnerasTable, turneraPracticasTable, klinicosPracticas } from "@workspace/db";
import { practicaUnicaDeTurnera } from "./practica-turnera";

// Resolución automática del tipo de estudio al crear un turno:
// - agenda cuyos códigos corresponden a UNA práctica del catálogo → su id
// - agenda con códigos de VARIAS prácticas (ej. eco mamaria + abdominal) → null
//   (el cliente debe elegir; nunca se adivina el código)
// - agenda sin códigos asociados → null
// Los códigos llevan RUN_ID para no matchear el catálogo real de la base compartida.

const RUN_ID = crypto.randomBytes(6).toString("hex");
const COD_A1 = `TA1-${RUN_ID}`;
const COD_A2 = `TA2-${RUN_ID}`;
const COD_B1 = `TB1-${RUN_ID}`;

const turneraIds: number[] = [];
const practicaIds: number[] = [];

async function crearTurnera(nombre: string): Promise<number> {
  const [t] = await db.insert(turnerasTable).values({
    nombre: `${nombre}-${RUN_ID}`,
    diasAtencion: "1,2,3,4,5",
    horaInicio: "08:00",
    horaFin: "12:00",
    duracionMinutos: 20,
    activa: true,
  }).returning();
  turneraIds.push(t.id);
  return t.id;
}

let turneraUnicaId: number;
let turneraMultiId: number;
let turneraSinCodigosId: number;
let practicaAId: number;

beforeAll(async () => {
  const [pA] = await db.insert(klinicosPracticas).values({
    nombre: `ECO TEST A ${RUN_ID}`,
    codigos: [COD_A1, COD_A2],
    activo: true,
  }).returning();
  const [pB] = await db.insert(klinicosPracticas).values({
    nombre: `ECO TEST B ${RUN_ID}`,
    codigos: [COD_B1],
    activo: true,
  }).returning();
  practicaIds.push(pA.id, pB.id);
  practicaAId = pA.id;

  turneraUnicaId = await crearTurnera("test-practica-unica");
  turneraMultiId = await crearTurnera("test-practica-multi");
  turneraSinCodigosId = await crearTurnera("test-practica-sin");

  await db.insert(turneraPracticasTable).values([
    // Agenda que hace solo la práctica A (sus dos códigos)
    { turneraId: turneraUnicaId, codigo: COD_A1 },
    { turneraId: turneraUnicaId, codigo: COD_A2 },
    // Agenda que hace A y B: ambigua, hay que preguntar
    { turneraId: turneraMultiId, codigo: COD_A1 },
    { turneraId: turneraMultiId, codigo: COD_A2 },
    { turneraId: turneraMultiId, codigo: COD_B1 },
  ]);
});

afterAll(async () => {
  if (turneraIds.length) {
    await db.delete(turneraPracticasTable).where(inArray(turneraPracticasTable.turneraId, turneraIds));
    await db.delete(turnerasTable).where(inArray(turnerasTable.id, turneraIds));
  }
  if (practicaIds.length) {
    await db.delete(klinicosPracticas).where(inArray(klinicosPracticas.id, practicaIds));
  }
});

describe("practicaUnicaDeTurnera", () => {
  it("agenda con una sola práctica correspondiente: devuelve su id", async () => {
    await expect(practicaUnicaDeTurnera(turneraUnicaId)).resolves.toBe(practicaAId);
  });

  it("agenda con varias prácticas posibles: null (debe elegir el cliente)", async () => {
    await expect(practicaUnicaDeTurnera(turneraMultiId)).resolves.toBeNull();
  });

  it("agenda sin códigos asociados: null", async () => {
    await expect(practicaUnicaDeTurnera(turneraSinCodigosId)).resolves.toBeNull();
  });

  it("práctica inactiva no cuenta como candidata", async () => {
    const [pA] = await db.select().from(klinicosPracticas).where(eq(klinicosPracticas.id, practicaAId));
    expect(pA.activo).toBe(true);
    await db.update(klinicosPracticas).set({ activo: false }).where(eq(klinicosPracticas.id, practicaAId));
    try {
      await expect(practicaUnicaDeTurnera(turneraUnicaId)).resolves.toBeNull();
    } finally {
      await db.update(klinicosPracticas).set({ activo: true }).where(eq(klinicosPracticas.id, practicaAId));
    }
  });
});
