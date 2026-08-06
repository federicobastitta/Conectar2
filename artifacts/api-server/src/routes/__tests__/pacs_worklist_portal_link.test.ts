/**
 * Tests de integración — GET /api/pacs/worklist-portal-link
 * Solo verifica las garantías de autorización (401/403); el caso 200 llama
 * al PACS externo real y no se prueba acá.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import app from "../../app";
import request from "supertest";
import { hashPassword } from "../auth";

const EMAIL_PACIENTE = "wl-portal-paciente@conectar-test.ar";
const PASS = "wl-pass-123";
let pacienteUserId: number;

beforeAll(async () => {
  await db.delete(usersTable).where(eq(usersTable.email, EMAIL_PACIENTE));
  const [u] = await db
    .insert(usersTable)
    .values({
      email: EMAIL_PACIENTE,
      passwordHash: hashPassword(PASS),
      nombre: "Test WL Portal Paciente",
      rol: "paciente",
      activo: "true",
    })
    .returning({ id: usersTable.id });
  pacienteUserId = u.id;
});

afterAll(async () => {
  await db.delete(usersTable).where(eq(usersTable.id, pacienteUserId));
});

const RUTA = "/api/pacs/worklist-portal-link";

describe("GET /pacs/worklist-portal-link — autorización", () => {
  it("rechaza sin token (401)", async () => {
    const res = await request(app).get(RUTA);
    expect(res.status).toBe(401);
  });

  it("rechaza con token inválido (401)", async () => {
    const res = await request(app).get(RUTA).set("Authorization", "Bearer token-falso");
    expect(res.status).toBe(401);
  });

  it("rechaza a un paciente (403)", async () => {
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: EMAIL_PACIENTE, password: PASS });
    expect(login.status).toBe(200);
    const res = await request(app).get(RUTA).set("Authorization", `Bearer ${login.body.token}`);
    expect(res.status).toBe(403);
  });
});
