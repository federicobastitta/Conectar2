/**
 * Tests de integración — Subida de estudios previos servidor a servidor
 * (integración Mi Diagnosticar), autenticada con x-api-key contra
 * ESTUDIOS_PREVIOS_API_KEY. Paciente identificado por DNI.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db, pacientesTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import app from "../../app";
import request from "supertest";

const CLAVE_TEST = "clave-test-estudios-previos";
let claveAnterior: string | undefined;
let dniPaciente: string;
const estudiosCreados: number[] = [];

beforeAll(async () => {
  claveAnterior = process.env.ESTUDIOS_PREVIOS_API_KEY;
  process.env.ESTUDIOS_PREVIOS_API_KEY = CLAVE_TEST;

  // El seed asocia paciente@diagnosticar.ar a pacienteId 1
  const [pac] = await db
    .select({ dni: pacientesTable.dni })
    .from(pacientesTable)
    .where(eq(pacientesTable.id, 1))
    .limit(1);
  expect(pac?.dni).toBeTruthy();
  dniPaciente = pac!.dni!.trim();
});

afterAll(async () => {
  if (claveAnterior === undefined) delete process.env.ESTUDIOS_PREVIOS_API_KEY;
  else process.env.ESTUDIOS_PREVIOS_API_KEY = claveAnterior;

  if (estudiosCreados.length > 0) {
    await db.execute(
      sql`DELETE FROM estudios_previos_paciente WHERE id IN (${sql.join(
        estudiosCreados.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    );
  }
});

function crearBody(overrides: Record<string, unknown> = {}) {
  return {
    dni: dniPaciente,
    tipo: "informe",
    titulo: "Informe externo (test integración)",
    objectPath: "/objects/uploads/test-integracion-estudio",
    nombreArchivo: "informe.pdf",
    contentType: "application/pdf",
    tamanoBytes: 2048,
    ...overrides,
  };
}

describe("Integración estudios previos — auth", () => {
  it("rechaza sin x-api-key (401)", async () => {
    const res = await request(app).post("/api/integraciones/estudios-previos").send(crearBody());
    expect(res.status).toBe(401);
  });

  it("rechaza con x-api-key inválida (401)", async () => {
    const res = await request(app)
      .post("/api/integraciones/estudios-previos")
      .set("x-api-key", "clave-incorrecta")
      .send(crearBody());
    expect(res.status).toBe(401);
  });
});

describe("Integración estudios previos — validación y alta", () => {
  it("rechaza DNI inexistente (404)", async () => {
    const res = await request(app)
      .post("/api/integraciones/estudios-previos")
      .set("x-api-key", CLAVE_TEST)
      .send(crearBody({ dni: "999999999" }));
    expect(res.status).toBe(404);
  });

  it("rechaza tipo inválido (400)", async () => {
    const res = await request(app)
      .post("/api/integraciones/estudios-previos")
      .set("x-api-key", CLAVE_TEST)
      .send(crearBody({ tipo: "radiografia" }));
    expect(res.status).toBe(400);
  });

  it("rechaza objectPath fuera de /objects/ (400)", async () => {
    const res = await request(app)
      .post("/api/integraciones/estudios-previos")
      .set("x-api-key", CLAVE_TEST)
      .send(crearBody({ objectPath: "/etc/passwd" }));
    expect(res.status).toBe(400);
  });

  it("crea el estudio por DNI y queda visible en la ficha del paciente (201)", async () => {
    const res = await request(app)
      .post("/api/integraciones/estudios-previos")
      .set("x-api-key", CLAVE_TEST)
      .send(crearBody());
    expect(res.status).toBe(201);
    expect(res.body.pacienteId).toBe(1);
    estudiosCreados.push(res.body.id);

    // Visible vía el endpoint de la ficha (login médico)
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: "medico@diagnosticar.ar", password: "medico123" });
    expect(login.status).toBe(200);
    const lista = await request(app)
      .get("/api/pacientes/1/estudios-previos")
      .set("Authorization", `Bearer ${login.body.token}`);
    expect(lista.status).toBe(200);
    const encontrado = lista.body.find((e: { id: number }) => e.id === res.body.id);
    expect(encontrado).toBeTruthy();
    expect(encontrado.subidoPorRol).toBe("integracion-diagnosticar");
  });
});
