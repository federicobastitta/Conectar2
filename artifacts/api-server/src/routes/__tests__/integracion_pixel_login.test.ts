/**
 * Tests de integración — Validación de credenciales de Conectar para Pixel
 * (PACS). Autenticada con x-api-key contra PACS_API_TOKEN.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import app from "../../app";
import request from "supertest";
import { hashPassword } from "../auth";

const CLAVE_TEST = "clave-test-pixel-login";
let claveAnterior: string | undefined;
const EMAIL_TEST = "pixel-login-test@conectar-test.ar";
const PASS_TEST = "pixel-pass-123";
let userIdTest: number;

beforeAll(async () => {
  claveAnterior = process.env.PACS_API_TOKEN;
  process.env.PACS_API_TOKEN = CLAVE_TEST;

  await db.delete(usersTable).where(eq(usersTable.email, EMAIL_TEST));
  const [u] = await db
    .insert(usersTable)
    .values({
      email: EMAIL_TEST,
      passwordHash: hashPassword(PASS_TEST),
      nombre: "Test Pixel Login",
      rol: "medico",
      activo: "true",
    })
    .returning({ id: usersTable.id });
  userIdTest = u.id;
});

afterAll(async () => {
  if (claveAnterior === undefined) delete process.env.PACS_API_TOKEN;
  else process.env.PACS_API_TOKEN = claveAnterior;
  await db.delete(usersTable).where(eq(usersTable.id, userIdTest));
});

const RUTA = "/api/integraciones/pixel/validar-credenciales";

describe("Integración Pixel login — auth por API key", () => {
  it("rechaza sin x-api-key (401)", async () => {
    const res = await request(app).post(RUTA).send({ usuario: EMAIL_TEST, password: PASS_TEST });
    expect(res.status).toBe(401);
  });

  it("rechaza con x-api-key inválida (401)", async () => {
    const res = await request(app)
      .post(RUTA)
      .set("x-api-key", "clave-incorrecta")
      .send({ usuario: EMAIL_TEST, password: PASS_TEST });
    expect(res.status).toBe(401);
  });
});

describe("Integración Pixel login — validación de credenciales", () => {
  it("valida usuario por mail completo (200)", async () => {
    const res = await request(app)
      .post(RUTA)
      .set("x-api-key", CLAVE_TEST)
      .send({ usuario: EMAIL_TEST, password: PASS_TEST });
    expect(res.status).toBe(200);
    expect(res.body.valido).toBe(true);
    expect(res.body.usuario.email).toBe(EMAIL_TEST);
    expect(res.body.usuario.rol).toBe("medico");
    expect(res.body.usuario).not.toHaveProperty("passwordHash");
  });

  it("valida usuario por la parte antes de la @ (200)", async () => {
    const res = await request(app)
      .post(RUTA)
      .set("x-api-key", CLAVE_TEST)
      .send({ usuario: "pixel-login-test", password: PASS_TEST });
    expect(res.status).toBe(200);
    expect(res.body.valido).toBe(true);
    expect(res.body.usuario.id).toBe(userIdTest);
  });

  it("rechaza contraseña incorrecta (401)", async () => {
    const res = await request(app)
      .post(RUTA)
      .set("x-api-key", CLAVE_TEST)
      .send({ usuario: EMAIL_TEST, password: "otra-clave" });
    expect(res.status).toBe(401);
    expect(res.body.valido).toBe(false);
  });

  it("rechaza usuario inexistente (401)", async () => {
    const res = await request(app)
      .post(RUTA)
      .set("x-api-key", CLAVE_TEST)
      .send({ usuario: "no-existe@conectar-test.ar", password: PASS_TEST });
    expect(res.status).toBe(401);
  });

  it("rechaza usuario deshabilitado (401)", async () => {
    await db.update(usersTable).set({ activo: "false" }).where(eq(usersTable.id, userIdTest));
    const res = await request(app)
      .post(RUTA)
      .set("x-api-key", CLAVE_TEST)
      .send({ usuario: EMAIL_TEST, password: PASS_TEST });
    expect(res.status).toBe(401);
    await db.update(usersTable).set({ activo: "true" }).where(eq(usersTable.id, userIdTest));
  });

  it("rechaza cuentas de pacientes (401)", async () => {
    await db.update(usersTable).set({ rol: "paciente" }).where(eq(usersTable.id, userIdTest));
    const res = await request(app)
      .post(RUTA)
      .set("x-api-key", CLAVE_TEST)
      .send({ usuario: EMAIL_TEST, password: PASS_TEST });
    expect(res.status).toBe(401);
    await db.update(usersTable).set({ rol: "medico" }).where(eq(usersTable.id, userIdTest));
  });
});
