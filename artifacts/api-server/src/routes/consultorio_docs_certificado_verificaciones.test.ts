import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import pino from "pino";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  sesionesTable,
  pacientesTable,
  profesionalesTable,
  certificatesTable,
  certificadoVerificacionesTable,
} from "@workspace/db";
import consultorioDocsRouter from "./consultorio_docs";

// Tests de integración contra la DB de desarrollo. Crean sus propios datos
// (usuarios, sesiones, paciente, profesional, certificado y verificaciones) y
// los limpian al terminar.
//
// Verifican GET /api/consultorio/certificates/:id/verificaciones:
// - 401 sin token
// - 403 para roles NO de gestión (medico, paciente, recepcionista)
// - 200 para gestión (admin, gerente, desarrollador)
// - 404 certificado inexistente
// - la respuesta lista fecha/via/estadoAlMomento/ip/dispositivo en orden
//   descendente y NO expone el user-agent crudo

const RUN_ID = crypto.randomBytes(6).toString("hex");

let server: Server;
let baseUrl: string;

let pacienteId: number;
let profId: number;
let certId: number;

const TOKEN_ADMIN = `test-token-cv-admin-${RUN_ID}`;
const TOKEN_GERENTE = `test-token-cv-gerente-${RUN_ID}`;
const TOKEN_DEV = `test-token-cv-dev-${RUN_ID}`;
const TOKEN_MEDICO = `test-token-cv-medico-${RUN_ID}`;
const TOKEN_PACIENTE = `test-token-cv-paciente-${RUN_ID}`;
const TOKEN_RECEP = `test-token-cv-recep-${RUN_ID}`;

const userIds: number[] = [];

async function crearUsuarioConSesion(opts: {
  rol: string;
  token: string;
  profesionalId?: number;
  pacienteId?: number;
}): Promise<number> {
  const [user] = await db
    .insert(usersTable)
    .values({
      email: `test-cv-${opts.rol}-${crypto.randomBytes(4).toString("hex")}-${RUN_ID}@test.local`,
      passwordHash: "irrelevante",
      nombre: `Test ${opts.rol}`,
      rol: opts.rol,
      profesionalId: opts.profesionalId !== undefined ? String(opts.profesionalId) : undefined,
      pacienteId: opts.pacienteId !== undefined ? String(opts.pacienteId) : undefined,
    })
    .returning();
  userIds.push(user!.id);

  await db.insert(sesionesTable).values({
    token: opts.token,
    usuarioId: user!.id,
    activa: true,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return user!.id;
}

function getVerificaciones(id: number, token?: string): Promise<Response> {
  return fetch(`${baseUrl}/api/consultorio/certificates/${id}/verificaciones`, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
}

type Verificacion = {
  id: number;
  fecha: string;
  via: string;
  estadoAlMomento: string;
  ip: string | null;
  dispositivo: string | null;
};

beforeAll(async () => {
  const app = express();
  const silent = pino({ level: "silent" });
  app.use((req, _res, next) => {
    (req as unknown as { log: pino.Logger }).log = silent;
    next();
  });
  app.use(express.json());
  app.use("/api", consultorioDocsRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Sin puerto asignado");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const [pac] = await db
    .insert(pacientesTable)
    .values({ nombre: "Pac", apellido: `CertVerif${RUN_ID}`, dni: `CVRF${RUN_ID}`, activo: true })
    .returning();
  pacienteId = pac!.id;

  const [prof] = await db
    .insert(profesionalesTable)
    .values({ nombre: "Prof", apellido: `CV${RUN_ID}`, matricula: `MPCV-${RUN_ID}`, activo: true })
    .returning();
  profId = prof!.id;

  const adminId = await crearUsuarioConSesion({ rol: "admin", token: TOKEN_ADMIN });
  await crearUsuarioConSesion({ rol: "gerente", token: TOKEN_GERENTE });
  await crearUsuarioConSesion({ rol: "desarrollador", token: TOKEN_DEV });
  await crearUsuarioConSesion({ rol: "medico", token: TOKEN_MEDICO, profesionalId: profId });
  await crearUsuarioConSesion({ rol: "paciente", token: TOKEN_PACIENTE, pacienteId });
  await crearUsuarioConSesion({ rol: "recepcionista", token: TOKEN_RECEP });

  const [cert] = await db
    .insert(certificatesTable)
    .values({
      patientId: pacienteId,
      professionalId: profId,
      certificateType: "reposo",
      content: `Certificado de prueba ${RUN_ID}`,
      verificationCode: crypto.randomBytes(16).toString("hex"),
      createdBy: adminId,
    })
    .returning();
  certId = cert!.id;

  // Dos verificaciones con fechas distintas para verificar el orden descendente
  const base = Date.now();
  await db.insert(certificadoVerificacionesTable).values([
    {
      certificateId: certId,
      fecha: new Date(base - 60_000),
      estadoAlMomento: "valido",
      via: "qr_link",
      ip: "203.0.113.10",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
    },
    {
      certificateId: certId,
      fecha: new Date(base),
      estadoAlMomento: "valido",
      via: "descarga_pdf",
      ip: "203.0.113.20",
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Safari/604.1",
    },
  ]);
});

afterAll(async () => {
  await db.delete(certificadoVerificacionesTable).where(eq(certificadoVerificacionesTable.certificateId, certId));
  await db.delete(certificatesTable).where(eq(certificatesTable.id, certId));
  if (userIds.length > 0) {
    await db.delete(sesionesTable).where(inArray(sesionesTable.usuarioId, userIds));
    await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  }
  await db.delete(pacientesTable).where(eq(pacientesTable.id, pacienteId));
  await db.delete(profesionalesTable).where(eq(profesionalesTable.id, profId));
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

describe("GET /consultorio/certificates/:id/verificaciones", () => {
  it("401 sin token", async () => {
    const res = await getVerificaciones(certId);
    expect(res.status).toBe(401);
  });

  it("403 para medico, paciente y recepcionista (no gestión)", async () => {
    for (const token of [TOKEN_MEDICO, TOKEN_PACIENTE, TOKEN_RECEP]) {
      const res = await getVerificaciones(certId, token);
      expect(res.status).toBe(403);
    }
  });

  it("404 certificado inexistente (gestión)", async () => {
    const res = await getVerificaciones(99_999_999, TOKEN_ADMIN);
    expect(res.status).toBe(404);
  });

  it("gestión (admin/gerente/desarrollador) ve el historial completo", async () => {
    for (const token of [TOKEN_ADMIN, TOKEN_GERENTE, TOKEN_DEV]) {
      const res = await getVerificaciones(certId, token);
      expect(res.status).toBe(200);
      const filas = (await res.json()) as Verificacion[];
      expect(filas.length).toBe(2);
    }
  });

  it("orden descendente, medio y dispositivo aproximado; sin user-agent crudo", async () => {
    const res = await getVerificaciones(certId, TOKEN_ADMIN);
    const filas = (await res.json()) as Verificacion[];
    // Más reciente primero: la descarga del PDF
    expect(filas[0]!.via).toBe("descarga_pdf");
    expect(filas[1]!.via).toBe("qr_link");
    expect(new Date(filas[0]!.fecha).getTime()).toBeGreaterThan(new Date(filas[1]!.fecha).getTime());
    expect(filas[0]!.estadoAlMomento).toBe("valido");
    expect(filas[0]!.ip).toBe("203.0.113.20");
    expect(filas[0]!.dispositivo).toContain("iPhone");
    expect(filas[1]!.dispositivo).toBe("Chrome en Windows");
    for (const f of filas) {
      expect(f).not.toHaveProperty("userAgent");
    }
  });
});

describe("GET /consultorio/patients/:patientId/certificates — contador de verificaciones", () => {
  function getCertificados(token: string): Promise<Response> {
    return fetch(`${baseUrl}/api/consultorio/patients/${pacienteId}/certificates`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  it("gestión ve verificacionesCount y ultimaVerificacion en el listado", async () => {
    for (const token of [TOKEN_ADMIN, TOKEN_GERENTE, TOKEN_DEV]) {
      const res = await getCertificados(token);
      expect(res.status).toBe(200);
      const certs = (await res.json()) as Array<{ id: number; verificacionesCount?: number; ultimaVerificacion?: string | null }>;
      const c = certs.find((x) => x.id === certId);
      expect(c).toBeDefined();
      expect(c!.verificacionesCount).toBe(2);
      expect(c!.ultimaVerificacion).toBeTruthy();
    }
  });

  it("paciente ve su listado pero SIN los campos de verificaciones", async () => {
    const res = await getCertificados(TOKEN_PACIENTE);
    expect(res.status).toBe(200);
    const certs = (await res.json()) as Array<Record<string, unknown>>;
    const c = certs.find((x) => x.id === certId);
    expect(c).toBeDefined();
    expect(c).not.toHaveProperty("verificacionesCount");
    expect(c).not.toHaveProperty("ultimaVerificacion");
  });

  it("recepcionista (staff administrativo) ve el listado pero SIN los campos de verificaciones", async () => {
    // Cambio ago 2026: el staff administrativo también puede listar
    // certificados; el contador de verificaciones sigue siendo solo gestión.
    const res = await getCertificados(TOKEN_RECEP);
    expect(res.status).toBe(200);
    const certs = (await res.json()) as Array<Record<string, unknown>>;
    const c = certs.find((x) => x.id === certId);
    expect(c).toBeDefined();
    expect(c).not.toHaveProperty("verificacionesCount");
    expect(c).not.toHaveProperty("ultimaVerificacion");
  });
});
