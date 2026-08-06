import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import pino from "pino";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  sedesTable,
  especialidadesTable,
  profesionalesTable,
  turnerasTable,
  turnosTable,
  pacientesTable,
} from "@workspace/db";
import apiPublicaRouter from "./api_publica";

// Tests del endpoint GET /publico/turneras/:id/disponibilidad?fechaDesde&fechaHasta.
// Crean sus propios datos (RUN_ID) y los limpian al terminar.

const RUN_ID = crypto.randomBytes(6).toString("hex");
const API_KEY = `test-api-key-disp-rango-${RUN_ID}`;

let server: Server;
let baseUrl: string;
let sedeId: number;
let especialidadId: number;
let profesionalId: number;
let turneraId: number;
let turneraInactivaId: number;
let turneraSinOnlineId: number;
let pacienteId: number;
const turnoIds: number[] = [];

// Próxima fecha futura (>= mañana) que caiga en el día de semana pedido (UTC).
function proximaFecha(diaSemana: number, offsetSemanas = 0): string {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000 + offsetSemanas * 7 * 24 * 60 * 60 * 1000);
  while (d.getUTCDay() !== diaSemana) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().split("T")[0]!;
}

// Agrega N días a una fecha YYYY-MM-DD.
function sumarDias(fecha: string, n: number): string {
  const d = new Date(`${fecha}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split("T")[0]!;
}

// Dos martes futuros consecutivos para tener turnos en el rango.
const MARTES_1 = proximaFecha(2);           // próximo martes
const MARTES_2 = proximaFecha(2, 1);        // martes siguiente
const FECHA_DESDE = MARTES_1;
const FECHA_HASTA = MARTES_2;               // 8 días de rango

async function api(path: string, init?: RequestInit) {
  return fetch(`${baseUrl}/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", "x-api-key": API_KEY, ...(init?.headers ?? {}) },
  });
}

beforeAll(async () => {
  // Inyectar la API key en el entorno del proceso para que el middleware la acepte.
  process.env.API_PUBLICA_KEY = API_KEY;

  const app = express();
  const silent = pino({ level: "silent" });
  app.use((req, _res, next) => {
    (req as unknown as { log: pino.Logger }).log = silent;
    next();
  });
  app.use(express.json());
  app.use("/api", apiPublicaRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Sin puerto asignado");
  baseUrl = `http://127.0.0.1:${address.port}`;

  // Fixtures propios con RUN_ID.
  const [sede] = await db.insert(sedesTable).values({ nombre: `Sede DR ${RUN_ID}` }).returning();
  sedeId = sede.id;
  const [esp] = await db.insert(especialidadesTable).values({ nombre: `Esp DR ${RUN_ID}` }).returning();
  especialidadId = esp.id;
  const [prof] = await db.insert(profesionalesTable).values({ nombre: "Doc", apellido: `DR${RUN_ID}` }).returning();
  profesionalId = prof.id;

  // Turnera principal: activa, visibilidad "online", martes, 08:00–09:00, 30 min → 2 slots.
  const base = {
    sedeId,
    especialidadId,
    profesionalId,
    duracionMinutos: 30,
    modalidad: "presencial",
    activa: true,
    diasAtencion: "2", // martes
    horaInicio: "08:00",
    horaFin: "09:00",
    visibilidad: "online",
  } as const;
  const [t] = await db.insert(turnerasTable).values({ ...base, nombre: `DR Turnera ${RUN_ID}` }).returning();
  turneraId = t.id;

  // Turnera inactiva (mismo setup pero activa: false).
  const [ti] = await db.insert(turnerasTable).values({ ...base, nombre: `DR Inactiva ${RUN_ID}`, activa: false }).returning();
  turneraInactivaId = ti.id;

  // Turnera sin visibilidad online.
  const [ts] = await db.insert(turnerasTable).values({ ...base, nombre: `DR SinOnline ${RUN_ID}`, visibilidad: "interna" }).returning();
  turneraSinOnlineId = ts.id;

  // Paciente y turno que ocupa el slot 08:00 del primer martes.
  const [pac] = await db.insert(pacientesTable).values({
    nombre: "Pac", apellido: `DR${RUN_ID}`, dni: `9${RUN_ID.slice(0, 6)}`,
  }).returning();
  pacienteId = pac.id;
  const [turno] = await db.insert(turnosTable).values({
    turneraId,
    pacienteId,
    fecha: MARTES_1,
    horaInicio: "08:00",
    horaFin: "08:30",
    estado: "pendiente",
  }).returning();
  turnoIds.push(turno.id);
});

afterAll(async () => {
  if (turnoIds.length) await db.delete(turnosTable).where(inArray(turnosTable.id, turnoIds));
  await db.delete(pacientesTable).where(eq(pacientesTable.id, pacienteId));
  await db.delete(turnerasTable).where(inArray(turnerasTable.id, [turneraId, turneraInactivaId, turneraSinOnlineId]));
  await db.delete(profesionalesTable).where(eq(profesionalesTable.id, profesionalId));
  await db.delete(especialidadesTable).where(eq(especialidadesTable.id, especialidadId));
  await db.delete(sedesTable).where(eq(sedesTable.id, sedeId));
  delete process.env.API_PUBLICA_KEY;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ── Casos ─────────────────────────────────────────────────────────────────

describe("GET /publico/turneras/:id/disponibilidad (rango)", () => {

  // Caso 1: sin x-api-key → 401
  it("rechaza sin x-api-key", async () => {
    const url = `/publico/turneras/${turneraId}/disponibilidad?fechaDesde=${FECHA_DESDE}&fechaHasta=${FECHA_HASTA}`;
    const res = await fetch(`${baseUrl}/api${url}`);
    expect(res.status).toBe(401);
  });

  // Caso 2: parámetros faltantes o formato inválido → 400
  it("rechaza si falta fechaDesde", async () => {
    const res = await api(`/publico/turneras/${turneraId}/disponibilidad?fechaHasta=${FECHA_HASTA}`);
    expect(res.status).toBe(400);
  });

  it("rechaza si falta fechaHasta", async () => {
    const res = await api(`/publico/turneras/${turneraId}/disponibilidad?fechaDesde=${FECHA_DESDE}`);
    expect(res.status).toBe(400);
  });

  it("rechaza formato inválido (no YYYY-MM-DD)", async () => {
    const res = await api(`/publico/turneras/${turneraId}/disponibilidad?fechaDesde=01-09-2026&fechaHasta=30-09-2026`);
    expect(res.status).toBe(400);
  });

  // Caso 3: fechaHasta < fechaDesde → 400
  it("rechaza si fechaHasta < fechaDesde", async () => {
    const res = await api(`/publico/turneras/${turneraId}/disponibilidad?fechaDesde=${FECHA_HASTA}&fechaHasta=${FECHA_DESDE}`);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/mayor o igual/i);
  });

  // Caso 4: rango > 31 días → 400
  it("rechaza rango mayor a 31 días", async () => {
    const hasta32 = sumarDias(FECHA_DESDE, 32);
    const res = await api(`/publico/turneras/${turneraId}/disponibilidad?fechaDesde=${FECHA_DESDE}&fechaHasta=${hasta32}`);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/31/);
  });

  // Caso 5: turnera inexistente / inactiva / sin visibilidad online → 404
  it("responde 404 para turnera inexistente", async () => {
    const res = await api(`/publico/turneras/999999/disponibilidad?fechaDesde=${FECHA_DESDE}&fechaHasta=${FECHA_HASTA}`);
    expect(res.status).toBe(404);
  });

  it("responde 404 para turnera inactiva", async () => {
    const res = await api(`/publico/turneras/${turneraInactivaId}/disponibilidad?fechaDesde=${FECHA_DESDE}&fechaHasta=${FECHA_HASTA}`);
    expect(res.status).toBe(404);
  });

  it("responde 200 para turnera sin visibilidad online (decisión ago 2026: la app ve todas las agendas activas)", async () => {
    const res = await api(`/publico/turneras/${turneraSinOnlineId}/disponibilidad?fechaDesde=${FECHA_DESDE}&fechaHasta=${FECHA_HASTA}`);
    expect(res.status).toBe(200);
  });

  // Caso 6: rango válido — slots correctos, turno ocupado disponible:false
  it("devuelve slots agrupados con slot ocupado marcado", async () => {
    const res = await api(`/publico/turneras/${turneraId}/disponibilidad?fechaDesde=${FECHA_DESDE}&fechaHasta=${FECHA_HASTA}`);
    expect(res.status).toBe(200);

    const body = await res.json() as {
      fechaDesde: string;
      fechaHasta: string;
      dias: Record<string, { horaInicio: string; horaFin: string; disponible: boolean }[]>;
    };

    expect(body.fechaDesde).toBe(FECHA_DESDE);
    expect(body.fechaHasta).toBe(FECHA_HASTA);

    // El primer martes debe estar en dias (tiene slots).
    expect(body.dias).toHaveProperty(MARTES_1);
    const slotsMartes1 = body.dias[MARTES_1]!;

    // 08:00 está ocupado → disponible: false
    const slot0800 = slotsMartes1.find((s) => s.horaInicio === "08:00");
    expect(slot0800).toBeDefined();
    expect(slot0800!.disponible).toBe(false);

    // 08:30 está libre → disponible: true
    const slot0830 = slotsMartes1.find((s) => s.horaInicio === "08:30");
    expect(slot0830).toBeDefined();
    expect(slot0830!.disponible).toBe(true);

    // turnoId NO debe aparecer en ningún slot.
    for (const slots of Object.values(body.dias)) {
      for (const s of slots) {
        expect(s).not.toHaveProperty("turnoId");
      }
    }

    // horaFin debe ser coherente (30 min después de horaInicio).
    expect(slot0800!.horaFin).toBe("08:30");
    expect(slot0830!.horaFin).toBe("09:00");
  });

  it("el segundo martes también aparece con ambos slots libres", async () => {
    const res = await api(`/publico/turneras/${turneraId}/disponibilidad?fechaDesde=${FECHA_DESDE}&fechaHasta=${FECHA_HASTA}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { dias: Record<string, { horaInicio: string; disponible: boolean }[]> };

    expect(body.dias).toHaveProperty(MARTES_2);
    const slotsMartes2 = body.dias[MARTES_2]!;
    expect(slotsMartes2.length).toBe(2);
    expect(slotsMartes2.every((s) => s.disponible)).toBe(true);
  });

  // Caso 7: fechas fuera del rango no aparecen en la respuesta
  it("no incluye fechas fuera del rango ni días sin atención", async () => {
    // El miércoles entre los dos martes no debe aparecer (la turnera solo atiende martes).
    const miercolesEnMedio = sumarDias(MARTES_1, 1);
    const res = await api(`/publico/turneras/${turneraId}/disponibilidad?fechaDesde=${FECHA_DESDE}&fechaHasta=${FECHA_HASTA}`);
    const body = await res.json() as { dias: Record<string, unknown> };
    expect(body.dias).not.toHaveProperty(miercolesEnMedio);
    // Solo deben aparecer los dos martes del rango (o ningún día adicional de otra semana).
    const fechasEnRespuesta = Object.keys(body.dias);
    for (const f of fechasEnRespuesta) {
      expect(f >= FECHA_DESDE && f <= FECHA_HASTA).toBe(true);
    }
  });

  // Rango exacto de 31 días es válido (límite incluido).
  it("acepta rango exacto de 31 días", async () => {
    const hasta31 = sumarDias(FECHA_DESDE, 30); // 30 días después = 31 días de rango
    const res = await api(`/publico/turneras/${turneraId}/disponibilidad?fechaDesde=${FECHA_DESDE}&fechaHasta=${hasta31}`);
    expect(res.status).toBe(200);
  });

  // Mismo día (rango de 1 día) es válido.
  it("acepta rango de un solo día", async () => {
    const res = await api(`/publico/turneras/${turneraId}/disponibilidad?fechaDesde=${MARTES_1}&fechaHasta=${MARTES_1}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { dias: Record<string, unknown> };
    expect(body.dias).toHaveProperty(MARTES_1);
  });
});
