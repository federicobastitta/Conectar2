// Tests de integración del flujo presencial de guardia (Task 332).
//
// Cubren los seis escenarios del ciclo presencial:
//   1. 403 cuando el DNI no está en la allowlist de presencial.
//   2. Un turno "confirmado" en una turnera esGuardia ocupa lugar en la fila.
//   3. "Ya llegué" antes de validar token (sesión sin turnoId) → 409.
//   4. Un turno "confirmado" cuenta en la cola de la guardia pero NO en
//      la de una turnera común (el conteo no se cruza entre agendas).
//   5. "Ya llegué" es idempotente: segunda llamada responde ok + yaEstaba.
//   6. "Ya llegué" con turno cancelado → 409.
//
// Cada test crea sus fixtures (turneras, paciente, turnos, sesiones) con
// claves únicas de RUN_ID para no chocar con otros datos o corridas abortadas.
// Restaura los valores de config_sistema que pisó para no contaminar el entorno.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import pino from "pino";
import { eq, inArray, sql } from "drizzle-orm";
import {
  db,
  turnerasTable,
  turnosTable,
  pacientesTable,
  guardiaVirtualSesionesTable,
  configSistemaTable,
} from "@workspace/db";
import guardiaVirtualRouter from "./guardia_virtual";
import { hoyArgentina } from "../lib/tiempo";

// ── Fixtures compartidos ──────────────────────────────────────────────────

const RUN_ID = crypto.randomBytes(6).toString("hex");
const API_KEY = `test-gv-${RUN_ID}`;

let server: Server;
let baseUrl: string;

let guardiaTurneraId: number;
let regularTurneraId: number;
let pacienteId: number;

const turnoIds: number[] = [];
const sesionIds: number[] = [];
const turneraIds: number[] = [];
const pacienteIds: number[] = [];

// Config keys that we temporarily override; values are restored in afterAll.
const CONFIG_CLAVES = [
  "guardia_virtual_activa",
  "guardia_virtual_turnera_id",
  "guardia_virtual_obras_sociales",
  "guardia_virtual_horario",
  "guardia_presencial_dnis_prueba",
] as const;
const configAnterior = new Map<string, string | null>();

// DNI in the allowlist (we'll seed it into config); another DNI that is NOT.
// Both must be purely numeric (7-10 digits) to pass the route's input validation.
// Derive 6 decimal digits from RUN_ID so they are unique per run.
const runDigits = String(parseInt(RUN_ID.substring(0, 6), 16))
  .slice(-6)
  .padStart(6, "0");
const DNI_HABILITADO = `8${runDigits}`;    // 7 digits, unique per run
const DNI_NO_HABILITADO = `9${runDigits}`; // different leading digit, not in allowlist

// ── Helpers ───────────────────────────────────────────────────────────────

function hoy(): string {
  return hoyArgentina();
}

// Each call returns a distinct slot to avoid the partial unique index on turnos.
let slotCounter = 0;
function nextSlot(): { horaInicio: string; horaFin: string } {
  const h = String(slotCounter % 24).padStart(2, "0");
  const m = String(Math.floor(slotCounter / 24) * 15 % 60).padStart(2, "0");
  slotCounter++;
  return { horaInicio: `${h}:${m}`, horaFin: `${h}:${String(Number(m) + 14).padStart(2, "0")}` };
}

async function crearTurno(opts: {
  turneraId: number;
  estado: string;
}): Promise<number> {
  const slot = nextSlot();
  const [t] = await db
    .insert(turnosTable)
    .values({
      turneraId: opts.turneraId,
      pacienteId,
      fecha: hoy(),
      horaInicio: slot.horaInicio,
      horaFin: slot.horaFin,
      estado: opts.estado,
    })
    .returning({ id: turnosTable.id });
  turnoIds.push(t!.id);
  return t!.id;
}

async function crearSesion(opts: {
  modalidad: "presencial" | "videollamada";
  estado: string;
  turnoId?: number;
  dni?: string;
}): Promise<{ id: number; sesionToken: string }> {
  const token = `ST-${RUN_ID}-${crypto.randomBytes(4).toString("hex")}`;
  const [s] = await db
    .insert(guardiaVirtualSesionesTable)
    .values({
      sesionToken: token,
      dni: opts.dni ?? DNI_HABILITADO,
      nombre: "Test",
      apellido: `GV${RUN_ID}`,
      cobertura: "IOMA",
      modalidad: opts.modalidad,
      estado: opts.estado as typeof guardiaVirtualSesionesTable.$inferSelect["estado"],
      turnoId: opts.turnoId ?? null,
      expiraEn: new Date(Date.now() + 2 * 3600 * 1000),
    })
    .returning({
      id: guardiaVirtualSesionesTable.id,
      sesionToken: guardiaVirtualSesionesTable.sesionToken,
    });
  sesionIds.push(s!.id);
  return { id: s!.id, sesionToken: s!.sesionToken };
}

function postRegistros(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/publico/guardia-virtual/registros`, {
    method: "POST",
    headers: { "x-api-key": API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function postLlegue(sesionToken: string): Promise<Response> {
  return fetch(`${baseUrl}/publico/guardia-virtual/registros/${sesionToken}/llegue`, {
    method: "POST",
    headers: { "x-api-key": API_KEY },
  });
}

function getEstado(): Promise<Response> {
  return fetch(`${baseUrl}/publico/guardia-virtual/estado`, {
    headers: { "x-api-key": API_KEY },
  });
}

// ── Setup / Teardown ──────────────────────────────────────────────────────

beforeAll(async () => {
  // Inject API key so requireApiKey passes in tests.
  process.env.API_PUBLICA_KEY = API_KEY;

  // Spin up minimal Express app with the router under test.
  const app = express();
  const silent = pino({ level: "silent" });
  app.use((req, _res, next) => {
    (req as unknown as { log: pino.Logger }).log = silent;
    next();
  });
  app.use(express.json());
  // Mount at root so paths like /publico/guardia-virtual/... resolve correctly.
  app.use("/", guardiaVirtualRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Sin puerto asignado");
  baseUrl = `http://127.0.0.1:${address.port}`;

  // Save existing config values to restore them after the suite.
  const rows = await db
    .select()
    .from(configSistemaTable)
    .where(inArray(configSistemaTable.clave, [...CONFIG_CLAVES]));
  for (const clave of CONFIG_CLAVES) {
    const row = rows.find((r) => r.clave === clave);
    configAnterior.set(clave, row?.valor ?? null);
  }

  // Create two test turneras: one guardia, one regular.
  const [gt] = await db
    .insert(turnerasTable)
    .values({ nombre: `GVTest-Guardia-${RUN_ID}`, esGuardia: true, activa: true })
    .returning({ id: turnerasTable.id });
  guardiaTurneraId = gt!.id;
  turneraIds.push(guardiaTurneraId);

  const [rt] = await db
    .insert(turnerasTable)
    .values({ nombre: `GVTest-Regular-${RUN_ID}`, esGuardia: false, activa: true })
    .returning({ id: turnerasTable.id });
  regularTurneraId = rt!.id;
  turneraIds.push(regularTurneraId);

  // Create a test paciente used across all turno inserts.
  const [p] = await db
    .insert(pacientesTable)
    .values({ nombre: "GVTest", apellido: `GV${RUN_ID}`, dni: DNI_HABILITADO, activo: true })
    .returning({ id: pacientesTable.id });
  pacienteId = p!.id;
  pacienteIds.push(pacienteId);

  // Seed guardia config pointing to our test turnera.
  // Horario spans the whole day so the time-of-day check never blocks tests.
  const configValues: Array<{ clave: string; valor: string }> = [
    { clave: "guardia_virtual_activa", valor: "true" },
    { clave: "guardia_virtual_turnera_id", valor: String(guardiaTurneraId) },
    { clave: "guardia_virtual_obras_sociales", valor: JSON.stringify(["IOMA"]) },
    {
      clave: "guardia_virtual_horario",
      valor: JSON.stringify({
        lsInicio: "00:00",
        lsFin: "23:58",
        dInicio: "00:00",
        dFin: "23:58",
      }),
    },
    {
      clave: "guardia_presencial_dnis_prueba",
      valor: JSON.stringify([DNI_HABILITADO]),
    },
  ];
  for (const c of configValues) {
    await db.execute(sql`
      INSERT INTO config_sistema (clave, valor)
      VALUES (${c.clave}, ${c.valor})
      ON CONFLICT (clave) DO UPDATE
        SET valor = EXCLUDED.valor, actualizado_en = now()
    `);
  }
});

afterAll(async () => {
  // Delete sesiones first (FK → turnos).
  if (sesionIds.length > 0) {
    await db
      .delete(guardiaVirtualSesionesTable)
      .where(inArray(guardiaVirtualSesionesTable.id, sesionIds));
  }
  // Delete turnos.
  if (turnoIds.length > 0) {
    await db.delete(turnosTable).where(inArray(turnosTable.id, turnoIds));
  }
  // Delete paciente.
  if (pacienteIds.length > 0) {
    await db.delete(pacientesTable).where(inArray(pacientesTable.id, pacienteIds));
  }
  // Delete turneras (after turnos).
  if (turneraIds.length > 0) {
    await db.delete(turnerasTable).where(inArray(turnerasTable.id, turneraIds));
  }
  // Restore original config values.
  for (const [clave, valorAnterior] of configAnterior.entries()) {
    if (valorAnterior === null) {
      await db.delete(configSistemaTable).where(eq(configSistemaTable.clave, clave));
    } else {
      await db.execute(sql`
        INSERT INTO config_sistema (clave, valor)
        VALUES (${clave}, ${valorAnterior})
        ON CONFLICT (clave) DO UPDATE
          SET valor = EXCLUDED.valor, actualizado_en = now()
      `);
    }
  }

  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

// ── 1. 403 cuando el DNI no está en la allowlist ──────────────────────────

describe("POST /publico/guardia-virtual/registros — allowlist presencial", () => {
  it("403 cuando el DNI no está en la lista de presencial habilitado", async () => {
    const res = await postRegistros({
      dni: DNI_NO_HABILITADO,
      nombre: "Test",
      apellido: "Desconocido",
      cobertura: "IOMA",
      modalidad: "presencial",
    });
    expect(res.status).toBe(403);
    const data = (await res.json()) as { error: string };
    expect(data.error).toMatch(/pruebas/i);
  });

  it("DNI habilitado con modalidad=presencial pasa el chequeo y crea sesión (201)", async () => {
    const res = await postRegistros({
      dni: DNI_HABILITADO,
      nombre: "Test",
      apellido: "Habilitado",
      cobertura: "IOMA",
      modalidad: "presencial",
    });
    // 201 = sesión creada; 200 = sesión reutilizada (deduplicación por DNI).
    expect([200, 201]).toContain(res.status);
    const data = (await res.json()) as { sesionToken: string; modalidad: string };
    expect(data.sesionToken).toBeTruthy();
    expect(data.modalidad).toBe("presencial");

    // Retrieve the created sesion id so afterAll can clean it up.
    const [sesion] = await db
      .select({ id: guardiaVirtualSesionesTable.id })
      .from(guardiaVirtualSesionesTable)
      .where(eq(guardiaVirtualSesionesTable.sesionToken, data.sesionToken))
      .limit(1);
    if (sesion) sesionIds.push(sesion.id);
  });
});

// ── 2. Turno "confirmado" ocupa lugar en la cola de la guardia ────────────

describe("infoFila: turno 'confirmado' cuenta en la cola de la guardia", () => {
  it("GET /publico/guardia-virtual/estado muestra turnosEnEspera ≥ 1 con turno confirmado", async () => {
    // Start: fetch current count before adding any fixture turno.
    const resBefore = await getEstado();
    expect(resBefore.status).toBe(200);
    const before = (await resBefore.json()) as { disponible: boolean; turnosEnEspera: number };
    expect(before.disponible).toBe(true);
    const countBefore = before.turnosEnEspera;

    // Insert a "confirmado" turno in the guardia turnera (simulates post-validar-token).
    await crearTurno({ turneraId: guardiaTurneraId, estado: "confirmado" });

    const resAfter = await getEstado();
    expect(resAfter.status).toBe(200);
    const after = (await resAfter.json()) as { disponible: boolean; turnosEnEspera: number };
    expect(after.disponible).toBe(true);
    // The confirmado turno must be reflected in the queue count.
    expect(after.turnosEnEspera).toBe(countBefore + 1);
  });
});

// ── 3. "Ya llegué" antes de validar token → 409 ───────────────────────────

describe("POST /publico/guardia-virtual/registros/:sesionToken/llegue", () => {
  it("409 cuando la sesión no tiene turno asignado (antes del token)", async () => {
    const { sesionToken } = await crearSesion({
      modalidad: "presencial",
      estado: "pre_registro",
      // turnoId omitted = null
    });
    const res = await postLlegue(sesionToken);
    expect(res.status).toBe(409);
    const data = (await res.json()) as { error: string };
    expect(data.error).toMatch(/token/i);
  });

  // ── 5. Idempotencia ───────────────────────────────────────────────────────

  it("idempotente: primera llamada transiciona, segunda responde ok + yaEstaba:true", async () => {
    const turnoId = await crearTurno({ turneraId: guardiaTurneraId, estado: "confirmado" });
    const { sesionToken } = await crearSesion({
      modalidad: "presencial",
      estado: "en_cola",
      turnoId,
    });

    // Primera llamada: "confirmado" → "arribo".
    const res1 = await postLlegue(sesionToken);
    expect(res1.status).toBe(200);
    const d1 = (await res1.json()) as { ok: boolean; yaEstaba?: boolean };
    expect(d1.ok).toBe(true);
    expect(d1.yaEstaba).toBeUndefined(); // first transition, not idempotent yet

    // Segunda llamada: turno ya está en "arribo"; retorna ok sin error.
    const res2 = await postLlegue(sesionToken);
    expect(res2.status).toBe(200);
    const d2 = (await res2.json()) as { ok: boolean; yaEstaba?: boolean };
    expect(d2.ok).toBe(true);
    expect(d2.yaEstaba).toBe(true);
  });

  // ── 6. "Ya llegué" con turno cancelado → 409 ─────────────────────────────

  it("409 cuando el turno asociado está cancelado", async () => {
    const turnoId = await crearTurno({ turneraId: guardiaTurneraId, estado: "cancelado" });
    const { sesionToken } = await crearSesion({
      modalidad: "presencial",
      estado: "en_cola",
      turnoId,
    });
    const res = await postLlegue(sesionToken);
    expect(res.status).toBe(409);
    const data = (await res.json()) as { error: string };
    expect(data.error).toMatch(/vigente|recepci[oó]n/i);
  });
});

// ── Default allowlist: ausencia de clave en config → DNI random → 403 ────────

describe("POST /publico/guardia-virtual/registros — default allowlist (clave ausente)", () => {
  it("cuando guardia_presencial_dnis_prueba no existe en config, cualquier DNI random recibe 403", async () => {
    // Remove the key so leerConfigGuardia falls back to the hardcoded default ["4849369"].
    await db
      .delete(configSistemaTable)
      .where(eq(configSistemaTable.clave, "guardia_presencial_dnis_prueba"));

    try {
      // Use a DNI that is definitely NOT 4849369 and passes digit validation.
      const dniRandom = `7${runDigits}`;
      const res = await postRegistros({
        dni: dniRandom,
        nombre: "Test",
        apellido: "Random",
        cobertura: "IOMA",
        modalidad: "presencial",
      });
      expect(res.status).toBe(403);
      const data = (await res.json()) as { error: string };
      expect(data.error).toMatch(/pruebas/i);
    } finally {
      // Restore the allowlist so subsequent tests work.
      await db.execute(sql`
        INSERT INTO config_sistema (clave, valor)
        VALUES ('guardia_presencial_dnis_prueba', ${JSON.stringify([DNI_HABILITADO])})
        ON CONFLICT (clave) DO UPDATE
          SET valor = EXCLUDED.valor, actualizado_en = now()
      `);
    }
  });
});

// ── Videollamada no requiere allowlist ────────────────────────────────────────

describe("POST /publico/guardia-virtual/registros — modalidad videollamada sin allowlist", () => {
  it("DNI no habilitado con modalidad=videollamada no recibe 403 por allowlist presencial", async () => {
    const res = await postRegistros({
      dni: DNI_NO_HABILITADO,
      nombre: "Test",
      apellido: "Video",
      cobertura: "IOMA",
      modalidad: "videollamada",
    });
    // Should NOT be 403 — allowlist only applies to "presencial".
    // Could be 201 (new) or 200 (dedup); anything but 403/4xx is fine here.
    expect(res.status).not.toBe(403);
    expect(res.status).toBeLessThan(500);
    // Clean up: find and track the created sesion.
    if (res.status === 201 || res.status === 200) {
      const data = (await res.json()) as { sesionToken?: string };
      if (data.sesionToken) {
        const [sesion] = await db
          .select({ id: guardiaVirtualSesionesTable.id })
          .from(guardiaVirtualSesionesTable)
          .where(eq(guardiaVirtualSesionesTable.sesionToken, data.sesionToken))
          .limit(1);
        if (sesion) sesionIds.push(sesion.id);
      }
    }
  });
});

// ── 4. Turnos "confirmado" cuentan en esGuardia pero no en turneras comunes ─

describe("infoFila: aislamiento de cola entre turnera guardia y turnera común", () => {
  it("turno 'confirmado' en turnera común NO afecta la cola de la guardia virtual", async () => {
    // Snapshot the guardia queue count before.
    const resBefore = await getEstado();
    const before = (await resBefore.json()) as { turnosEnEspera: number };
    const countBefore = before.turnosEnEspera;

    // Add a "confirmado" turno to the REGULAR (non-guardia) turnera.
    await crearTurno({ turneraId: regularTurneraId, estado: "confirmado" });

    // The guardia queue must be unchanged.
    const resAfterRegular = await getEstado();
    const afterRegular = (await resAfterRegular.json()) as { turnosEnEspera: number };
    expect(afterRegular.turnosEnEspera).toBe(countBefore);
  });

  it("turno 'confirmado' en turnera esGuardia SÍ incrementa la cola en 1", async () => {
    const resBefore = await getEstado();
    const before = (await resBefore.json()) as { turnosEnEspera: number };
    const countBefore = before.turnosEnEspera;

    // Add a "confirmado" turno to the GUARDIA turnera.
    await crearTurno({ turneraId: guardiaTurneraId, estado: "confirmado" });

    const resAfter = await getEstado();
    const after = (await resAfter.json()) as { turnosEnEspera: number };
    expect(after.turnosEnEspera).toBe(countBefore + 1);
  });
});
