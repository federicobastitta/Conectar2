/**
 * Tests de integración — POST /api/pacs/worklist/resync/:turnoId
 * Verifica: admin permitido, no-admin 403, turnoId inválido 400,
 * turnoId inexistente/sin PACS 404.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import app from "../../app";
import request from "supertest";
import { hashPassword } from "../auth";

const RUN_ID = crypto.randomBytes(6).toString("hex");
const EMAIL_ADMIN = `wl-resync-admin-${RUN_ID}@conectar-test.ar`;
const EMAIL_RECEP = `wl-resync-recep-${RUN_ID}@conectar-test.ar`;
const PASS = "wl-resync-pass-123";

let adminId: number;
let recepId: number;
let prevWorklistEnabled: string | undefined;

beforeAll(async () => {
  prevWorklistEnabled = process.env.PACS_WORKLIST_ENABLED;
  process.env.PACS_WORKLIST_ENABLED = "true";

  await db.delete(usersTable).where(eq(usersTable.email, EMAIL_ADMIN));
  await db.delete(usersTable).where(eq(usersTable.email, EMAIL_RECEP));

  const [admin] = await db
    .insert(usersTable)
    .values({
      email: EMAIL_ADMIN,
      passwordHash: hashPassword(PASS),
      nombre: "Test WL Resync Admin",
      rol: "admin",
      activo: "true",
    })
    .returning({ id: usersTable.id });
  adminId = admin.id;

  const [recep] = await db
    .insert(usersTable)
    .values({
      email: EMAIL_RECEP,
      passwordHash: hashPassword(PASS),
      nombre: "Test WL Resync Recep",
      rol: "recepcionista",
      activo: "true",
    })
    .returning({ id: usersTable.id });
  recepId = recep.id;
});

afterAll(async () => {
  if (prevWorklistEnabled === undefined) {
    delete process.env.PACS_WORKLIST_ENABLED;
  } else {
    process.env.PACS_WORKLIST_ENABLED = prevWorklistEnabled;
  }
  await db.delete(usersTable).where(eq(usersTable.id, adminId));
  await db.delete(usersTable).where(eq(usersTable.id, recepId));
});

const RUTA = (id: number | string) => `/api/pacs/worklist/resync/${id}`;

describe("POST /pacs/worklist/resync/:turnoId — autorización y validación", () => {
  it("rechaza sin token (401)", async () => {
    const res = await request(app).post(RUTA(1));
    expect(res.status).toBe(401);
  });

  it("rechaza a no-admin (403)", async () => {
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: EMAIL_RECEP, password: PASS });
    expect(login.status).toBe(200);
    const res = await request(app)
      .post(RUTA(1))
      .set("Authorization", `Bearer ${login.body.token}`);
    expect(res.status).toBe(403);
  });

  it("rechaza turnoId no numérico (400)", async () => {
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: EMAIL_ADMIN, password: PASS });
    expect(login.status).toBe(200);
    const res = await request(app)
      .post(RUTA("abc"))
      .set("Authorization", `Bearer ${login.body.token}`);
    expect(res.status).toBe(400);
  });

  it("admin con turnoId inexistente recibe 404", async () => {
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: EMAIL_ADMIN, password: PASS });
    expect(login.status).toBe(200);
    const res = await request(app)
      .post(RUTA(999999999))
      .set("Authorization", `Bearer ${login.body.token}`);
    // admin pasa la guarda de auth; el turno no existe → 404
    expect(res.status).toBe(404);
  });
});
