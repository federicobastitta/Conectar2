import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import pino from "pino";
import { eq, inArray } from "drizzle-orm";
import { db, usersTable, sesionesTable } from "@workspace/db";
import salaEsperaRouter from "./sala_espera";
import {
  validarPayloadToken,
  normalizarCie10,
  validarTokenConRobot,
} from "../integraciones/robot-cliente";

// Tests del endpoint de prueba admin de validación de token IOMA y de las
// validaciones previas del contrato matching-request.schema.json.
// No llaman al Robot real: solo cubren las guardas (auth, rol, payload).

const RUN_ID = crypto.randomBytes(6).toString("hex");
const ADMIN_EMAIL = `test-robotprueba-admin-${RUN_ID}@test.local`;
const RECEP_EMAIL = `test-robotprueba-recep-${RUN_ID}@test.local`;
const ADMIN_TOKEN = `test-token-rp-admin-${RUN_ID}`;
const RECEP_TOKEN = `test-token-rp-recep-${RUN_ID}`;

let server: Server;
let baseUrl: string;
let adminId: number;
let recepId: number;

beforeAll(async () => {
  const app = express();
  const silent = pino({ level: "silent" });
  app.use((req, _res, next) => {
    (req as unknown as { log: pino.Logger }).log = silent;
    next();
  });
  app.use(express.json());
  app.use("/api", salaEsperaRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Sin puerto asignado");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const [admin] = await db
    .insert(usersTable)
    .values({ email: ADMIN_EMAIL, passwordHash: "x", nombre: "Admin RP", rol: "admin" })
    .returning();
  adminId = admin!.id;
  const [recep] = await db
    .insert(usersTable)
    .values({ email: RECEP_EMAIL, passwordHash: "x", nombre: "Recep RP", rol: "recepcionista" })
    .returning();
  recepId = recep!.id;
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  await db.insert(sesionesTable).values([
    { token: ADMIN_TOKEN, usuarioId: adminId, activa: true, expiresAt },
    { token: RECEP_TOKEN, usuarioId: recepId, activa: true, expiresAt },
  ]);
});

afterAll(async () => {
  await db.delete(sesionesTable).where(inArray(sesionesTable.token, [ADMIN_TOKEN, RECEP_TOKEN]));
  await db.delete(usersTable).where(eq(usersTable.id, adminId));
  await db.delete(usersTable).where(eq(usersTable.id, recepId));
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

const post = (token: string | null, body: unknown) =>
  fetch(`${baseUrl}/api/robot-klinicos/prueba`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

const getCatalogo = (ruta: string, token: string | null) =>
  fetch(`${baseUrl}/api/robot-klinicos/catalogo/${ruta}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

describe("GET /robot-klinicos/catalogo/* (guardas y formato)", () => {
  for (const ruta of ["practicas", "profesionales"] as const) {
    it(`${ruta}: rechaza sin autenticación`, async () => {
      const res = await getCatalogo(ruta, null);
      expect(res.status).toBe(401);
    });

    it(`${ruta}: rechaza a roles no admin`, async () => {
      const res = await getCatalogo(ruta, RECEP_TOKEN);
      expect(res.status).toBe(403);
    });

    it(`${ruta}: devuelve JSON por defecto para admin`, async () => {
      const res = await getCatalogo(ruta, ADMIN_TOKEN);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      const body = (await res.json()) as Record<string, unknown[]>;
      expect(Array.isArray(body[ruta])).toBe(true);
    });

    it(`${ruta}: devuelve CSV con formato=csv`, async () => {
      const res = await getCatalogo(`${ruta}?formato=csv`, ADMIN_TOKEN);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/csv");
      expect(res.headers.get("content-disposition")).toContain("attachment");
      const bytes = new Uint8Array(await res.arrayBuffer());
      // BOM UTF-8 (fetch lo quita al decodificar texto, verificamos bytes crudos)
      expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
      const texto = new TextDecoder().decode(bytes);
      const cabecera = ruta === "practicas" ? "codigo,descripcion,categoria" : "id,nombre,matricula,especialidad";
      expect(texto).toContain(cabecera);
    });
  }
});

describe("POST /robot-klinicos/prueba (guardas)", () => {
  it("rechaza sin autenticación", async () => {
    const res = await post(null, { token: "123456", dni: "30111222" });
    expect(res.status).toBe(401);
  });

  it("rechaza a roles no admin", async () => {
    const res = await post(RECEP_TOKEN, { token: "123456", dni: "30111222" });
    expect(res.status).toBe(403);
  });

  it("rechaza DNI con caracteres no numéricos", async () => {
    const res = await post(ADMIN_TOKEN, { token: "123456", dni: "30A111" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/dígitos/);
  });

  it("rechaza body sin token", async () => {
    const res = await post(ADMIN_TOKEN, { dni: "30111222" });
    expect(res.status).toBe(400);
  });
});

describe("POST /robot-klinicos/prueba/prestacion-cargada (guardas y registro)", () => {
  const postCarga = (token: string | null, body: unknown) =>
    fetch(`${baseUrl}/api/robot-klinicos/prueba/prestacion-cargada`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

  it("rechaza sin autenticación", async () => {
    const res = await postCarga(null, { requestId: "abc" });
    expect(res.status).toBe(401);
  });

  it("rechaza a roles no admin", async () => {
    const res = await postCarga(RECEP_TOKEN, { requestId: "abc" });
    expect(res.status).toBe(403);
  });

  it("rechaza requestId vacío", async () => {
    const res = await postCarga(ADMIN_TOKEN, { requestId: "  " });
    expect(res.status).toBe(400);
  });

  it("registra usuario y fecha conservando el requestId", async () => {
    const res = await postCarga(ADMIN_TOKEN, { requestId: "req-test-123" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { registrado: boolean; usuario: string; fecha: string };
    expect(body.registrado).toBe(true);
    expect(body.usuario).toBe(ADMIN_EMAIL);
    expect(new Date(body.fecha).getTime()).not.toBeNaN();
  });
});

describe("validaciones previas del contrato (validarPayloadToken)", () => {
  const base = {
    request_id: "11111111-1111-1111-1111-111111111111",
    consultation_id: "c1",
    token: "123456",
    patient: { document_type: "DNI", document_number: "30111222" },
  };

  it("acepta un payload mínimo válido", () => {
    expect(validarPayloadToken(base)).toBeNull();
  });

  it("exige request_id, token y document_number", () => {
    expect(validarPayloadToken({ ...base, request_id: " " })).toMatch(/request_id/);
    expect(validarPayloadToken({ ...base, token: "" })).toMatch(/token/i);
    expect(
      validarPayloadToken({ ...base, patient: { document_type: "DNI", document_number: "" } }),
    ).toMatch(/documento/i);
  });

  it("exige DNI solo dígitos", () => {
    expect(
      validarPayloadToken({ ...base, patient: { document_type: "DNI", document_number: "3A1" } }),
    ).toMatch(/dígitos/);
  });
});

describe("validación CIE-10 del endpoint de prueba (estructura + catálogo)", () => {
  it("rechaza un CIE-10 con estructura inválida", async () => {
    const res = await post(ADMIN_TOKEN, {
      token: "123456",
      dni: "30111222",
      diagnosisCode: "XX99",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/CIE-10/);
    expect(body.error).toMatch(/formato/);
  });

  it("rechaza un CIE-10 estructuralmente válido pero ausente del catálogo institucional", async () => {
    const { klinicosReglasCie10 } = await import("@workspace/db");
    const [regla] = await db
      .insert(klinicosReglasCie10)
      .values({
        patron: `test-rp-${RUN_ID}`,
        cie10Codigo: "J06.9",
        cie10Descripcion: "IRA superior, no especificada",
      })
      .returning();
    try {
      const res = await post(ADMIN_TOKEN, {
        token: "123456",
        dni: "30111222",
        diagnosisCode: "Z99.9",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/catálogo/);
    } finally {
      await db.delete(klinicosReglasCie10).where(eq(klinicosReglasCie10.id, regla!.id));
    }
  });
});

describe("rate limiting de la prueba admin", () => {
  const RL_EMAIL = `test-robotprueba-rl-${RUN_ID}@test.local`;
  const RL_TOKEN = `test-token-rp-rl-${RUN_ID}`;
  let rlId: number;

  beforeAll(async () => {
    const [u] = await db
      .insert(usersTable)
      .values({ email: RL_EMAIL, passwordHash: "x", nombre: "Admin RL", rol: "admin" })
      .returning();
    rlId = u!.id;
    await db.insert(sesionesTable).values({
      token: RL_TOKEN,
      usuarioId: rlId,
      activa: true,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
  });

  afterAll(async () => {
    await db.delete(sesionesTable).where(eq(sesionesTable.token, RL_TOKEN));
    await db.delete(usersTable).where(eq(usersTable.id, rlId));
  });

  it("permite 5 solicitudes por minuto y devuelve 429 en la sexta (protege del doble clic)", async () => {
    // Sin ROBOT_API_URL el cliente responde TECHNICAL_ERROR sin salir a la red,
    // pero el rate limiter cuenta igual cada solicitud que pasa las guardas.
    const urlPrevia = process.env.ROBOT_API_URL;
    delete process.env.ROBOT_API_URL;
    try {
      for (let i = 0; i < 5; i++) {
        const res = await post(RL_TOKEN, { token: "123456", dni: "30111222" });
        expect(res.status).toBe(200);
      }
      const sexta = await post(RL_TOKEN, { token: "123456", dni: "30111222" });
      expect(sexta.status).toBe(429);
      const body = (await sexta.json()) as { error: string };
      expect(body.error).toMatch(/Demasiadas/);
    } finally {
      if (urlPrevia !== undefined) process.env.ROBOT_API_URL = urlPrevia;
    }
  });
});

describe("enmascararToken (nunca exponer el token en logs)", () => {
  it("solo deja visibles los últimos 4 dígitos", async () => {
    const { enmascararToken } = await import("../integraciones/robot-cliente");
    expect(enmascararToken("123456789")).toBe("···6789");
    expect(enmascararToken("12")).toBe("···12");
    expect(enmascararToken("123456789")).not.toContain("12345");
  });
});

describe("normalizarCie10", () => {
  it("normaliza mayúsculas y espacios", () => {
    expect(normalizarCie10(" j06. 9 ")).toBe("J06.9");
    expect(normalizarCie10("")).toBeUndefined();
    expect(normalizarCie10(null)).toBeUndefined();
  });
});

// ── Secuencia completa contra un Robot simulado ──────────────────────────
// Prestación inexistente → carga manual → reintento (mismo request_id) →
// TOKEN_ACCEPTED → repetición del mismo request_id sin doble consumo.
describe("secuencia MANUAL_PRESTATION_REQUIRED → reintento idempotente (Robot simulado)", () => {
  let robotFalso: Server;
  let envPrevio: Record<string, string | undefined>;
  // Estado del Robot simulado por request_id
  const prestacionCargada = new Set<string>();
  const consumos = new Map<string, number>(); // veces que se "consumió" el token
  const headersVistos: Array<Record<string, string | undefined>> = [];

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.post("/api/v1/klinicos/token/validate", (req, res) => {
      headersVistos.push({
        auth: req.headers["authorization"] as string | undefined,
        apiKey: req.headers["x-api-key"] as string | undefined,
        idem: req.headers["idempotency-key"] as string | undefined,
      });
      if (req.headers["x-api-key"] !== "clave-test") {
        return void res.status(401).json({ error: "Clave de API inválida" });
      }
      const rid = String(req.body.request_id);
      if (!prestacionCargada.has(rid)) {
        return void res.json({
          request_id: rid,
          status: "MANUAL_PRESTATION_REQUIRED",
          token_validation_status: "PENDING",
          requires_manual_action: true,
          missing_fields: ["practice_code", "affiliate_number"],
          retry_allowed: true,
          reason_code: "PRESTATION_NOT_FOUND",
          reason_message: "La prestación no existe en KLINICOS. Debe cargarse manualmente.",
          latency_ms: 10,
        });
      }
      // Idempotencia: el mismo request_id NO consume dos veces
      if (!consumos.has(rid)) consumos.set(rid, 0);
      if (consumos.get(rid) === 0) consumos.set(rid, 1);
      return void res.json({
        request_id: rid,
        status: "TOKEN_ACCEPTED",
        authorization_number: `AUT-${rid.slice(0, 8)}`,
        klinicos_reference: `REF-${rid.slice(0, 8)}`,
        reason_message: "Token validado en KLINICOS",
        latency_ms: 12,
      });
    });
    await new Promise<void>((resolve) => {
      robotFalso = app.listen(0, () => resolve());
    });
    const addr = robotFalso.address();
    if (typeof addr === "string" || addr === null) throw new Error("Sin puerto");
    envPrevio = {
      ROBOT_API_URL: process.env.ROBOT_API_URL,
      ROBOT_API_KEY: process.env.ROBOT_API_KEY,
    };
    process.env.ROBOT_API_URL = `http://127.0.0.1:${addr.port}`;
    process.env.ROBOT_API_KEY = "clave-test";
  });

  afterAll(async () => {
    process.env.ROBOT_API_URL = envPrevio.ROBOT_API_URL;
    process.env.ROBOT_API_KEY = envPrevio.ROBOT_API_KEY;
    await new Promise<void>((resolve, reject) =>
      robotFalso.close((err) => (err ? reject(err) : resolve())),
    );
  });

  const payload = (rid: string) => ({
    request_id: rid,
    consultation_id: `prueba-${rid.slice(0, 8)}`,
    token: "654321",
    patient: { document_type: "DNI", document_number: "30111222" },
  });

  it("recorre contingencia → carga manual → reintento aceptado → repetición sin doble consumo", async () => {
    const rid = crypto.randomUUID();

    // 1) Prestación inexistente
    const r1 = await validarTokenConRobot(payload(rid));
    expect(r1.estado).toBe("MANUAL_PRESTATION_REQUIRED");
    expect(r1.codigo).toBe("PRESTATION_NOT_FOUND");
    expect(r1.camposFaltantes).toContain("practice_code");

    // 2) Carga manual en KLINICOS (simulada), conservando el request_id
    prestacionCargada.add(rid);

    // 3) Reintento con el MISMO request_id → aceptado
    const r2 = await validarTokenConRobot(payload(rid));
    expect(r2.estado).toBe("TOKEN_ACCEPTED");
    expect(r2.numeroAutorizacion).toBe(`AUT-${rid.slice(0, 8)}`);
    expect(r2.referenciaKlinicos).toBe(`REF-${rid.slice(0, 8)}`);

    // 4) Repetición del mismo request_id → misma respuesta, sin doble consumo
    const r3 = await validarTokenConRobot(payload(rid));
    expect(r3.estado).toBe("TOKEN_ACCEPTED");
    expect(r3.numeroAutorizacion).toBe(r2.numeroAutorizacion);
    expect(consumos.get(rid)).toBe(1);

    // Headers: nunca Bearer, siempre X-Api-Key + Idempotency-Key = request_id
    const deEsteRid = headersVistos.filter((h) => h.idem === rid);
    expect(deEsteRid.length).toBe(3);
    for (const h of deEsteRid) {
      expect(h.auth).toBeUndefined();
      expect(h.apiKey).toBe("clave-test");
    }
  });

  it("mapea TOKEN_DENIED, MANUAL_REVIEW, TECHNICAL_ERROR y estados desconocidos", async () => {
    // Robot ad hoc que responde según el token enviado
    const app2 = express();
    app2.use(express.json());
    app2.post("/api/v1/klinicos/token/validate", (req, res) => {
      const t = String(req.body.token);
      if (t === "denegado")
        return void res.json({
          status: "TOKEN_DENIED",
          reason_code: "TOKEN_INVALID",
          reason_message: "Token vencido o inválido",
        });
      if (t === "revision")
        return void res.json({ status: "MANUAL_REVIEW", reason_message: "Requiere supervisión" });
      if (t === "raro") return void res.json({ status: "ESTADO_INVENTADO" });
      return void res.status(500).json({ error: "boom" });
    });
    const srv2 = await new Promise<Server>((resolve) => {
      const s = app2.listen(0, () => resolve(s));
    });
    const addr2 = srv2.address();
    if (typeof addr2 === "string" || addr2 === null) throw new Error("Sin puerto");
    const urlPrevia = process.env.ROBOT_API_URL;
    process.env.ROBOT_API_URL = `http://127.0.0.1:${(addr2 as { port: number }).port}`;
    try {
      const denied = await validarTokenConRobot({ ...payload(crypto.randomUUID()), token: "denegado" });
      expect(denied.estado).toBe("TOKEN_DENIED");
      expect(denied.codigo).toBe("TOKEN_INVALID");

      const review = await validarTokenConRobot({ ...payload(crypto.randomUUID()), token: "revision" });
      expect(review.estado).toBe("MANUAL_REVIEW");

      // Estado desconocido NO es denegación: cae en TECHNICAL_ERROR
      const raro = await validarTokenConRobot({ ...payload(crypto.randomUUID()), token: "raro" });
      expect(raro.estado).toBe("TECHNICAL_ERROR");

      const err500 = await validarTokenConRobot({ ...payload(crypto.randomUUID()), token: "explota" });
      expect(err500.estado).toBe("TECHNICAL_ERROR");
      expect(err500.noAutenticado ?? false).toBe(false);
    } finally {
      process.env.ROBOT_API_URL = urlPrevia;
      await new Promise<void>((resolve, reject) =>
        srv2.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });

  it("mapea TIMEOUT cuando el Robot no responde a tiempo (conserva la semántica no-denegación)", async () => {
    const app3 = express();
    app3.use(express.json());
    app3.post("/api/v1/klinicos/token/validate", (_req, res) => {
      setTimeout(() => res.json({ status: "TOKEN_ACCEPTED" }), 500);
    });
    const srv3 = await new Promise<Server>((resolve) => {
      const s = app3.listen(0, () => resolve(s));
    });
    const addr3 = srv3.address();
    if (typeof addr3 === "string" || addr3 === null) throw new Error("Sin puerto");
    const urlPrevia = process.env.ROBOT_API_URL;
    const timeoutPrevio = process.env.ROBOT_TOKEN_VALIDATION_TIMEOUT_MS;
    process.env.ROBOT_API_URL = `http://127.0.0.1:${(addr3 as { port: number }).port}`;
    process.env.ROBOT_TOKEN_VALIDATION_TIMEOUT_MS = "50";
    try {
      const r = await validarTokenConRobot(payload(crypto.randomUUID()));
      expect(r.estado).toBe("TIMEOUT");
      expect(r.mensaje).not.toMatch(/denegad/i);
    } finally {
      process.env.ROBOT_API_URL = urlPrevia;
      if (timeoutPrevio === undefined) delete process.env.ROBOT_TOKEN_VALIDATION_TIMEOUT_MS;
      else process.env.ROBOT_TOKEN_VALIDATION_TIMEOUT_MS = timeoutPrevio;
      await new Promise<void>((resolve, reject) =>
        srv3.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });

  it("sin ROBOT_API_KEY configurada el request sale sin X-Api-Key y el Robot lo rechaza", async () => {
    const previa = process.env.ROBOT_API_KEY;
    delete process.env.ROBOT_API_KEY;
    try {
      const r = await validarTokenConRobot(payload(crypto.randomUUID()));
      expect(r.noAutenticado).toBe(true);
      expect(r.codigo).toBe("AUTH_ERROR");
      const ultimo = headersVistos[headersVistos.length - 1]!;
      expect(ultimo.apiKey).toBeUndefined();
      expect(ultimo.auth).toBeUndefined();
    } finally {
      process.env.ROBOT_API_KEY = previa;
    }
  });

  it("mapea HTTP 401 a error de autenticación amigable sin exponer detalles", async () => {
    const previa = process.env.ROBOT_API_KEY;
    process.env.ROBOT_API_KEY = "clave-mala";
    try {
      const r = await validarTokenConRobot(payload(crypto.randomUUID()));
      expect(r.noAutenticado).toBe(true);
      expect(r.codigo).toBe("AUTH_ERROR");
      expect(r.estado).toBe("TECHNICAL_ERROR");
      expect(r.mensaje).toMatch(/no está correctamente autenticada/);
      expect(r.mensaje).not.toMatch(/clave-mala/);
    } finally {
      process.env.ROBOT_API_KEY = previa;
    }
  });
});
