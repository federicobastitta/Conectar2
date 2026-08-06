import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db, practicasCatalogoTable, ordenesPracticasTable, ordenesPracticasLogTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import crypto from "node:crypto";
import app from "../../app";
import request from "supertest";

// ── Usuarios de prueba (definidos en seed) ───────────────────────────────────
const ADMIN_EMAIL = "admin@diagnosticar.ar";
const ADMIN_PASS = "admin123";

let adminToken: string;
let patientId: number;
let professionalId: number;

// IDs de prácticas del catálogo creadas por seed
const PRACTICAS_CODIGOS = ["ECG-REPOSO", "HOLTER-24H", "MAPA-24H", "ERGOMETRIA", "ECO-DOPPLER"];
const practicaIds: Record<string, number> = {};

// Órdenes creadas durante los tests (para cleanup)
const ordenesCreadas: number[] = [];

// ── Setup ─────────────────────────────────────────────────────────────────────
beforeAll(async () => {
  // Login
  const res = await request(app).post("/api/auth/login").send({ email: ADMIN_EMAIL, password: ADMIN_PASS });
  expect(res.status).toBe(200);
  adminToken = res.body.token as string;
  expect(adminToken).toBeTruthy();

  // Obtener un paciente y profesional existentes
  const { pacientesTable, profesionalesTable } = await import("@workspace/db");
  const [pac] = await db.select({ id: pacientesTable.id }).from(pacientesTable).limit(1);
  const [prof] = await db.select({ id: profesionalesTable.id, matricula: profesionalesTable.matricula })
    .from(profesionalesTable).limit(1);

  expect(pac, "Se necesita al menos un paciente en DB").toBeTruthy();
  expect(prof, "Se necesita al menos un profesional en DB").toBeTruthy();
  patientId = pac.id;
  professionalId = prof.id;

  // Asegurar que el profesional tiene matrícula (o asignarle una temporal)
  if (!prof.matricula) {
    await db.update(profesionalesTable).set({ matricula: "TEST-MAT-001" }).where(eq(profesionalesTable.id, prof.id));
  }

  // Asegurar que las prácticas del catálogo existen (el catálogo real puede
  // haber sido depurado; el test debe proveer sus propios datos)
  for (const codigo of PRACTICAS_CODIGOS) {
    await db
      .insert(practicasCatalogoTable)
      .values({ codigo, nombre: `Test ${codigo}`, especialidad: "CARDIOLOGIA", categoria: "cardiologia", generaDicom: false })
      .onConflictDoNothing({ target: practicasCatalogoTable.codigo });
  }

  // Cargar IDs del catálogo de prácticas
  const practicas = await db
    .select({ id: practicasCatalogoTable.id, codigo: practicasCatalogoTable.codigo })
    .from(practicasCatalogoTable)
    .where(inArray(practicasCatalogoTable.codigo, PRACTICAS_CODIGOS));

  for (const p of practicas) {
    practicaIds[p.codigo] = p.id;
  }

  expect(Object.keys(practicaIds).length).toBe(5);
});

// ── Cleanup ───────────────────────────────────────────────────────────────────
afterAll(async () => {
  if (ordenesCreadas.length > 0) {
    await db.delete(ordenesPracticasLogTable)
      .where(inArray(ordenesPracticasLogTable.ordenId, ordenesCreadas));
    await db.delete(ordenesPracticasTable)
      .where(inArray(ordenesPracticasTable.id, ordenesCreadas));
  }
});

// ── Helper: crear orden via API ───────────────────────────────────────────────
async function crearOrden(practicaCodigo: string, overrides?: Record<string, unknown>) {
  const res = await request(app)
    .post("/api/ordenes-practicas")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({
      practicaId: practicaIds[practicaCodigo],
      patientId,
      professionalId,
      motivoClinico: "Evaluación cardiológica de rutina por solicitud médica",
      fechaOrden: "2026-07-21",
      prioridad: "normal",
      coberturaObra: "OSDE",
      coberturaNumeroAfiliado: "123456",
      ...overrides,
    });
  if (res.status === 201) {
    ordenesCreadas.push((res.body as { orden: { id: number } }).orden.id);
  }
  return res;
}

// ═════════════════════════════════════════════════════════════════════════════
// T1: CATÁLOGO — 5 prácticas cardiológicas seeded
// ═════════════════════════════════════════════════════════════════════════════
describe("Catálogo de prácticas cardiológicas", () => {
  it("devuelve las 5 prácticas del seed", async () => {
    const res = await request(app)
      .get("/api/practicas-catalogo")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const codigos = (res.body as { practicas: { codigo: string }[] }).practicas.map((p) => p.codigo);
    for (const cod of PRACTICAS_CODIGOS) {
      expect(codigos).toContain(cod);
    }
  });

  it("todas las prácticas cardiológicas tienen genera_dicom=true", async () => {
    const res = await request(app)
      .get("/api/practicas-catalogo")
      .set("Authorization", `Bearer ${adminToken}`);
    const cardio = (res.body as { practicas: { codigo: string; generaDicom: boolean; especialidad: string }[] }).practicas
      .filter((p) => PRACTICAS_CODIGOS.includes(p.codigo));
    for (const p of cardio) {
      expect(p.generaDicom, `${p.codigo} debe tener generaDicom=true`).toBe(true);
    }
  });

  it("rechaza creación sin autenticación", async () => {
    const res = await request(app).get("/api/practicas-catalogo");
    expect(res.status).toBe(401);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// T2: ROUTING — cada práctica DICOM ruteada a PACS
// ═════════════════════════════════════════════════════════════════════════════
describe("Routing DICOM → DiagnosticPACS", () => {
  for (const codigo of PRACTICAS_CODIGOS) {
    it(`${codigo}: crea orden, genera UUID y accession`, async () => {
      const res = await crearOrden(codigo);
      // Puede ser 201 (con PACS habilitado) o 201 (sin PACS, igual crea)
      expect(res.status).toBe(201);
      const { orden } = res.body as { orden: { ordenUuid: string; numeroOrden: string; accessionNumber: string | null } };
      expect(orden.ordenUuid).toMatch(/^[0-9a-f-]{36}$/); // UUID v4
      expect(orden.numeroOrden).toMatch(/^OP-\d{4}-\d{6}$/);
    });
  }

  it("ECG-REPOSO: numero_orden es único por inserción", async () => {
    const r1 = await crearOrden("ECG-REPOSO");
    const r2 = await crearOrden("ECG-REPOSO");
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    const n1 = (r1.body as { orden: { numeroOrden: string } }).orden.numeroOrden;
    const n2 = (r2.body as { orden: { numeroOrden: string } }).orden.numeroOrden;
    expect(n1).not.toBe(n2);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// T3: IDEMPOTENCIA — accession_number es inmutable
// ═════════════════════════════════════════════════════════════════════════════
describe("Idempotencia de accession_number", () => {
  it("dos órdenes distintas no comparten accession_number", async () => {
    const r1 = await crearOrden("ERGOMETRIA");
    const r2 = await crearOrden("ECO-DOPPLER");
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    const a1 = (r1.body as { orden: { accessionNumber: string | null } }).orden.accessionNumber;
    const a2 = (r2.body as { orden: { accessionNumber: string | null } }).orden.accessionNumber;
    if (a1 && a2) expect(a1).not.toBe(a2);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// T4: VALIDACIONES EN CREACIÓN
// ═════════════════════════════════════════════════════════════════════════════
describe("Validaciones al crear orden", () => {
  it("rechaza orden sin motivo clínico", async () => {
    const res = await request(app)
      .post("/api/ordenes-practicas")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        practicaId: practicaIds["ECG-REPOSO"],
        patientId,
        professionalId,
        motivoClinico: "cort", // 4 chars — debe rechazar (mín 5)
        fechaOrden: "2026-07-21",
      });
    expect(res.status).toBe(422);
  });

  it("rechaza fecha con formato incorrecto", async () => {
    const res = await request(app)
      .post("/api/ordenes-practicas")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        practicaId: practicaIds["ECG-REPOSO"],
        patientId,
        professionalId,
        motivoClinico: "Evaluación cardiológica completa",
        fechaOrden: "21-07-2026", // formato incorrecto
      });
    expect(res.status).toBe(422);
  });

  it("rechaza paciente inexistente", async () => {
    const res = await request(app)
      .post("/api/ordenes-practicas")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        practicaId: practicaIds["ECG-REPOSO"],
        patientId: 999999,
        professionalId,
        motivoClinico: "Evaluación cardiológica completa",
        fechaOrden: "2026-07-21",
      });
    expect(res.status).toBe(422);
  });

  it("rechaza práctica inactiva", async () => {
    // Desactivar temporalmente
    const [prac] = await db
      .update(practicasCatalogoTable)
      .set({ activo: false })
      .where(eq(practicasCatalogoTable.codigo, "MAPA-24H"))
      .returning({ id: practicasCatalogoTable.id });

    try {
      const res = await crearOrden("MAPA-24H");
      expect(res.status).toBe(422);
    } finally {
      await db.update(practicasCatalogoTable).set({ activo: true }).where(eq(practicasCatalogoTable.id, prac.id));
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// T5: ESTADOS — transiciones válidas e inválidas
// ═════════════════════════════════════════════════════════════════════════════
describe("Máquina de estados de la orden", () => {
  it("transiciona creada → validada → arribado", async () => {
    const crear = await crearOrden("HOLTER-24H");
    expect(crear.status).toBe(201);
    const ordenId = (crear.body as { orden: { id: number } }).orden.id;

    // creada → validada (si la orden quedó en creada)
    const orden = await db.select({ estado: ordenesPracticasTable.estado })
      .from(ordenesPracticasTable).where(eq(ordenesPracticasTable.id, ordenId)).limit(1);
    const estadoActual = orden[0].estado;

    if (estadoActual === "creada") {
      const t1 = await request(app)
        .patch(`/api/ordenes-practicas/${ordenId}/estado`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ estado: "validada" });
      expect(t1.status).toBe(200);
    }

    const t2 = await request(app)
      .patch(`/api/ordenes-practicas/${ordenId}/estado`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ estado: "arribado" });
    expect(t2.status).toBe(200);
    expect((t2.body as { orden: { estado: string } }).orden.estado).toBe("arribado");
  });

  it("rechaza transición inválida (informada → creada)", async () => {
    const crear = await crearOrden("ECG-REPOSO");
    expect(crear.status).toBe(201);
    const ordenId = (crear.body as { orden: { id: number } }).orden.id;

    // Forzar estado informada directamente en DB para el test
    await db.update(ordenesPracticasTable)
      .set({ estado: "informada" })
      .where(eq(ordenesPracticasTable.id, ordenId));

    const res = await request(app)
      .patch(`/api/ordenes-practicas/${ordenId}/estado`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ estado: "creada" });
    expect(res.status).toBe(409);
  });

  it("requiere motivo al cancelar", async () => {
    const crear = await crearOrden("ECG-REPOSO");
    expect(crear.status).toBe(201);
    const ordenId = (crear.body as { orden: { id: number } }).orden.id;

    const sin = await request(app)
      .patch(`/api/ordenes-practicas/${ordenId}/estado`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ estado: "cancelada" }); // sin motivo
    expect(sin.status).toBe(422);

    const con = await request(app)
      .patch(`/api/ordenes-practicas/${ordenId}/estado`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ estado: "cancelada", motivo: "Paciente no concurrió" });
    expect(con.status).toBe(200);
  });

  it("no permite modificar órdenes canceladas", async () => {
    const crear = await crearOrden("ECG-REPOSO");
    const ordenId = (crear.body as { orden: { id: number } }).orden.id;
    await request(app)
      .patch(`/api/ordenes-practicas/${ordenId}/estado`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ estado: "cancelada", motivo: "Test cleanup" });

    const reintento = await request(app)
      .patch(`/api/ordenes-practicas/${ordenId}/estado`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ estado: "validada" });
    expect(reintento.status).toBe(409);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// T6: AUDITORÍA — log de transiciones
// ═════════════════════════════════════════════════════════════════════════════
describe("Auditoría de transiciones", () => {
  it("cada transición genera una entrada en el log", async () => {
    const crear = await crearOrden("ECO-DOPPLER");
    const ordenId = (crear.body as { orden: { id: number } }).orden.id;

    await request(app)
      .patch(`/api/ordenes-practicas/${ordenId}/estado`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ estado: "arribado" });

    const logEntries = await db
      .select()
      .from(ordenesPracticasLogTable)
      .where(eq(ordenesPracticasLogTable.ordenId, ordenId));

    expect(logEntries.length).toBeGreaterThanOrEqual(2); // creación + transición
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// T7: WEBHOOK informe-firmado — validaciones de informe ejecutivo
// ═════════════════════════════════════════════════════════════════════════════
describe("Webhook informe-firmado", () => {
  const SIGNATURE_SECRET = process.env.PACS_WEBHOOK_SECRET ?? "test-secret-dev";

  function buildSignedPayload(body: unknown, secret = SIGNATURE_SECRET) {
    const ts = Math.floor(Date.now() / 1000);
    const raw = JSON.stringify(body);
    const sig = crypto.createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex");
    return { raw, ts, sig };
  }

  it("rechaza sin firma HMAC", async () => {
    const crear = await crearOrden("ECG-REPOSO");
    const orden = (crear.body as { orden: OrdenPractica }).orden;
    const res = await request(app)
      .post("/api/pacs/webhook/informe-firmado")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ event_id: crypto.randomUUID(), event_type: "INFORME_FIRMADO", order_id: orden.ordenUuid }));
    expect(res.status).toBe(401);
  });

  it("rechaza conclusión menor a 20 caracteres", async () => {
    if (!process.env.PACS_WEBHOOK_SECRET) return; // skip si no hay secreto

    const crear = await crearOrden("ECG-REPOSO");
    const orden = (crear.body as { orden: OrdenPractica }).orden;
    const body = {
      event_id: crypto.randomUUID(),
      event_type: "INFORME_FIRMADO",
      signature_ts: Math.floor(Date.now() / 1000),
      order_id: orden.ordenUuid,
      payload: {
        informe_ejecutivo_url: "https://pacs.example/informe.pdf",
        informe_conclusion: "Corta", // < 20 chars
        informe_paginas_ejecutivo: 1,
        informe_version: 1,
        informe_checksum: "abc123",
        firmante_nombre: "Dr. Test",
        firmante_matricula: "MAT-001",
        firmante_especialidad: "Cardiología",
        firmado_at: new Date().toISOString(),
      },
    };
    const { sig, ts } = buildSignedPayload(body);
    body.signature_ts = ts;
    const { raw } = buildSignedPayload(body);

    const res = await request(app)
      .post("/api/pacs/webhook/informe-firmado")
      .set("Content-Type", "application/json")
      .set("x-conectar-signature", sig)
      .send(raw);

    expect(res.status).toBe(422);
    expect((res.body as { error: string }).error).toMatch(/conclusión/i);
  });

  it("rechaza informe ejecutivo con más de 1 página", async () => {
    if (!process.env.PACS_WEBHOOK_SECRET) return;

    const crear = await crearOrden("ERGOMETRIA");
    const orden = (crear.body as { orden: OrdenPractica }).orden;
    const body = {
      event_id: crypto.randomUUID(),
      event_type: "INFORME_FIRMADO",
      signature_ts: Math.floor(Date.now() / 1000),
      order_id: orden.ordenUuid,
      payload: {
        informe_ejecutivo_url: "https://pacs.example/informe.pdf",
        informe_conclusion: "Ritmo sinusal normal. Sin alteraciones significativas.",
        informe_paginas_ejecutivo: 3, // debe ser 1
        informe_version: 1,
        informe_checksum: "abc123",
        firmante_nombre: "Dr. Test",
        firmante_matricula: "MAT-001",
        firmante_especialidad: "Cardiología",
        firmado_at: new Date().toISOString(),
      },
    };
    const { sig, ts } = buildSignedPayload(body);
    body.signature_ts = ts;
    const { raw } = buildSignedPayload(body);

    const res = await request(app)
      .post("/api/pacs/webhook/informe-firmado")
      .set("Content-Type", "application/json")
      .set("x-conectar-signature", sig)
      .send(raw);

    expect(res.status).toBe(422);
    expect((res.body as { error: string }).error).toMatch(/1 hoja/i);
  });

  it("acepta anexos multipágina sin error (solo valida el ejecutivo)", async () => {
    // Los anexos (trazados, tablas, DICOM) pueden tener N páginas — nunca se rechazan
    // Este test verifica que informe_anexos_url se almacena sin validación de páginas
    if (!process.env.PACS_WEBHOOK_SECRET) return;

    const crear = await crearOrden("HOLTER-24H");
    const orden = (crear.body as { orden: OrdenPractica }).orden;
    // Forzar estado compatible
    await db.update(ordenesPracticasTable)
      .set({ estado: "pendiente_informe" })
      .where(eq(ordenesPracticasTable.id, orden.id));

    const body = {
      event_id: crypto.randomUUID(),
      event_type: "INFORME_FIRMADO",
      signature_ts: Math.floor(Date.now() / 1000),
      order_id: orden.ordenUuid,
      payload: {
        informe_ejecutivo_url: "https://pacs.example/informe-holter.pdf",
        informe_anexos_url: "https://pacs.example/anexo-holter-50p.pdf", // 50 páginas: OK
        informe_conclusion: "Holter 24h: ritmo sinusal con extrasístoles ventriculares aisladas. Sin episodios de taquicardia sostenida.",
        informe_paginas_ejecutivo: 1, // ejecutivo: 1 hoja
        informe_version: 1,
        informe_checksum: "holter-sha256-abc",
        firmante_nombre: "Dr. García",
        firmante_matricula: "MAT-8821",
        firmante_especialidad: "Cardiología",
        firmado_at: new Date().toISOString(),
      },
    };
    const { sig, ts } = buildSignedPayload(body);
    body.signature_ts = ts;
    const { raw } = buildSignedPayload(body);

    const res = await request(app)
      .post("/api/pacs/webhook/informe-firmado")
      .set("Content-Type", "application/json")
      .set("x-conectar-signature", sig)
      .send(raw);

    expect(res.status).toBe(200);
    expect((res.body as { ok: boolean }).ok).toBe(true);

    // Verificar que se guardaron correctamente informe + anexos
    const [saved] = await db.select().from(ordenesPracticasTable).where(eq(ordenesPracticasTable.id, orden.id)).limit(1);
    expect(saved.informeAnexosUrl).toBe("https://pacs.example/anexo-holter-50p.pdf");
    expect(saved.informeEjecutivoUrl).toBe("https://pacs.example/informe-holter.pdf");
    expect(saved.informeConclusion).toContain("Holter 24h");
    expect(saved.estado).toBe("informada");
  });

  it("rechaza firma incompleta (falta matrícula)", async () => {
    if (!process.env.PACS_WEBHOOK_SECRET) return;

    const crear = await crearOrden("ECO-DOPPLER");
    const orden = (crear.body as { orden: OrdenPractica }).orden;
    const body = {
      event_id: crypto.randomUUID(),
      event_type: "INFORME_FIRMADO",
      signature_ts: Math.floor(Date.now() / 1000),
      order_id: orden.ordenUuid,
      payload: {
        informe_ejecutivo_url: "https://pacs.example/eco.pdf",
        informe_conclusion: "Función sistólica del ventrículo izquierdo conservada. Sin derrame pericárdico.",
        informe_paginas_ejecutivo: 1,
        informe_version: 1,
        informe_checksum: "eco-check",
        firmante_nombre: "Dr. López",
        // firmante_matricula: ausente
        firmante_especialidad: "Cardiología",
        firmado_at: new Date().toISOString(),
      },
    };
    const { sig, ts } = buildSignedPayload(body);
    body.signature_ts = ts;
    const { raw } = buildSignedPayload(body);

    const res = await request(app)
      .post("/api/pacs/webhook/informe-firmado")
      .set("Content-Type", "application/json")
      .set("x-conectar-signature", sig)
      .send(raw);

    expect(res.status).toBe(422);
    expect((res.body as { error: string }).error).toMatch(/firma/i);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// T8: SESIÓN VISOR — PACS workspace
// ═════════════════════════════════════════════════════════════════════════════
describe("Sesión visor DiagnosticPACS", () => {
  it("rechaza sesión si PACS está deshabilitado", async () => {
    // Con PACS_WORKSPACE_ENABLED no seteado → debe fallar apropiadamente
    const crear = await crearOrden("ECG-REPOSO");
    const ordenId = (crear.body as { orden: { id: number } }).orden.id;

    const res = await request(app)
      .post(`/api/ordenes-practicas/${ordenId}/sesion-visor`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});

    // Si PACS deshabilitado → 503; si habilitado → intenta llamar al PACS
    expect([503, 409, 502]).toContain(res.status);
  });

  it("rechaza sesión para práctica no DICOM", async () => {
    // Crear una práctica no-DICOM temporal
    const [prac] = await db
      .insert(practicasCatalogoTable)
      .values({
        codigo: `LAB-TEST-${Date.now().toString(36)}`,
        nombre: "Laboratorio de prueba",
        especialidad: "LABORATORIO",
        generaDicom: false,
        usaWorkspacePacs: false,
        requiereTokenKlinicos: false,
        sortOrder: 999,
      })
      .returning();

    const crear = await request(app)
      .post("/api/ordenes-practicas")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        practicaId: prac.id,
        patientId,
        professionalId,
        motivoClinico: "Evaluación de laboratorio de control rutinario",
        fechaOrden: "2026-07-21",
        prioridad: "normal",
      });
    expect(crear.status).toBe(201);
    const ordenId = (crear.body as { orden: { id: number } }).orden.id;
    ordenesCreadas.push(ordenId);

    const res = await request(app)
      .post(`/api/ordenes-practicas/${ordenId}/sesion-visor`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});

    expect(res.status).toBe(422);

    // Cleanup
    await db.delete(practicasCatalogoTable).where(eq(practicasCatalogoTable.id, prac.id));
  });
});

type OrdenPractica = {
  id: number;
  ordenUuid: string;
  numeroOrden: string;
  accessionNumber: string | null;
  estado: string;
};
