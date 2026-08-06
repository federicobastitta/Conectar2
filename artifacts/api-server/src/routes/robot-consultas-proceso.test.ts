import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import pino from "pino";
import { eq, inArray, like } from "drizzle-orm";
import {
  db,
  usersTable,
  sesionesTable,
  pacientesTable,
  klinicosPracticas,
  klinicosConsultasProcesosTable,
} from "@workspace/db";
import salaEsperaRouter from "./sala_espera";

// Tests del flujo consultations/process (contrato definitivo del Robot,
// docs/robot-openapi/robot-openapi.yaml) contra un Robot SIMULADO local.
// Cubren: los 8 estados, 409 de retry → TOKEN_REENTRY_REQUIRED, 429, 401,
// idempotencia consultation_id ↔ request_id, guardas de auth/rol y que el
// token NUNCA se persista completo (solo enmascarado).

const RUN_ID = crypto.randomBytes(6).toString("hex");
const DNI = String(20_000_000 + (parseInt(RUN_ID.slice(0, 6), 16) % 9_000_000));
const PRACTICA_CODIGO = `TST${RUN_ID.slice(0, 5).toUpperCase()}`;
// Varios admins para no chocar con el rate limit de 5 pruebas/minuto por
// usuario (compartido con la prueba de token): cada POST rota de admin.
const ADMIN_COUNT = 8;
const ADMIN_EMAILS = Array.from(
  { length: ADMIN_COUNT },
  (_, i) => `test-proceso-admin${i}-${RUN_ID}@test.local`,
);
const ADMIN_TOKENS = Array.from(
  { length: ADMIN_COUNT },
  (_, i) => `test-token-proc-admin${i}-${RUN_ID}`,
);
const ADMIN_TOKEN = ADMIN_TOKENS[0]!;
const RECEP_EMAIL = `test-proceso-recep-${RUN_ID}@test.local`;
const RECEP_TOKEN = `test-token-proc-recep-${RUN_ID}`;

let apiServer: Server;
let apiBase: string;
let robotServer: Server;
let adminIds: number[] = [];
let recepId: number;
let pacienteId: number;
let practicaId: number;
let reglaCie10Id: number;

// ── Robot simulado ───────────────────────────────────────────────────────
// Comportamiento controlado por el valor del token enviado:
//   sim-<STATUS> → responde 200 con ese status
//   sim-http-<código> → responde ese HTTP sin cuerpo útil
// El GET de polling y el retry se controlan con variables mutables.
let pollStatus = "PROCESSING";
let retryHttp = 200;
let retryStatus = "PROCESSING";
let healthSandbox = true;
let ultimoBody: Record<string, unknown> | null = null;
let ultimaApiKeyPresente: boolean | null = null;
let envAnterior: string | undefined;

function respuestaRobot(requestId: string, consultationId: string, status: string) {
  return {
    request_id: requestId,
    consultation_id: consultationId,
    status,
    attempt_number: 1,
    requires_manual_action: ["DATA_REQUIRED", "MAPPING_REQUIRED", "TOKEN_REENTRY_REQUIRED"].includes(status),
    retry_allowed: ["TECHNICAL_ERROR", "DATA_REQUIRED"].includes(status),
    prestation_created: status === "TOKEN_ACCEPTED",
    missing_fields: status === "DATA_REQUIRED" ? ["patient.affiliate_number"] : [],
    mapping_required:
      status === "MAPPING_REQUIRED"
        ? [{ kind: "practice", value: PRACTICA_CODIGO, problem: "sin equivalencia aprobada" }]
        : [],
    reason_code: status === "TOKEN_DENIED" ? "IOMA_DENIED" : null,
    reason_message: status === "TOKEN_DENIED" ? "Token rechazado por IOMA" : null,
    authorization_number: status === "TOKEN_ACCEPTED" ? "AUT-123" : null,
    klinicos_reference: status === "TOKEN_ACCEPTED" ? "KLI-999" : null,
    queue:
      status === "PROCESSING"
        ? { pending_operations: 3, approx_position: 2, estimated_wait_seconds: 90, klinicos_session_available: true }
        : null,
    validated_at: status === "TOKEN_ACCEPTED" ? new Date().toISOString() : null,
  };
}

beforeAll(async () => {
  // Robot simulado
  const robot = express();
  robot.use(express.json());
  robot.post("/api/v1/klinicos/consultations/process", (req, res) => {
    ultimoBody = req.body;
    ultimaApiKeyPresente = typeof req.headers["x-api-key"] === "string" && req.headers["x-api-key"]!.length > 0;
    const token: string = req.body?.token ?? "";
    const httpMatch = /^sim-http-(\d{3})$/.exec(token);
    if (httpMatch) return void res.status(Number(httpMatch[1])).json({ error: "simulado" });
    const status = /^sim-([A-Z_]+)$/.exec(token)?.[1] ?? "PROCESSING";
    res.json(respuestaRobot(req.body.request_id, req.body.consultation_id, status));
  });
  robot.get("/api/v1/klinicos/consultations/requests/:id", (req, res) => {
    res.json(respuestaRobot(req.params.id, "poll-consulta", pollStatus));
  });
  robot.post("/api/v1/klinicos/consultations/requests/:id/retry", (req, res) => {
    if (retryHttp !== 200) return void res.status(retryHttp).json({ error: "token vencido" });
    res.json(respuestaRobot(req.params.id, "poll-consulta", retryStatus));
  });
  robot.get("/api/v1/klinicos/consultations/health", (_req, res) => {
    res.json({
      enabled: true,
      sandbox: healthSandbox,
      queue: { pending_operations: 1, klinicos_session_available: true },
      totals_by_status: { PROCESSING: 1 },
      timestamp: new Date().toISOString(),
    });
  });
  await new Promise<void>((resolve) => {
    robotServer = robot.listen(0, () => resolve());
  });
  const robotAddr = robotServer.address();
  if (typeof robotAddr === "string" || robotAddr === null) throw new Error("Robot sin puerto");
  envAnterior = process.env.ROBOT_API_URL;
  process.env.ROBOT_API_URL = `http://127.0.0.1:${robotAddr.port}`;

  // API de Conectar
  const app = express();
  const silent = pino({ level: "silent" });
  app.use((req, _res, next) => {
    (req as unknown as { log: pino.Logger }).log = silent;
    next();
  });
  app.use(express.json());
  app.use("/api", salaEsperaRouter);
  await new Promise<void>((resolve) => {
    apiServer = app.listen(0, () => resolve());
  });
  const addr = apiServer.address();
  if (typeof addr === "string" || addr === null) throw new Error("Sin puerto asignado");
  apiBase = `http://127.0.0.1:${addr.port}`;

  // Datos: usuarios, sesiones, paciente REAL y práctica del catálogo
  const admins = await db
    .insert(usersTable)
    .values(
      ADMIN_EMAILS.map((email, i) => ({
        email,
        passwordHash: "x",
        nombre: `Admin Proc ${i}`,
        rol: "admin",
      })),
    )
    .returning();
  adminIds = admins.map((a) => a.id);
  const [recep] = await db
    .insert(usersTable)
    .values({ email: RECEP_EMAIL, passwordHash: "x", nombre: "Recep Proc", rol: "recepcionista" })
    .returning();
  recepId = recep!.id;
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  await db.insert(sesionesTable).values([
    ...ADMIN_TOKENS.map((token, i) => ({
      token,
      usuarioId: adminIds[i]!,
      activa: true,
      expiresAt,
    })),
    { token: RECEP_TOKEN, usuarioId: recepId, activa: true, expiresAt },
  ]);
  const [pac] = await db
    .insert(pacientesTable)
    .values({
      nombre: "Prueba",
      apellido: `Proceso ${RUN_ID}`,
      dni: DNI,
      nroAfiliado: `AF-${RUN_ID}`,
      cobertura: "IOMA",
      activo: true,
    })
    .returning();
  pacienteId = pac!.id;
  const [prac] = await db
    .insert(klinicosPracticas)
    .values({ nombre: `PRACTICA TEST ${RUN_ID}`, codigos: [PRACTICA_CODIGO], activo: true })
    .returning();
  practicaId = prac!.id;

  // Catálogo CIE-10 propio (regla de la DB compartida: cada suite siembra lo
  // suyo). Si otra corrida deja el catálogo no vacío sin J06.9, el endpoint
  // devolvería 400 "no está en el catálogo" antes de llegar a lo testeado.
  const { klinicosReglasCie10 } = await import("@workspace/db");
  const [regla] = await db
    .insert(klinicosReglasCie10)
    .values({
      patron: `test-proc-${RUN_ID}`,
      cie10Codigo: "J06.9",
      cie10Descripcion: "IRA superior, no especificada",
    })
    .returning();
  reglaCie10Id = regla!.id;
});

afterAll(async () => {
  if (envAnterior === undefined) delete process.env.ROBOT_API_URL;
  else process.env.ROBOT_API_URL = envAnterior;
  await db
    .delete(klinicosConsultasProcesosTable)
    .where(like(klinicosConsultasProcesosTable.consultationId, `test-proc-${RUN_ID}%`));
  const { klinicosReglasCie10 } = await import("@workspace/db");
  await db.delete(klinicosReglasCie10).where(eq(klinicosReglasCie10.id, reglaCie10Id));
  await db.delete(klinicosPracticas).where(eq(klinicosPracticas.id, practicaId));
  await db.delete(pacientesTable).where(eq(pacientesTable.id, pacienteId));
  await db
    .delete(sesionesTable)
    .where(inArray(sesionesTable.token, [...ADMIN_TOKENS, RECEP_TOKEN]));
  await db.delete(usersTable).where(inArray(usersTable.id, [...adminIds, recepId]));
  await new Promise<void>((r) => robotServer.close(() => r()));
  await new Promise<void>((r) => apiServer.close(() => r()));
});

let consultaSeq = 0;
function bodyBase(token: string) {
  consultaSeq += 1;
  return {
    token,
    dni: DNI,
    practicaCodigo: PRACTICA_CODIGO,
    diagnosisCode: "J06.9",
    consultationId: `test-proc-${RUN_ID}-${consultaSeq}`,
  };
}

// Rotación de admins en cada POST para esquivar el rate limit por usuario.
let adminIdx = 0;
function proximoAdmin(): string {
  adminIdx = (adminIdx + 1) % ADMIN_TOKENS.length;
  return ADMIN_TOKENS[adminIdx]!;
}

const post = (auth: string | null, body: unknown) =>
  fetch(`${apiBase}/api/robot-klinicos/consultas/prueba`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth ? { authorization: `Bearer ${auth === ADMIN_TOKEN ? proximoAdmin() : auth}` } : {}),
    },
    body: JSON.stringify(body),
  });

const getProceso = (auth: string | null, requestId: string) =>
  fetch(`${apiBase}/api/robot-klinicos/consultas/prueba/${requestId}`, {
    headers: auth ? { authorization: `Bearer ${auth}` } : {},
  });

const postRetry = (auth: string | null, requestId: string) =>
  fetch(`${apiBase}/api/robot-klinicos/consultas/prueba/${requestId}/retry`, {
    method: "POST",
    headers: auth
      ? { authorization: `Bearer ${auth === ADMIN_TOKEN ? proximoAdmin() : auth}` }
      : {},
  });

describe("guardas de acceso", () => {
  it("rechaza sin autenticación", async () => {
    expect((await post(null, bodyBase("sim-PROCESSING"))).status).toBe(401);
    expect((await getProceso(null, "x")).status).toBe(401);
    expect((await postRetry(null, "x")).status).toBe(401);
  });

  it("rechaza a roles no admin", async () => {
    expect((await post(RECEP_TOKEN, bodyBase("sim-PROCESSING"))).status).toBe(403);
    expect((await getProceso(RECEP_TOKEN, "x")).status).toBe(403);
    expect((await postRetry(RECEP_TOKEN, "x")).status).toBe(403);
  });

  it("rechaza si el paciente no existe en Conectar (el Robot nunca crea pacientes)", async () => {
    const res = await post(ADMIN_TOKEN, { ...bodyBase("sim-PROCESSING"), dni: "999999" });
    expect(res.status).toBe(404);
  });

  it("rechaza prácticas fuera del catálogo institucional", async () => {
    const res = await post(ADMIN_TOKEN, { ...bodyBase("sim-PROCESSING"), practicaCodigo: "NOEXISTE" });
    expect(res.status).toBe(404);
  });

  it("rechaza CIE-10 con formato inválido", async () => {
    const res = await post(ADMIN_TOKEN, { ...bodyBase("sim-PROCESSING"), diagnosisCode: "XXXX" });
    expect(res.status).toBe(400);
  });
});

describe("estados del contrato", () => {
  it("TOKEN_ACCEPTED: único habilitante; guarda autorización y NO persiste el token completo", async () => {
    const token = "sim-TOKEN_ACCEPTED";
    const res = await post(ADMIN_TOKEN, bodyBase(token));
    expect(res.status).toBe(200);
    const r = (await res.json()) as Record<string, unknown>;
    expect(r.estado).toBe("TOKEN_ACCEPTED");
    expect(r.prestacionCreada).toBe(true);
    expect(r.numeroAutorizacion).toBe("AUT-123");
    // El Robot recibió la X-Api-Key (solo backend) y el body del contrato
    expect(ultimaApiKeyPresente).toBe(true);
    expect(ultimoBody).toBeTruthy();
    expect(ultimoBody!.practice).toMatchObject({ id: PRACTICA_CODIGO, catalog: "IOMA" });
    expect(ultimoBody).not.toHaveProperty("specialty");
    expect(ultimoBody).not.toHaveProperty("professional");
    expect(String(ultimoBody!.scheduled_at)).toMatch(/-03:00$/);
    // Persistencia: token solo enmascarado
    const [fila] = await db
      .select()
      .from(klinicosConsultasProcesosTable)
      .where(eq(klinicosConsultasProcesosTable.requestId, String(r.requestId)));
    expect(fila).toBeTruthy();
    expect(fila!.estado).toBe("TOKEN_ACCEPTED");
    expect(fila!.tokenMasked).not.toContain(token);
    expect(JSON.stringify(fila)).not.toContain(token);
  });

  it("TOKEN_DENIED / DATA_REQUIRED / MAPPING_REQUIRED / MANUAL_REVIEW", async () => {
    const denied = (await (await post(ADMIN_TOKEN, bodyBase("sim-TOKEN_DENIED"))).json()) as Record<string, unknown>;
    expect(denied.estado).toBe("TOKEN_DENIED");

    const data = (await (await post(ADMIN_TOKEN, bodyBase("sim-DATA_REQUIRED"))).json()) as Record<string, unknown>;
    expect(data.estado).toBe("DATA_REQUIRED");
    expect(data.camposFaltantes).toEqual(["patient.affiliate_number"]);
    expect(data.reintentoPermitido).toBe(true);

    const map = (await (await post(ADMIN_TOKEN, bodyBase("sim-MAPPING_REQUIRED"))).json()) as Record<string, unknown>;
    expect(map.estado).toBe("MAPPING_REQUIRED");
    expect(map.mapeosPendientes).toEqual([
      { kind: "practice", value: PRACTICA_CODIGO, problem: "sin equivalencia aprobada" },
    ]);

    const rev = (await (await post(ADMIN_TOKEN, bodyBase("sim-MANUAL_REVIEW"))).json()) as Record<string, unknown>;
    expect(rev.estado).toBe("MANUAL_REVIEW");
  }, 40_000);

  it("PROCESSING con datos de cola + polling que termina en TOKEN_ACCEPTED", async () => {
    const res = (await (await post(ADMIN_TOKEN, bodyBase("sim-PROCESSING"))).json()) as Record<string, unknown>;
    expect(res.estado).toBe("PROCESSING");
    expect((res.cola as Record<string, unknown>).posicionAproximada).toBe(2);

    pollStatus = "TOKEN_ACCEPTED";
    const poll = (await (await getProceso(ADMIN_TOKEN, String(res.requestId))).json()) as Record<string, unknown>;
    expect(poll.estado).toBe("TOKEN_ACCEPTED");
    const [fila] = await db
      .select()
      .from(klinicosConsultasProcesosTable)
      .where(eq(klinicosConsultasProcesosTable.requestId, String(res.requestId)));
    expect(fila!.estado).toBe("TOKEN_ACCEPTED");
  });

  it("TECHNICAL_ERROR y TOKEN_REENTRY_REQUIRED del Robot", async () => {
    const tech = (await (await post(ADMIN_TOKEN, bodyBase("sim-TECHNICAL_ERROR"))).json()) as Record<string, unknown>;
    expect(tech.estado).toBe("TECHNICAL_ERROR");
    expect(tech.reintentoPermitido).toBe(true);

    const reentry = (await (await post(ADMIN_TOKEN, bodyBase("sim-TOKEN_REENTRY_REQUIRED"))).json()) as Record<string, unknown>;
    expect(reentry.estado).toBe("TOKEN_REENTRY_REQUIRED");
  });
});

describe("errores HTTP del Robot y retry", () => {
  it("429 del Robot → rate_limit reintenable; 401 → clave de API inválida; 503 → deshabilitado", async () => {
    const r429 = (await (await post(ADMIN_TOKEN, bodyBase("sim-http-429"))).json()) as Record<string, unknown>;
    expect(r429.estado).toBe("ERROR_COMUNICACION");
    expect(r429.claseError).toBe("rate_limit");
    expect(r429.reintentoPermitido).toBe(true);

    const r401 = (await (await post(ADMIN_TOKEN, bodyBase("sim-http-401"))).json()) as Record<string, unknown>;
    expect(r401.claseError).toBe("no_autorizado");

    const r503 = (await (await post(ADMIN_TOKEN, bodyBase("sim-http-503"))).json()) as Record<string, unknown>;
    expect(r503.claseError).toBe("deshabilitado");
  }, 40_000);

  it("retry con 409 del Robot → TOKEN_REENTRY_REQUIRED local (token vencido)", async () => {
    const res = (await (await post(ADMIN_TOKEN, bodyBase("sim-PROCESSING"))).json()) as Record<string, unknown>;
    retryHttp = 409;
    const retry = (await (await postRetry(ADMIN_TOKEN, String(res.requestId))).json()) as Record<string, unknown>;
    expect(retry.estado).toBe("TOKEN_REENTRY_REQUIRED");
    expect(retry.claseError).toBe("conflicto");
    expect(retry.requiereAccionManual).toBe(true);
    const [fila] = await db
      .select()
      .from(klinicosConsultasProcesosTable)
      .where(eq(klinicosConsultasProcesosTable.requestId, String(res.requestId)));
    expect(fila!.estado).toBe("TOKEN_REENTRY_REQUIRED");
    retryHttp = 200;
  });

  it("retry exitoso devuelve el estado del Robot", async () => {
    const res = (await (await post(ADMIN_TOKEN, bodyBase("sim-PROCESSING"))).json()) as Record<string, unknown>;
    retryStatus = "TOKEN_ACCEPTED";
    const retry = (await (await postRetry(ADMIN_TOKEN, String(res.requestId))).json()) as Record<string, unknown>;
    expect(retry.estado).toBe("TOKEN_ACCEPTED");
  }, 40_000);
});

describe("idempotencia consultation_id ↔ request_id", () => {
  it("mismo consultation_id con OTRO request_id → 409; con el MISMO request_id → OK", async () => {
    const body = bodyBase("sim-DATA_REQUIRED");
    const primera = (await (await post(ADMIN_TOKEN, body)).json()) as Record<string, unknown>;
    const requestId = String(primera.requestId);

    // Otro request_id para la misma consulta: rechazado localmente
    const conflicto = await post(ADMIN_TOKEN, { ...body, requestId: crypto.randomUUID() });
    expect(conflicto.status).toBe(409);

    // Mismo request_id: re-envío del caso permitido
    const reenvio = await post(ADMIN_TOKEN, { ...body, requestId, token: "sim-TOKEN_ACCEPTED" });
    expect(reenvio.status).toBe(200);
    const r = (await reenvio.json()) as Record<string, unknown>;
    expect(r.requestId).toBe(requestId);
    expect(r.estado).toBe("TOKEN_ACCEPTED");
  }, 40_000);
});

describe("bloqueo por sandbox", () => {
  it("si health no devuelve sandbox:true, la prueba se bloquea con 409", async () => {
    healthSandbox = false;
    const res = await post(ADMIN_TOKEN, bodyBase("sim-TOKEN_ACCEPTED"));
    expect(res.status).toBe(409);
    const j = (await res.json()) as Record<string, unknown>;
    expect(String(j.error)).toContain("sandbox");
    healthSandbox = true;
  });
});

describe("salud del flujo", () => {
  it("devuelve disponibilidad y cola para admin; 403 para no admin", async () => {
    const salud = await fetch(`${apiBase}/api/robot-klinicos/consultas/salud`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(salud.status).toBe(200);
    const s = (await salud.json()) as Record<string, unknown>;
    expect(s.disponible).toBe(true);
    expect(s.habilitadoEnRobot).toBe(true);
    expect(s.sandbox).toBe(true);

    const noAdmin = await fetch(`${apiBase}/api/robot-klinicos/consultas/salud`, {
      headers: { authorization: `Bearer ${RECEP_TOKEN}` },
    });
    expect(noAdmin.status).toBe(403);
  });
});
