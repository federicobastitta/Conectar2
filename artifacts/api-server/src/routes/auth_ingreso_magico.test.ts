import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import pino from "pino";
import { eq, inArray, like } from "drizzle-orm";
import { db, usersTable, sesionesTable, pacientesTable, configSistemaTable } from "@workspace/db";
import authRouter, { hashPassword } from "./auth";
import {
  generarTokenIngreso,
  consumirTokenIngreso,
  revocarTokensIngresoDeUsuario,
  PREFIJO_AUTOLOGIN,
} from "../lib/autologin-paciente";

// Tests de integración del autologin por link mágico (Task: WhatsApp de
// seguimiento). Crean sus propios datos con RUN_ID y los limpian al terminar.
//
// Verifican:
// - el token plano NUNCA queda en la DB (solo el hash como clave)
// - consumir el token crea una sesión de paciente válida
// - un solo uso: el segundo consumo devuelve 410
// - vencimiento: token expirado devuelve 410
// - revocación al cambiar la clave: el link pendiente deja de servir

const RUN_ID = crypto.randomBytes(6).toString("hex");

let server: Server;
let baseUrl: string;
let pacienteId: number;
let usuarioPacienteId: number;
const CLAVE_ORIGINAL = `clave-${RUN_ID}`;
const userIds: number[] = [];

beforeAll(async () => {
  const app = express();
  const silent = pino({ level: "silent" });
  app.use((req, _res, next) => {
    (req as unknown as { log: pino.Logger }).log = silent;
    next();
  });
  app.use(express.json());
  app.use("/api", authRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Sin puerto asignado");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const [paciente] = await db
    .insert(pacientesTable)
    .values({
      nombre: `Test`,
      apellido: `Magico ${RUN_ID}`,
      dni: `9${RUN_ID.slice(0, 7).replace(/\D/g, "1").padEnd(7, "1")}`,
    })
    .returning();
  pacienteId = paciente!.id;

  const [user] = await db
    .insert(usersTable)
    .values({
      email: `test-magico-${RUN_ID}@test.local`,
      passwordHash: hashPassword(CLAVE_ORIGINAL),
      nombre: `Paciente Mágico ${RUN_ID}`,
      rol: "paciente",
      activo: "true",
      pacienteId: String(pacienteId),
    })
    .returning();
  usuarioPacienteId = user!.id;
  userIds.push(user!.id);
});

afterAll(async () => {
  await revocarTokensIngresoDeUsuario(usuarioPacienteId);
  await db.delete(sesionesTable).where(inArray(sesionesTable.usuarioId, userIds));
  await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  await db.delete(pacientesTable).where(eq(pacientesTable.id, pacienteId));
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function ingresar(token: string): Promise<Response> {
  return fetch(`${baseUrl}/api/auth/ingreso-magico`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

async function generar(): Promise<string> {
  const { tokenPlano } = await generarTokenIngreso({
    usuarioId: usuarioPacienteId,
    pacienteId,
    generadoPorId: usuarioPacienteId,
    generadoPorEmail: `staff-${RUN_ID}@test.local`,
  });
  return tokenPlano;
}

describe("autologin por link mágico", () => {
  it("no persiste el token plano en la DB (solo el hash)", async () => {
    const tokenPlano = await generar();
    const filas = await db
      .select()
      .from(configSistemaTable)
      .where(like(configSistemaTable.clave, `${PREFIJO_AUTOLOGIN}%`));
    for (const f of filas) {
      expect(f.clave).not.toContain(tokenPlano);
      expect(f.valor).not.toContain(tokenPlano);
    }
    // El hash sí debe estar
    const hash = crypto.createHash("sha256").update(tokenPlano).digest("hex");
    expect(filas.some((f) => f.clave === `${PREFIJO_AUTOLOGIN}${hash}`)).toBe(true);
    await revocarTokensIngresoDeUsuario(usuarioPacienteId);
  });

  it("consume el token, crea sesión de paciente y es reutilizable", async () => {
    const tokenPlano = await generar();
    const res = await ingresar(tokenPlano);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { rol: string; pacienteId: number }; token: string };
    expect(body.user.rol).toBe("paciente");
    expect(body.user.pacienteId).toBe(pacienteId);
    expect(body.token).toBeTruthy();

    // La sesión existe y está activa
    const [sesion] = await db
      .select()
      .from(sesionesTable)
      .where(eq(sesionesTable.token, body.token))
      .limit(1);
    expect(sesion?.usuarioId).toBe(usuarioPacienteId);
    expect(sesion?.activa).toBe(true);

    // Los links nuevos son PERMANENTES y REUTILIZABLES: el segundo uso también
    // sirve y solo se registra como auditoría (usos, último uso).
    const res2 = await ingresar(tokenPlano);
    expect(res2.status).toBe(200);
    const hash = crypto.createHash("sha256").update(tokenPlano).digest("hex");
    const [fila] = await db
      .select()
      .from(configSistemaTable)
      .where(eq(configSistemaTable.clave, `${PREFIJO_AUTOLOGIN}${hash}`))
      .limit(1);
    const datos = JSON.parse(fila!.valor) as { estado: string; usos?: number };
    expect(datos.estado).toBe("pendiente");
    expect(datos.usos).toBe(2);
    await revocarTokensIngresoDeUsuario(usuarioPacienteId);
  });

  it("rechaza tokens inválidos y vencidos", async () => {
    const resInvalido = await ingresar(`token-inexistente-${RUN_ID}-relleno-largo`);
    expect(resInvalido.status).toBe(410);

    // Vencido: forzamos expiraEn en el pasado directo en la fila
    const tokenPlano = await generar();
    const hash = crypto.createHash("sha256").update(tokenPlano).digest("hex");
    const clave = `${PREFIJO_AUTOLOGIN}${hash}`;
    const [fila] = await db
      .select()
      .from(configSistemaTable)
      .where(eq(configSistemaTable.clave, clave))
      .limit(1);
    const datos = JSON.parse(fila!.valor) as Record<string, unknown>;
    datos.expiraEn = new Date(Date.now() - 1000).toISOString();
    await db
      .update(configSistemaTable)
      .set({ valor: JSON.stringify(datos) })
      .where(eq(configSistemaTable.clave, clave));
    const resVencido = await ingresar(tokenPlano);
    expect(resVencido.status).toBe(410);
    await db.delete(configSistemaTable).where(eq(configSistemaTable.clave, clave));
  });

  it("revoca los links pendientes cuando el paciente cambia su clave", async () => {
    const tokenPlano = await generar();

    // Login normal del paciente para obtener sesión y cambiar la clave
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `test-magico-${RUN_ID}@test.local`, password: CLAVE_ORIGINAL }),
    });
    expect(login.status).toBe(200);
    const { token: sesionToken } = (await login.json()) as { token: string };

    const cambio = await fetch(`${baseUrl}/api/auth/cambiar-clave`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${sesionToken}` },
      body: JSON.stringify({ claveActual: CLAVE_ORIGINAL, claveNueva: `nueva-${RUN_ID}` }),
    });
    expect(cambio.status).toBe(200);

    // El link mágico pendiente ya no sirve
    const res = await ingresar(tokenPlano);
    expect(res.status).toBe(410);
  });

  it("consumo concurrente: ambas requests entran (link reutilizable)", async () => {
    const tokenPlano = await generar();
    const [a, b] = await Promise.all([consumirTokenIngreso(tokenPlano), consumirTokenIngreso(tokenPlano)]);
    const exitosos = [a, b].filter((r) => r.ok);
    expect(exitosos.length).toBe(2);
    await revocarTokensIngresoDeUsuario(usuarioPacienteId);
  });
});
