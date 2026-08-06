import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { clinicaDBHealthCheck, getClinicaPool } from "../integraciones/clinica-db-init";
import { snapshotBaseActual, detectarDrift } from "../lib/esquema-drift";
import { requireRol } from "./auth";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

// Salud pública para monitoreo post-publicación (sin autenticación).
// Responde estado de la app + base de datos; 503 si la DB no responde.
router.get("/salud", async (_req, res) => {
  const inicio = Date.now();
  let db: { ok: boolean; error?: string };
  const enabled = getClinicaPool() !== null;
  if (!enabled) {
    db = { ok: false, error: "CLINICA_DB_URL no configurada" };
  } else {
    try {
      const r = await clinicaDBHealthCheck();
      db = r.ok ? { ok: true } : { ok: false, error: r.error ?? "sin detalle" };
    } catch (err) {
      db = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  const ok = db.ok;
  res.status(ok ? 200 : 503).json({
    ok,
    app: "ok",
    db,
    version: process.env.APP_VERSION ?? "0.0.0",
    entorno: process.env.NODE_ENV === "production" ? "produccion" : "desarrollo",
    latenciaDbMs: Date.now() - inicio,
    verificadoEn: new Date().toISOString(),
  });
});

router.get("/healthz-clinica", async (_req, res) => {
  const enabled = getClinicaPool() !== null;
  if (!enabled) {
    res.json({ ok: false, enabled: false, reason: "CLINICA_DB_URL no configurada" });
    return;
  }
  try {
    const result = await clinicaDBHealthCheck();
    res.status(result.ok ? 200 : 503).json({ ...result, enabled: true });
  } catch (err) {
    res.status(503).json({ ok: false, enabled: true, error: String(err) });
  }
});

// Reporte de drift dev↔prod: compara el esquema Drizzle (fuente de verdad)
// contra la base conectada (en prod publicada: conectar_app_prod en AWS).
// Solo lectura; la corrección aditiva corre sola al arrancar el server.
router.get("/infraestructura/esquema-drift", requireRol("admin"), async (_req, res) => {
  try {
    const snapshot = await snapshotBaseActual();
    const drift = detectarDrift(snapshot);
    res.json({
      ok: drift.tablasFaltantes.length === 0 && drift.columnasFaltantes.length === 0,
      tablasFaltantes: drift.tablasFaltantes.map((t) => ({ tabla: t.tabla, advertencias: t.advertencias })),
      columnasFaltantes: drift.columnasFaltantes.map((c) => ({
        tabla: c.tabla,
        columna: c.columna,
        ddl: c.ddl,
        advertencia: c.advertencia,
      })),
      verificadoEn: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// Reporte best-effort de errores de render del frontend (Error Boundary).
// Público a propósito: si la pantalla crasheó puede no haber sesión válida.
// Solo loguea al server para diagnóstico; nunca falla hacia el cliente.
router.post("/errores-frontend", (req, res) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const corto = (v: unknown, max: number) => String(v ?? "").slice(0, max);
    console.error("[frontend-error]", {
      mensaje: corto(b.mensaje, 500),
      url: corto(b.url, 300),
      userAgent: corto(b.userAgent, 200),
      stack: corto(b.stack, 2000),
      componentStack: corto(b.componentStack, 2000),
      recibidoEn: new Date().toISOString(),
    });
  } catch {
    // nunca romper por un reporte malformado
  }
  res.status(204).end();
});

export default router;
