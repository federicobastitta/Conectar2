import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import pino from "pino";
import { like } from "drizzle-orm";
import { db, pacsEventosTable } from "@workspace/db";
import pacsWorkspaceRouter from "./pacs_workspace";
import {
  formatearAccession,
  generarAccessionNumber,
  ACCESSION_REGEX,
  verificarFirmaWebhook,
} from "../integraciones/pacs-workspace-v1";

// Tests de integración del Workspace PACS v1.0 (contrato congelado).
// Verifican: flag apagado → 404, firma HMAC del webhook, idempotencia por
// event_id y formato del accession number. Limpian sus propios datos.

const RUN_ID = crypto.randomBytes(6).toString("hex");
const SECRETO = `secreto-test-${RUN_ID}`;
const SECRETO_ANTERIOR = `secreto-viejo-${RUN_ID}`;

let server: Server;
let baseUrl: string;
let flagAnterior: string | undefined;
let secretoAnterior: string | undefined;
let secretoViejoAnterior: string | undefined;

function firmar(secreto: string, ts: number, body: string): string {
  return crypto.createHmac("sha256", secreto).update(`${ts}.${body}`).digest("hex");
}

function eventoBody(overrides: Record<string, unknown> = {}): { ts: number; body: string } {
  const ts = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    event_id: `evt-${RUN_ID}-${crypto.randomUUID()}`,
    event_type: "STUDY_RECEIVED",
    signature_ts: ts,
    occurred_at: new Date().toISOString(),
    order_id: "999999",
    study_instance_uid: "1.2.3.4.5",
    ...overrides,
  });
  return { ts, body };
}

async function postWebhook(body: string, firma?: string) {
  return fetch(`${baseUrl}/api/pacs/webhook/eventos`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(firma ? { "X-Conectar-Signature": firma } : {}),
    },
    body,
  });
}

beforeAll(async () => {
  flagAnterior = process.env.PACS_WORKSPACE_ENABLED;
  secretoAnterior = process.env.PACS_WEBHOOK_SECRET;
  secretoViejoAnterior = process.env.PACS_WEBHOOK_SECRET_ANTERIOR;
  process.env.PACS_WEBHOOK_SECRET = SECRETO;
  process.env.PACS_WEBHOOK_SECRET_ANTERIOR = SECRETO_ANTERIOR;

  const app = express();
  const silent = pino({ level: "silent" });
  app.use((req, _res, next) => {
    (req as unknown as { log: pino.Logger }).log = silent;
    next();
  });
  // Igual que app.ts: capturar body crudo para el webhook.
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        if (req.url?.startsWith("/api/pacs/webhook/")) {
          (req as express.Request & { rawBody?: string }).rawBody = buf.toString("utf8");
        }
      },
    }),
  );
  app.use("/api", pacsWorkspaceRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Sin puerto asignado");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (flagAnterior === undefined) delete process.env.PACS_WORKSPACE_ENABLED;
  else process.env.PACS_WORKSPACE_ENABLED = flagAnterior;
  if (secretoAnterior === undefined) delete process.env.PACS_WEBHOOK_SECRET;
  else process.env.PACS_WEBHOOK_SECRET = secretoAnterior;
  if (secretoViejoAnterior === undefined) delete process.env.PACS_WEBHOOK_SECRET_ANTERIOR;
  else process.env.PACS_WEBHOOK_SECRET_ANTERIOR = secretoViejoAnterior;
  await db.delete(pacsEventosTable).where(like(pacsEventosTable.eventId, `evt-${RUN_ID}-%`));
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("flag apagado (PACS_WORKSPACE_ENABLED=false)", () => {
  it("el webhook responde 404 como si no existiera", async () => {
    process.env.PACS_WORKSPACE_ENABLED = "false";
    const { ts, body } = eventoBody();
    const res = await postWebhook(body, firmar(SECRETO, ts, body));
    expect(res.status).toBe(404);
  });

  it("las rutas de workspace responden 404", async () => {
    process.env.PACS_WORKSPACE_ENABLED = "false";
    const res = await fetch(`${baseUrl}/api/pacs-workspace/ordenes/1/estudios`);
    expect(res.status).toBe(404);
  });
});

describe("webhook con flag encendido", () => {
  it("rechaza firma inválida con 401", async () => {
    process.env.PACS_WORKSPACE_ENABLED = "true";
    const { body } = eventoBody();
    const res = await postWebhook(body, "00".repeat(32));
    expect(res.status).toBe(401);
  });

  it("rechaza sin header de firma con 401", async () => {
    process.env.PACS_WORKSPACE_ENABLED = "true";
    const { body } = eventoBody();
    const res = await postWebhook(body);
    expect(res.status).toBe(401);
  });

  it("rechaza signature_ts fuera de la ventana anti-replay", async () => {
    process.env.PACS_WORKSPACE_ENABLED = "true";
    const tsViejo = Math.floor(Date.now() / 1000) - 3600;
    const { body } = eventoBody({ signature_ts: tsViejo });
    const res = await postWebhook(body, firmar(SECRETO, tsViejo, body));
    expect(res.status).toBe(401);
  });

  it("acepta firma válida y registra el evento", async () => {
    process.env.PACS_WORKSPACE_ENABLED = "true";
    const { ts, body } = eventoBody();
    const res = await postWebhook(body, firmar(SECRETO, ts, body));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; duplicado?: boolean };
    expect(json.ok).toBe(true);
    expect(json.duplicado).toBeUndefined();
  });

  it("acepta firma con el secreto anterior (rotación)", async () => {
    process.env.PACS_WORKSPACE_ENABLED = "true";
    const { ts, body } = eventoBody();
    const res = await postWebhook(body, firmar(SECRETO_ANTERIOR, ts, body));
    expect(res.status).toBe(200);
  });

  it("el mismo event_id duplicado responde 200 sin reprocesar", async () => {
    process.env.PACS_WORKSPACE_ENABLED = "true";
    const { ts, body } = eventoBody();
    const firma = firmar(SECRETO, ts, body);
    const primera = await postWebhook(body, firma);
    expect(primera.status).toBe(200);
    const segunda = await postWebhook(body, firma);
    expect(segunda.status).toBe(200);
    const json = (await segunda.json()) as { ok: boolean; duplicado?: boolean };
    expect(json.duplicado).toBe(true);
  });
});

describe("accession number (CM-1)", () => {
  it("formatea C{AA}-{12 dígitos}", () => {
    expect(formatearAccession("26", 1)).toBe("C26-000000000001");
    expect(formatearAccession("26", 123456)).toBe("C26-000000123456");
    expect(ACCESSION_REGEX.test("C26-000000000001")).toBe(true);
    expect(ACCESSION_REGEX.test("ORD-2026-001234")).toBe(false);
  });

  it("genera accessions únicos y con formato válido desde la secuencia", async () => {
    const a = await generarAccessionNumber();
    const b = await generarAccessionNumber();
    expect(a).toMatch(ACCESSION_REGEX);
    expect(b).toMatch(ACCESSION_REGEX);
    expect(a).not.toBe(b);
  });
});

describe("verificarFirmaWebhook (unidad)", () => {
  it("valida y rechaza correctamente", () => {
    const ts = Math.floor(Date.now() / 1000);
    const body = '{"event_id":"x"}';
    const firma = firmar(SECRETO, ts, body);
    expect(verificarFirmaWebhook(body, firma, ts).ok).toBe(true);
    expect(verificarFirmaWebhook(body, firma, ts + 9999, ts + 9999).ok).toBe(false);
    expect(verificarFirmaWebhook(`${body} `, firma, ts).ok).toBe(false);
  });
});
