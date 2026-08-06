import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import { inArray } from "drizzle-orm";
import { db, turnerasTable, turnosTable, pacientesTable } from "@workspace/db";
import pacsSalaEsperaRouter from "./pacs_sala_espera";
import { hoyArgentina } from "../lib/tiempo";

// Tests de integración del endpoint de sala de espera para Pixel (PACS).
// Crean sus propios datos y los limpian al terminar.

const RUN_ID = crypto.randomBytes(6).toString("hex");
const TOKEN_PRUEBA = `pacs-test-token-${RUN_ID}`;

let server: Server;
let baseUrl: string;
let turneraId: number;
let pacienteId: number;
const turnoIds: number[] = [];
let tokenOriginalWorklist: string | undefined;
let tokenOriginalApi: string | undefined;

beforeAll(async () => {
  tokenOriginalWorklist = process.env.PACS_WORKLIST_TOKEN;
  tokenOriginalApi = process.env.PACS_API_TOKEN;
  process.env.PACS_WORKLIST_TOKEN = TOKEN_PRUEBA;

  const app = express();
  app.use(express.json());
  app.use("/api", pacsSalaEsperaRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("sin puerto");
  baseUrl = `http://127.0.0.1:${addr.port}`;

  const [paciente] = await db
    .insert(pacientesTable)
    .values({ nombre: "Test", apellido: `Pixel${RUN_ID}`, dni: `9${RUN_ID.slice(0, 7)}` })
    .returning();
  pacienteId = paciente.id;

  const [turnera] = await db
    .insert(turnerasTable)
    .values({
      nombre: `Test Pixel ${RUN_ID}`,
      duracionMinutos: 30,
      horaInicio: "08:00",
      horaFin: "12:00",
      modalidad: "presencial",
      diasAtencion: "1,2,3,4,5",
      activa: true,
    })
    .returning();
  turneraId = turnera.id;

  const fecha = hoyArgentina();
  const estados = ["arribo", "en_sala", "llamado", "en_atencion", "programado"];
  for (let i = 0; i < estados.length; i++) {
    const [turno] = await db
      .insert(turnosTable)
      .values({
        turneraId,
        pacienteId,
        fecha,
        horaInicio: `0${8 + i}:00`,
        horaFin: `0${8 + i}:30`,
        estado: estados[i],
      })
      .returning();
    turnoIds.push(turno.id);
  }
});

afterAll(async () => {
  if (turnoIds.length) await db.delete(turnosTable).where(inArray(turnosTable.id, turnoIds));
  if (turneraId) await db.delete(turnerasTable).where(inArray(turnerasTable.id, [turneraId]));
  if (pacienteId) await db.delete(pacientesTable).where(inArray(pacientesTable.id, [pacienteId]));
  if (tokenOriginalWorklist === undefined) delete process.env.PACS_WORKLIST_TOKEN;
  else process.env.PACS_WORKLIST_TOKEN = tokenOriginalWorklist;
  if (tokenOriginalApi === undefined) delete process.env.PACS_API_TOKEN;
  else process.env.PACS_API_TOKEN = tokenOriginalApi;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("GET /pacs/sala-espera (integración Pixel)", () => {
  it("rechaza sin token", async () => {
    const res = await fetch(`${baseUrl}/api/pacs/sala-espera`);
    expect(res.status).toBe(401);
  });

  it("rechaza con token inválido", async () => {
    const res = await fetch(`${baseUrl}/api/pacs/sala-espera`, {
      headers: { Authorization: "Bearer token-incorrecto" },
    });
    expect(res.status).toBe(401);
  });

  it("devuelve los conteos por agenda con token válido", async () => {
    const res = await fetch(`${baseUrl}/api/pacs/sala-espera`, {
      headers: { Authorization: `Bearer ${TOKEN_PRUEBA}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      fecha: string;
      totalEnSalaDeEspera: number;
      agendas: Array<{
        turneraId: number;
        agenda: string;
        enSalaDeEspera: number;
        llamados: number;
        enAtencion: number;
      }>;
    };
    expect(body.fecha).toBe(hoyArgentina());
    const agenda = body.agendas.find((a) => a.turneraId === turneraId);
    expect(agenda).toBeDefined();
    // arribo + en_sala = 2; "programado" no cuenta
    expect(agenda!.enSalaDeEspera).toBe(2);
    expect(agenda!.llamados).toBe(1);
    expect(agenda!.enAtencion).toBe(1);
    expect(agenda!.agenda).toBe(`Test Pixel ${RUN_ID}`);
    expect(body.totalEnSalaDeEspera).toBeGreaterThanOrEqual(2);
  });
});
