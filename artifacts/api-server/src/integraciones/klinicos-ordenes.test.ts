import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { inArray } from "drizzle-orm";
import { db, profesionalesTable } from "@workspace/db";
import { buscarProfesionalPrescriptor } from "./klinicos-ordenes";

// Matching prescriptor de planilla → profesional de Conectar para la orden de
// respaldo automática. Debe tolerar orden apellido/nombre invertido, acentos,
// segundos nombres de un solo lado, y usar la matrícula (solo dígitos) como
// criterio fuerte. Ambiguo o ninguno → null, nunca adivinar.
// Los nombres llevan RUN_ID para no matchear fichas reales de la base compartida.

const RUN_ID = crypto.randomBytes(6).toString("hex");
const APE = `Kot${RUN_ID}`; // apellido único de esta corrida
const ids: number[] = [];

async function crearProfesional(v: Partial<typeof profesionalesTable.$inferInsert> & { nombre: string }) {
  const [p] = await db.insert(profesionalesTable).values({ activo: true, ...v }).returning();
  ids.push(p.id);
  return p.id;
}

let idCaceres: number;
let idSinNormalizado: number;
let idHomonimoA: number;
let idHomonimoB: number;

beforeAll(async () => {
  // Ficha típica importada: nombre_normalizado "apellido nombre", matrícula limpia
  idCaceres = await crearProfesional({
    nombre: "Franco",
    apellido: `Cáceres${RUN_ID}`,
    matricula: "238974",
    nombreNormalizado: `caceres${RUN_ID} franco`,
  });
  // Ficha cargada a mano: sin nombre_normalizado, apellido+nombre sueltos
  idSinNormalizado = await crearProfesional({
    nombre: "María José",
    apellido: `Pérez${RUN_ID}`,
    matricula: null,
    nombreNormalizado: null,
  });
  // Homónimos: mismo nombre, solo uno con matrícula
  idHomonimoA = await crearProfesional({
    nombre: "Ana",
    apellido: APE,
    matricula: "555111",
    nombreNormalizado: `${APE.toLowerCase()} ana`,
  });
  // Cuasi-homónima: mismo apellido y nombre más un segundo nombre (la base
  // tiene nombre_normalizado único, homónimos exactos no pueden existir)
  idHomonimoB = await crearProfesional({
    nombre: "Ana María",
    apellido: APE,
    matricula: null,
    nombreNormalizado: `${APE.toLowerCase()} ana maria`,
  });
  // Inactivo con la misma matrícula que Cáceres: no debe contar
  const [inactivo] = await db
    .insert(profesionalesTable)
    .values({ nombre: "Viejo", apellido: `Cáceres${RUN_ID}`, matricula: "238974", activo: false })
    .returning();
  ids.push(inactivo.id);
});

afterAll(async () => {
  if (ids.length) await db.delete(profesionalesTable).where(inArray(profesionalesTable.id, ids));
});

describe("buscarProfesionalPrescriptor", () => {
  it("caso real: 'CACERES FRANCO' (MP 238-974) matchea la ficha 'Franco Cáceres'", async () => {
    await expect(buscarProfesionalPrescriptor(`CACERES${RUN_ID} FRANCO`, "MP 238-974")).resolves.toBe(idCaceres);
  });

  it("matrícula sola con formato distinto alcanza (criterio fuerte)", async () => {
    await expect(buscarProfesionalPrescriptor(null, "238.974")).resolves.toBe(idCaceres);
  });

  it("nombre invertido y sin acentos, sin matrícula", async () => {
    await expect(buscarProfesionalPrescriptor(`CACERES${RUN_ID}, FRANCO`, null)).resolves.toBe(idCaceres);
  });

  it("ficha sin nombre_normalizado: reconstruye desde apellido+nombre", async () => {
    await expect(buscarProfesionalPrescriptor(`PEREZ${RUN_ID} MARIA JOSE`, null)).resolves.toBe(idSinNormalizado);
  });

  it("segundo nombre solo en la planilla no rompe el match", async () => {
    await expect(buscarProfesionalPrescriptor(`CACERES${RUN_ID} FRANCO JAVIER`, null)).resolves.toBe(idCaceres);
  });

  it("una sola palabra en común es demasiado débil → null", async () => {
    await expect(buscarProfesionalPrescriptor(`CACERES${RUN_ID}`, null)).resolves.toBeNull();
  });

  it("homónimos sin matrícula → null (ambiguo)", async () => {
    await expect(buscarProfesionalPrescriptor(`${APE} ANA`, null)).resolves.toBeNull();
    expect(idHomonimoB).toBeGreaterThan(0);
  });

  it("homónimos con matrícula: desempata por matrícula", async () => {
    await expect(buscarProfesionalPrescriptor(`${APE} ANA`, "MP 555-111")).resolves.toBe(idHomonimoA);
  });

  it("desconocido → null", async () => {
    await expect(buscarProfesionalPrescriptor(`NADIE${RUN_ID} FULANO`, "MP 000-000")).resolves.toBeNull();
  });
});
