import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { inArray, eq } from "drizzle-orm";
import { db, profesionalesTable } from "@workspace/db";
import {
  analizarFila,
  claveNombreProfesional,
  invalidarIndiceNombresProfesionales,
} from "./importacion_v2";

// Regresión Task 82: el importador v2 matchea por matrícula primero, pero
// cuando la matrícula es NULL la única protección contra duplicados es el
// nombre. Estas pruebas verifican que el fallback por nombre normalizado
// tolera tildes, mayúsculas, comas y orden apellido/nombre invertido, de
// modo que una reimportación no cree profesionales duplicados.

const RUN_ID = crypto.randomBytes(6).toString("hex");
const profIds: number[] = [];

let profSinMatriculaId: number;
let profConMatriculaId: number;

beforeAll(async () => {
  // Profesional sin matrícula (como los ids 41/48/58/78/84 reales)
  const [p1] = await db
    .insert(profesionalesTable)
    .values({ nombre: `Nicolás`, apellido: `Gutiérrez Dedup${RUN_ID}`, matricula: null })
    .returning();
  profSinMatriculaId = p1!.id;
  profIds.push(p1!.id);

  const [p2] = await db
    .insert(profesionalesTable)
    .values({ nombre: `María`, apellido: `Pérez Dedup${RUN_ID}`, matricula: `MAT-${RUN_ID}` })
    .returning();
  profConMatriculaId = p2!.id;
  profIds.push(p2!.id);
  invalidarIndiceNombresProfesionales();
});

afterAll(async () => {
  await db.delete(profesionalesTable).where(inArray(profesionalesTable.id, profIds));
});

describe("claveNombreProfesional", () => {
  it("normaliza tildes, mayúsculas, comas y orden de palabras", () => {
    const base = claveNombreProfesional("Nicolás", "Gutiérrez");
    expect(claveNombreProfesional("GUTIERREZ, NICOLAS", null)).toBe(base);
    expect(claveNombreProfesional("nicolas gutierrez", "")).toBe(base);
    expect(claveNombreProfesional("Gutierrez", "Nicolas")).toBe(base);
  });

  it("no colapsa nombres distintos", () => {
    expect(claveNombreProfesional("Juan", "Pérez")).not.toBe(
      claveNombreProfesional("Juana", "Pérez")
    );
  });
});

describe("analizarFila profesionales sin matrícula", () => {
  it("matchea por matrícula cuando existe", async () => {
    const r = await analizarFila("profesionales", {
      nombre: "Otro Nombre Cualquiera",
      matricula: `MAT-${RUN_ID}`,
    });
    expect(r).toMatchObject({ accion: "actualizar", entidadId: profConMatriculaId });
  });

  it("reimportación sin matrícula con tildes/mayúsculas distintas → actualizar, no crear", async () => {
    const r = await analizarFila("profesionales", {
      nombre: "NICOLAS",
      apellido: `GUTIERREZ DEDUP${RUN_ID.toUpperCase()}`,
    });
    expect(r).toMatchObject({ accion: "actualizar", entidadId: profSinMatriculaId });
  });

  it("reimportación con orden apellido/nombre invertido y coma → actualizar", async () => {
    const r = await analizarFila("profesionales", {
      nombre: `Gutiérrez Dedup${RUN_ID}, Nicolás`,
    });
    expect(r).toMatchObject({ accion: "actualizar", entidadId: profSinMatriculaId });
  });

  it("prefiere el registro activo sobre un duplicado desactivado", async () => {
    const [inactivo] = await db
      .insert(profesionalesTable)
      .values({ nombre: "Carlos", apellido: `Lopez Dedup${RUN_ID}`, activo: false })
      .returning();
    const [activo] = await db
      .insert(profesionalesTable)
      .values({ nombre: "Carlos", apellido: `López Dedup${RUN_ID}`, activo: true })
      .returning();
    profIds.push(inactivo!.id, activo!.id);
    invalidarIndiceNombresProfesionales();

    const r = await analizarFila("profesionales", {
      nombre: "CARLOS",
      apellido: `LOPEZ DEDUP${RUN_ID.toUpperCase()}`,
    });
    expect(r).toMatchObject({ accion: "actualizar", entidadId: activo!.id });
  });

  it("nombre realmente nuevo → crear", async () => {
    const r = await analizarFila("profesionales", {
      nombre: `Inexistente ${RUN_ID}`,
      apellido: "Nunca Importado",
    });
    expect(r).toMatchObject({ accion: "crear" });
  });
});
