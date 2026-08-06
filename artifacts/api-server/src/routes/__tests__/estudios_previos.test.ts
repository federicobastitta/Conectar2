/**
 * Tests de integración — Estudios previos aportados por el paciente.
 *
 * Cubre permisos (paciente solo su ficha, staff siempre, sin auth 401),
 * validación de formato/tamaño en upload-url y CRUD con soft delete.
 * En dev/test la tabla vive en DATABASE_URL (fallback de clinica-db).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import app from "../../app";
import request from "supertest";

const PACIENTE_EMAIL = "paciente@diagnosticar.ar";
const PACIENTE_PASS = "paciente123";
const MEDICO_EMAIL = "medico@diagnosticar.ar";
const MEDICO_PASS = "medico123";

// El seed asocia paciente@diagnosticar.ar a pacienteId 1
const PACIENTE_ID = 1;
const OTRO_PACIENTE_ID = 2;

let pacienteToken: string;
let medicoToken: string;
const estudiosCreados: number[] = [];

async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ email, password });
  expect(res.status).toBe(200);
  return res.body.token as string;
}

beforeAll(async () => {
  pacienteToken = await login(PACIENTE_EMAIL, PACIENTE_PASS);
  medicoToken = await login(MEDICO_EMAIL, MEDICO_PASS);
});

afterAll(async () => {
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
    tipo: "laboratorio",
    titulo: "Análisis de sangre (test)",
    objectPath: "/objects/uploads/test-estudio-previo",
    nombreArchivo: "analisis.pdf",
    contentType: "application/pdf",
    tamanoBytes: 1234,
    ...overrides,
  };
}

describe("Estudios previos — permisos", () => {
  it("rechaza sin token (401)", async () => {
    const res = await request(app).get(`/api/pacientes/${PACIENTE_ID}/estudios-previos`);
    expect(res.status).toBe(401);
  });

  it("el paciente no puede ver estudios de otro paciente (403)", async () => {
    const res = await request(app)
      .get(`/api/pacientes/${OTRO_PACIENTE_ID}/estudios-previos`)
      .set("Authorization", `Bearer ${pacienteToken}`);
    expect(res.status).toBe(403);
  });

  it("el paciente no puede subir a la ficha de otro paciente (403)", async () => {
    const res = await request(app)
      .post(`/api/pacientes/${OTRO_PACIENTE_ID}/estudios-previos`)
      .set("Authorization", `Bearer ${pacienteToken}`)
      .send(crearBody());
    expect(res.status).toBe(403);
  });

  it("el staff (médico) puede listar estudios de cualquier paciente", async () => {
    const res = await request(app)
      .get(`/api/pacientes/${OTRO_PACIENTE_ID}/estudios-previos`)
      .set("Authorization", `Bearer ${medicoToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe("Estudios previos — upload-url", () => {
  it("rechaza formatos no permitidos (400)", async () => {
    const res = await request(app)
      .post(`/api/pacientes/${PACIENTE_ID}/estudios-previos/upload-url`)
      .set("Authorization", `Bearer ${pacienteToken}`)
      .send({ name: "virus.exe", size: 100, contentType: "application/x-msdownload" });
    expect(res.status).toBe(400);
  });

  it("rechaza archivos de más de 20 MB (400)", async () => {
    const res = await request(app)
      .post(`/api/pacientes/${PACIENTE_ID}/estudios-previos/upload-url`)
      .set("Authorization", `Bearer ${pacienteToken}`)
      .send({ name: "grande.pdf", size: 25 * 1024 * 1024, contentType: "application/pdf" });
    expect(res.status).toBe(400);
  });
});

describe("Estudios previos — CRUD", () => {
  let estudioId: number;

  it("el paciente crea un estudio en su propia ficha (201)", async () => {
    const res = await request(app)
      .post(`/api/pacientes/${PACIENTE_ID}/estudios-previos`)
      .set("Authorization", `Bearer ${pacienteToken}`)
      .send(crearBody());
    expect(res.status).toBe(201);
    expect(res.body.titulo).toBe("Análisis de sangre (test)");
    expect(res.body.tipo).toBe("laboratorio");
    estudioId = res.body.id as number;
    estudiosCreados.push(estudioId);
  });

  it("rechaza objectPath fuera de /objects/ (400)", async () => {
    const res = await request(app)
      .post(`/api/pacientes/${PACIENTE_ID}/estudios-previos`)
      .set("Authorization", `Bearer ${pacienteToken}`)
      .send(crearBody({ objectPath: "https://evil.example.com/x" }));
    expect(res.status).toBe(400);
  });

  it("el paciente ve su estudio en la lista", async () => {
    const res = await request(app)
      .get(`/api/pacientes/${PACIENTE_ID}/estudios-previos`)
      .set("Authorization", `Bearer ${pacienteToken}`);
    expect(res.status).toBe(200);
    const ids = (res.body as { id: number }[]).map((e) => e.id);
    expect(ids).toContain(estudioId);
  });

  it("el médico ve el estudio en la ficha del paciente", async () => {
    const res = await request(app)
      .get(`/api/pacientes/${PACIENTE_ID}/estudios-previos`)
      .set("Authorization", `Bearer ${medicoToken}`);
    expect(res.status).toBe(200);
    const ids = (res.body as { id: number }[]).map((e) => e.id);
    expect(ids).toContain(estudioId);
  });

  it("el paciente no puede borrar estudios de otro paciente (403)", async () => {
    const res = await request(app)
      .delete(`/api/pacientes/${OTRO_PACIENTE_ID}/estudios-previos/${estudioId}`)
      .set("Authorization", `Bearer ${pacienteToken}`);
    expect(res.status).toBe(403);
  });

  it("el paciente elimina su propio estudio (204) y desaparece de la lista", async () => {
    const res = await request(app)
      .delete(`/api/pacientes/${PACIENTE_ID}/estudios-previos/${estudioId}`)
      .set("Authorization", `Bearer ${pacienteToken}`);
    expect(res.status).toBe(204);

    const lista = await request(app)
      .get(`/api/pacientes/${PACIENTE_ID}/estudios-previos`)
      .set("Authorization", `Bearer ${pacienteToken}`);
    const ids = (lista.body as { id: number }[]).map((e) => e.id);
    expect(ids).not.toContain(estudioId);
  });

  it("descargar archivo de un estudio inexistente devuelve 404", async () => {
    const res = await request(app)
      .get(`/api/pacientes/${PACIENTE_ID}/estudios-previos/999999/archivo`)
      .set("Authorization", `Bearer ${medicoToken}`);
    expect(res.status).toBe(404);
  });
});
