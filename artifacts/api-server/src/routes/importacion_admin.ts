/**
 * Rutas de consulta y gestión de importaciones administrativas
 * (historial de runs + bandeja de conflictos).
 * Solo staff con rol "admin".
 */
import { Router, type IRouter } from "express";
import multer from "multer";
import { eq, desc, inArray } from "drizzle-orm";
import {
  db,
  importacionesAdminTable,
  importacionConflictosTable,
  turnerasTable,
} from "@workspace/db";
import { requireRol } from "./auth";
import { iniciarImportacionTurnosDetallados, hayImportacionTurnosEnCurso } from "../lib/importacion-turnos-detallados";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const soloAdmin = requireRol("admin");
const uploadXls = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

// ── Importación "Turnos detallados" de Alephoo ──────────────────────────────
// Sube el .xls (HTML) y corre la importación en background: sincroniza
// agendas (días/horarios/duración inferidos), upsertea pacientes e inserta
// los turnos con dedup. Escrituras directas sin automatizaciones (ni
// Klinicos ni Pixel). Progreso: GET /importaciones-admin/:runId.
let importacionTurnosEnCurso = false;
router.post("/importaciones-admin/turnos-detallados", soloAdmin, uploadXls.single("archivo"), async (req, res): Promise<void> => {
  if (!req.file) {
    res.status(400).json({ error: "Falta el archivo (campo 'archivo')" });
    return;
  }
  // Doble guard: flag en memoria (rápido) + run "procesando" en la base
  // (cubre múltiples instancias del servidor)
  if (importacionTurnosEnCurso || (await hayImportacionTurnosEnCurso())) {
    res.status(409).json({ error: "Ya hay una importación de turnos en curso; esperá a que termine" });
    return;
  }
  try {
    importacionTurnosEnCurso = true;
    const { runId, terminado } = iniciarImportacionTurnosDetallados(
      req.file.buffer,
      req.file.originalname || "turnos-detallados.xls",
      "endpoint importaciones-admin/turnos-detallados",
    );
    // El trabajo sigue en background; el flag se libera al terminar (ok o error)
    terminado
      .catch(() => {})
      .finally(() => { importacionTurnosEnCurso = false; });
    res.status(202).json({ runId, mensaje: "Importación iniciada; consultá el progreso con GET /importaciones-admin/:runId" });
  } catch (err) {
    importacionTurnosEnCurso = false;
    logger.error({ err }, "importaciones-admin: error iniciando importación de turnos detallados");
    res.status(500).json({ error: "No se pudo iniciar la importación" });
  }
});

// ── Historial de runs ────────────────────────────────────────────────────────

type ReutilizadaEntry = { turneraId: number; motivo: string };

/** Enriquece detalle.agendasReutilizadasDetalle con el nombre de cada turnera. */
async function enriquecerReutilizadas<T extends { detalle: unknown }>(
  runs: T[]
): Promise<T[]> {
  const ids = new Set<number>();
  for (const run of runs) {
    const det = run.detalle as { agendasReutilizadasDetalle?: ReutilizadaEntry[] } | null;
    for (const e of det?.agendasReutilizadasDetalle ?? []) {
      if (Number.isInteger(e?.turneraId)) ids.add(e.turneraId);
    }
  }
  if (ids.size === 0) return runs;
  const turneras = await db
    .select({ id: turnerasTable.id, nombre: turnerasTable.nombre })
    .from(turnerasTable)
    .where(inArray(turnerasTable.id, [...ids]));
  const nombres = new Map(turneras.map((t) => [t.id, t.nombre]));
  return runs.map((run) => {
    const det = run.detalle as { agendasReutilizadasDetalle?: ReutilizadaEntry[] } | null;
    if (!det?.agendasReutilizadasDetalle?.length) return run;
    return {
      ...run,
      detalle: {
        ...det,
        agendasReutilizadasDetalle: det.agendasReutilizadasDetalle.map((e) => ({
          ...e,
          turneraNombre: nombres.get(e.turneraId) ?? null,
        })),
      },
    };
  });
}

router.get("/importaciones-admin", soloAdmin, async (_req, res): Promise<void> => {
  const runs = await db
    .select()
    .from(importacionesAdminTable)
    .orderBy(desc(importacionesAdminTable.createdAt))
    .limit(50);
  res.json(await enriquecerReutilizadas(runs));
});

router.get("/importaciones-admin/:runId", soloAdmin, async (req, res): Promise<void> => {
  const runId = String(req.params.runId);
  const [run] = await db
    .select()
    .from(importacionesAdminTable)
    .where(eq(importacionesAdminTable.runId, runId))
    .limit(1);
  if (!run) {
    res.status(404).json({ error: "Run no encontrado" });
    return;
  }
  const conflictos = await db
    .select()
    .from(importacionConflictosTable)
    .where(eq(importacionConflictosTable.runId, runId))
    .orderBy(importacionConflictosTable.createdAt);
  const [runEnriquecido] = await enriquecerReutilizadas([run]);
  res.json({ run: runEnriquecido, conflictos });
});

// ── Bandeja de conflictos ────────────────────────────────────────────────────

router.get("/importaciones-admin-conflictos", soloAdmin, async (req, res): Promise<void> => {
  const soloAbiertos = req.query.abiertos !== "false";

  const query = db
    .select()
    .from(importacionConflictosTable)
    .orderBy(desc(importacionConflictosTable.createdAt))
    .limit(200);

  const conflictos = soloAbiertos
    ? await query.where(eq(importacionConflictosTable.resuelto, false))
    : await query;

  res.json(conflictos);
});

// ── Marcar conflicto como resuelto ────────────────────────────────────────────

router.patch(
  "/importaciones-admin-conflictos/:id/resolver",
  soloAdmin,
  async (req, res): Promise<void> => {
    const id = Number(String(req.params.id));
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "id inválido" });
      return;
    }
    const user = (req as unknown as { user?: { email?: string } }).user;
    const [updated] = await db
      .update(importacionConflictosTable)
      .set({
        resuelto: true,
        resueltoPor: user?.email ?? "admin",
        resueltoAt: new Date(),
      })
      .where(eq(importacionConflictosTable.id, id))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Conflicto no encontrado" });
      return;
    }
    res.json(updated);
  }
);

export default router;
