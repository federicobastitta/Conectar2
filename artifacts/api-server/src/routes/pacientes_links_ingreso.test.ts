import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import pino from "pino";
import { eq, inArray, like, and } from "drizzle-orm";
import {
  db,
  usersTable,
  sesionesTable,
  pacientesTable,
  configSistemaTable,
  auditoriaPacientesTable,
} from "@workspace/db";
import pacientesRouter from "./pacientes";
import {
  generarTokenIngreso,
  consumirTokenIngreso,
  PREFIJO_AUTOLOGIN,
} from "../lib/autologin-paciente";

// Task 224: anular el link permanente de un paciente si se filtra.
// Verifican:
// - gestión (rol admin) puede listar los links vigentes con creación/usos
// - anular borra las filas autologin_paciente_* y el token deja de servir
// - queda auditoría de quién anuló
// - recepcionista/médico NO pueden ver ni anular (403)

const RUN_ID = crypto.randomBytes(6).toString("hex");

let server: Server;
let baseUrl: string;
let pacienteId: number;
let otroPacienteId: number;

const TOKEN_ADMIN = `test-token-links-adm-${RUN_ID}`;
const TOKEN_RECEP = `test-token-links-rec-${RUN_ID}`;
let adminId: number;
const userIds: number[] = [];

async function crearUsuarioConSesion(rol: string, token: string): Promise<number> {
  const [user] = await db
    .insert(usersTable)
    .values({
      email: `test-links-${rol}-${crypto.randomBytes(4).toString("hex")}-${RUN_ID}@test.local`,
      passwordHash: "irrelevante",
      nombre: `Test links ${rol}`,
      rol,
    })
    .returning();
  userIds.push(user!.id);
  await db.insert(sesionesTable).values({
    token,
    usuarioId: user!.id,
    activa: true,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return user!.id;
}

function req(method: string, path: string, token?: string): Promise<Response> {
  return fetch(`${baseUrl}/api${path}`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

async function generar(paraPacienteId: number): Promise<string> {
  const { tokenPlano } = await generarTokenIngreso({
    usuarioId: null,
    pacienteId: paraPacienteId,
    generadoPorId: adminId,
    generadoPorEmail: `test-links-gen-${RUN_ID}@test.local`,
  });
  return tokenPlano;
}

beforeAll(async () => {
  const app = express();
  const silent = pino({ level: "silent" });
  app.use((r, _res, next) => {
    (r as unknown as { log: pino.Logger }).log = silent;
    next();
  });
  app.use(express.json());
  app.use("/api", pacientesRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Sin puerto asignado");
  baseUrl = `http://127.0.0.1:${address.port}`;

  adminId = await crearUsuarioConSesion("admin", TOKEN_ADMIN);
  await crearUsuarioConSesion("recepcionista", TOKEN_RECEP);

  const [p1] = await db
    .insert(pacientesTable)
    .values({ nombre: "Test", apellido: `Links ${RUN_ID}`, dni: `8${RUN_ID.slice(0, 7).replace(/\D/g, "2").padEnd(7, "2")}` })
    .returning();
  pacienteId = p1!.id;
  const [p2] = await db
    .insert(pacientesTable)
    .values({ nombre: "Test", apellido: `LinksOtro ${RUN_ID}`, dni: `7${RUN_ID.slice(0, 7).replace(/\D/g, "3").padEnd(7, "3")}` })
    .returning();
  otroPacienteId = p2!.id;
});

afterAll(async () => {
  // Limpiar cualquier link residual de los pacientes de prueba
  const filas = await db
    .select()
    .from(configSistemaTable)
    .where(like(configSistemaTable.clave, `${PREFIJO_AUTOLOGIN}%`));
  for (const f of filas) {
    if (f.valor.includes(`"pacienteId":${pacienteId}`) || f.valor.includes(`"pacienteId":${otroPacienteId}`)) {
      await db.delete(configSistemaTable).where(eq(configSistemaTable.clave, f.clave));
    }
  }
  await db
    .delete(auditoriaPacientesTable)
    .where(inArray(auditoriaPacientesTable.pacienteId, [pacienteId, otroPacienteId]));
  await db.delete(pacientesTable).where(inArray(pacientesTable.id, [pacienteId, otroPacienteId]));
  await db.delete(sesionesTable).where(inArray(sesionesTable.usuarioId, userIds));
  await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("links de ingreso del paciente (listar y anular)", () => {
  it("gestión ve los links vigentes con creación y usos", async () => {
    const tokenPlano = await generar(pacienteId);
    // Un uso para que quede registrado
    const consumo = await consumirTokenIngreso(tokenPlano);
    expect(consumo.ok).toBe(true);

    const res = await req("GET", `/pacientes/${pacienteId}/links-ingreso`, TOKEN_ADMIN);
    expect(res.status).toBe(200);
    const links = (await res.json()) as Array<{ creadoEn: string; usos: number; generadoPorEmail: string }>;
    expect(links.length).toBe(1);
    expect(links[0]!.usos).toBe(1);
    expect(links[0]!.creadoEn).toBeTruthy();
    expect(links[0]!.generadoPorEmail).toContain(RUN_ID);
  });

  it("anular borra la fila, el token deja de servir y queda auditoría", async () => {
    const tokenPlano = await generar(pacienteId);

    const res = await req("DELETE", `/pacientes/${pacienteId}/links-ingreso`, TOKEN_ADMIN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revocados: number };
    expect(body.revocados).toBeGreaterThanOrEqual(1);

    // El token anulado ya no sirve
    const consumo = await consumirTokenIngreso(tokenPlano);
    expect(consumo).toEqual({ ok: false, motivo: "invalido" });

    // No quedan links vigentes
    const res2 = await req("GET", `/pacientes/${pacienteId}/links-ingreso`, TOKEN_ADMIN);
    expect(((await res2.json()) as unknown[]).length).toBe(0);

    // Auditoría de quién anuló
    const audit = await db
      .select()
      .from(auditoriaPacientesTable)
      .where(
        and(
          eq(auditoriaPacientesTable.pacienteId, pacienteId),
          eq(auditoriaPacientesTable.accion, "LINKS_INGRESO_ANULADOS"),
        ),
      );
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0]!.usuarioId).toBe(adminId);
  });

  it("no toca links de otros pacientes al anular", async () => {
    const tokenOtro = await generar(otroPacienteId);
    const res = await req("DELETE", `/pacientes/${pacienteId}/links-ingreso`, TOKEN_ADMIN);
    expect(res.status).toBe(200);
    const consumo = await consumirTokenIngreso(tokenOtro);
    expect(consumo.ok).toBe(true);
  });

  it("recepcionista no puede ver ni anular (403)", async () => {
    const resGet = await req("GET", `/pacientes/${pacienteId}/links-ingreso`, TOKEN_RECEP);
    expect(resGet.status).toBe(403);
    const resDel = await req("DELETE", `/pacientes/${pacienteId}/links-ingreso`, TOKEN_RECEP);
    expect(resDel.status).toBe(403);
  });
});
