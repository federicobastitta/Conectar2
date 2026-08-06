import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import pino from "pino";
import { eq, and } from "drizzle-orm";
import {
  db,
  usersTable,
  sesionesTable,
  pacientesTable,
  turnerasTable,
  turnosTable,
  auditLogTable,
  klinicosTrabajos,
  documentacionRecepcionTable,
  configSistemaTable,
} from "@workspace/db";
import recepcionRouter, { CLAVE_SUPERVISOR_TOTP } from "./recepcion";
import salaEsperaRouter from "./sala_espera";
import { hoyArgentina } from "../lib/tiempo";
import { generarSecretoTotp, codigoTotp } from "../lib/totp";

// Tests de integración del flujo "Recepcionar Paciente" contra la DB de
// desarrollo. Crean sus propios datos y los limpian al terminar.

const RUN_ID = crypto.randomBytes(6).toString("hex");
const TEST_EMAIL = `test-recepcion-${RUN_ID}@test.local`;
const TEST_DNI = `R${RUN_ID}`;
const TOKEN = `test-token-recepcion-${RUN_ID}`;

let server: Server;
let baseUrl: string;
let userId: number;
let pacienteId: number;
let turneraId: number;
let turnoId: number;

beforeAll(async () => {
  const app = express();
  const silent = pino({ level: "silent" });
  app.use((req, _res, next) => {
    (req as unknown as { log: pino.Logger }).log = silent;
    next();
  });
  app.use(express.json({ limit: "10mb" }));
  app.use("/api", recepcionRouter);
  app.use("/api", salaEsperaRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Sin puerto asignado");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const [user] = await db
    .insert(usersTable)
    .values({
      email: TEST_EMAIL,
      passwordHash: "irrelevante",
      nombre: "Test Recepción",
      rol: "recepcionista",
    })
    .returning();
  userId = user!.id;

  await db.insert(sesionesTable).values({
    token: TOKEN,
    usuarioId: userId,
    activa: true,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });

  const [paciente] = await db
    .insert(pacientesTable)
    .values({
      nombre: "Carlos",
      apellido: `RecepTest${RUN_ID}`,
      dni: TEST_DNI,
      activo: true,
    })
    .returning();
  pacienteId = paciente!.id;

  const [turnera] = await db
    .insert(turnerasTable)
    .values({ nombre: `Turnera Recep Test ${RUN_ID}` })
    .returning();
  turneraId = turnera!.id;

  const [turno] = await db
    .insert(turnosTable)
    .values({
      turneraId,
      pacienteId,
      fecha: hoyArgentina(),
      horaInicio: "07:00",
      horaFin: "07:30",
      estado: "pendiente",
    })
    .returning();
  turnoId = turno!.id;
});

afterAll(async () => {
  await db.delete(auditLogTable).where(eq(auditLogTable.usuarioId, userId));
  await db
    .delete(documentacionRecepcionTable)
    .where(eq(documentacionRecepcionTable.pacienteId, pacienteId));
  // El hook de admitir encola el trabajo Klinicos en segundo plano (fire and
  // forget), así que puede aparecer DESPUÉS de que arranque la limpieza:
  // borrar trabajos + turnos con reintento hasta que no queden referencias.
  for (let intento = 0; intento < 10; intento++) {
    await db.delete(klinicosTrabajos).where(eq(klinicosTrabajos.pacienteId, pacienteId));
    await db.delete(klinicosTrabajos).where(eq(klinicosTrabajos.turnoId, turnoId));
    try {
      await db.delete(turnosTable).where(eq(turnosTable.pacienteId, pacienteId));
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  await db.delete(turnerasTable).where(eq(turnerasTable.id, turneraId));
  await db.delete(pacientesTable).where(eq(pacientesTable.id, pacienteId));
  await db.delete(sesionesTable).where(eq(sesionesTable.token, TOKEN));
  await db.delete(usersTable).where(eq(usersTable.id, userId));
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

function get(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
}

function put(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("flujo Recepcionar Paciente", () => {
  it("requiere autenticación", async () => {
    const res = await fetch(`${baseUrl}/api/recepcion/turnos-dia`);
    expect(res.status).toBe(401);
  });

  it("turnos-dia lista el turno del día con semáforo rojo sin documentación", async () => {
    const res = await get("/api/recepcion/turnos-dia");
    expect(res.status).toBe(200);
    const filas = (await res.json()) as Array<{
      turnoId: number;
      estado: string;
      semaforo: { color: string; faltantes: string[] };
    }>;
    const fila = filas.find((f) => f.turnoId === turnoId);
    expect(fila).toBeDefined();
    expect(fila!.estado).toBe("pendiente");
    expect(fila!.semaforo.color).toBe("rojo");
    // El semáforo documental solo considera la orden médica (jul 2026)
    expect(fila!.semaforo.faltantes).toContain("orden_medica");
    expect(fila!.semaforo.faltantes).not.toContain("dni");
  });

  it("la ficha del turno trae paciente y semáforo", async () => {
    const res = await get(`/api/recepcion/turnos/${turnoId}/ficha`);
    expect(res.status).toBe(200);
    const ficha = (await res.json()) as {
      paciente: { id: number; dni: string };
      semaforo: { color: string };
    };
    expect(ficha.paciente.id).toBe(pacienteId);
    expect(ficha.paciente.dni).toBe(TEST_DNI);
    expect(ficha.semaforo.color).toBe("rojo");
  });

  it("no permite marcar documentación crítica como no_aplica", async () => {
    const res = await put(`/api/recepcion/pacientes/${pacienteId}/documentacion/orden_medica`, {
      estado: "no_aplica",
    });
    expect(res.status).toBe(400);
  });

  it("validar toda la documentación pasa el semáforo a verde", async () => {
    for (const tipo of ["dni", "credencial", "orden_medica", "autorizacion"]) {
      const res = await put(`/api/recepcion/pacientes/${pacienteId}/documentacion/${tipo}`, {
        estado: "validada",
      });
      expect(res.status).toBe(200);
    }
    const res = await get(`/api/recepcion/turnos/${turnoId}/ficha`);
    const ficha = (await res.json()) as { semaforo: { color: string; faltantes: string[] } };
    expect(ficha.semaforo.color).toBe("verde");
    expect(ficha.semaforo.faltantes).toEqual([]);
  });

  it("recepcionar (admitir) pasa el turno a arribo", async () => {
    const res = await fetch(`${baseUrl}/api/turnos/${turnoId}/admitir`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const turno = (await res.json()) as { id: number; estado: string };
    expect(turno.id).toBe(turnoId);
    expect(turno.estado).toBe("arribo");

    const [enDb] = await db.select().from(turnosTable).where(eq(turnosTable.id, turnoId));
    expect(enDb!.estado).toBe("arribo");

    // La auditoría de admitir debe incluir el snapshot de documentación validada
    const [registro] = await db
      .select()
      .from(auditLogTable)
      .where(and(eq(auditLogTable.usuarioId, userId), eq(auditLogTable.accion, "admitir")));
    expect(registro).toBeDefined();
    const detalle = registro!.detalle as {
      documentacionValidada?: Array<{ tipo: string; estado: string }>;
    };
    expect(detalle.documentacionValidada).toBeDefined();
    const porTipo = new Map(detalle.documentacionValidada!.map((d) => [d.tipo, d.estado]));
    expect(porTipo.get("dni")).toBe("validada");
    expect(porTipo.get("orden_medica")).toBe("validada");
  });
});

// ── Código de supervisor (TOTP) para recepcionar sin token ──────────────
describe("código de supervisor al recepcionar consulta sin token", () => {
  let secreto: string;
  let secretoAnterior: string | null = null;
  let turnoConsultaId: number;
  let turneraConsultaId: number;

  beforeAll(async () => {
    // Guardar el secreto que hubiera en la DB de dev para restaurarlo al final
    const [previo] = await db
      .select({ valor: configSistemaTable.valor })
      .from(configSistemaTable)
      .where(eq(configSistemaTable.clave, CLAVE_SUPERVISOR_TOTP));
    secretoAnterior = previo?.valor ?? null;

    secreto = generarSecretoTotp();
    await db
      .insert(configSistemaTable)
      .values({ clave: CLAVE_SUPERVISOR_TOTP, valor: secreto })
      .onConflictDoUpdate({ target: configSistemaTable.clave, set: { valor: secreto } });
    // Resetear el anti-replay para que el código de esta corrida sea aceptado
    await db.delete(configSistemaTable).where(eq(configSistemaTable.clave, "supervisor_totp_ultimo_paso"));

    // Turnera de consulta (sector CONSULTORIO) + turno sin token
    const [turnera] = await db
      .insert(turnerasTable)
      .values({ nombre: `Turnera TOTP Test ${RUN_ID}`, klinicosSector: "CONSULTORIO" })
      .returning();
    turneraConsultaId = turnera!.id;
    const [turno] = await db
      .insert(turnosTable)
      .values({
        turneraId: turneraConsultaId,
        pacienteId,
        fecha: hoyArgentina(),
        horaInicio: "08:00",
        horaFin: "08:30",
        estado: "pendiente",
      })
      .returning();
    turnoConsultaId = turno!.id;
  });

  afterAll(async () => {
    if (secretoAnterior === null) {
      await db.delete(configSistemaTable).where(eq(configSistemaTable.clave, CLAVE_SUPERVISOR_TOTP));
    } else {
      await db
        .update(configSistemaTable)
        .set({ valor: secretoAnterior })
        .where(eq(configSistemaTable.clave, CLAVE_SUPERVISOR_TOTP));
    }
    for (let intento = 0; intento < 10; intento++) {
      await db.delete(klinicosTrabajos).where(eq(klinicosTrabajos.turnoId, turnoConsultaId));
      try {
        await db.delete(turnosTable).where(eq(turnosTable.id, turnoConsultaId));
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    await db.delete(turnerasTable).where(eq(turnerasTable.id, turneraConsultaId));
  });

  function admitir(body?: unknown): Promise<Response> {
    return fetch(`${baseUrl}/api/turnos/${turnoConsultaId}/admitir`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  it("estado supervisor-totp figura configurado", async () => {
    const res = await get("/api/recepcion/supervisor-totp");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { configurado: boolean }).configurado).toBe(true);
  });

  it("generar el secreto está prohibido para no-admin", async () => {
    const res = await fetch(`${baseUrl}/api/recepcion/supervisor-totp/generar`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(403);
  });

  it("rechaza recepcionar sin código", async () => {
    const res = await admitir();
    expect(res.status).toBe(403);
    expect(((await res.json()) as { codigo: string }).codigo).toBe("codigo_supervisor_requerido");
  });

  it("rechaza recepcionar con código inválido", async () => {
    const res = await admitir({ codigoSupervisor: "000000" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { codigo: string }).codigo).toBe("codigo_supervisor_invalido");
  });

  it("acepta recepcionar con código válido y lo audita", async () => {
    const codigo = codigoTotp(secreto, Math.floor(Date.now() / 1000 / 30));
    const res = await admitir({ codigoSupervisor: codigo });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { estado: string }).estado).toBe("arribo");

    const registros = await db
      .select()
      .from(auditLogTable)
      .where(and(eq(auditLogTable.usuarioId, userId), eq(auditLogTable.accion, "admitir")));
    const delTurno = registros.find(
      (r) => (r.detalle as { sinTokenAutorizadoPorSupervisor?: boolean }).sinTokenAutorizadoPorSupervisor,
    );
    expect(delTurno).toBeDefined();

    // Anti-replay: el mismo código no sirve para otro turno
    const [otro] = await db
      .insert(turnosTable)
      .values({
        turneraId: turneraConsultaId,
        pacienteId,
        fecha: hoyArgentina(),
        horaInicio: "08:30",
        horaFin: "09:00",
        estado: "pendiente",
      })
      .returning();
    try {
      const reuso = await fetch(`${baseUrl}/api/turnos/${otro!.id}/admitir`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ codigoSupervisor: codigo }),
      });
      expect(reuso.status).toBe(403);
      expect(((await reuso.json()) as { codigo: string }).codigo).toBe("codigo_supervisor_invalido");
    } finally {
      await db.delete(klinicosTrabajos).where(eq(klinicosTrabajos.turnoId, otro!.id));
      await db.delete(turnosTable).where(eq(turnosTable.id, otro!.id));
    }
  });
});
