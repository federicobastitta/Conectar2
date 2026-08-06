import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

// ── Eventos de turnos para el Robot Klinicos (pull) ───────────────────────
// El Robot externo consulta este endpoint cada 5 minutos como complemento de
// los webhooks: pide páginas de eventos con cursor desdeId. Mismo esquema de
// autenticación que el padrón: header x-api-key contra ROBOT_API_KEY,
// comparación en tiempo constante. Nunca 200 con error en el body.

const router: IRouter = Router();

function claveValida(provista: string | undefined): boolean {
  const esperada = process.env.ROBOT_API_KEY?.trim();
  if (!esperada || !provista) return false;
  const a = Buffer.from(provista);
  const b = Buffer.from(esperada);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function requireRobotApiKey(req: Request, res: Response, next: NextFunction): void {
  if (!process.env.ROBOT_API_KEY?.trim()) {
    res.status(503).json({ error: "Integración Robot no configurada" });
    return;
  }
  if (!claveValida(req.header("x-api-key"))) {
    req.log.warn("robot-turnos-eventos: intento de acceso con x-api-key inválida o faltante");
    res.status(401).json({ error: "Clave de API inválida o faltante" });
    return;
  }
  next();
}

// Scopear SOLO a este prefijo para no filtrar el middleware a otros routers.
router.use("/robot-klinicos/turnos", requireRobotApiKey);

// ── GET /robot-klinicos/turnos/eventos ────────────────────────────────────
// ?desdeId=<n>&limit=<1..500> — eventos con eventoId > desdeId, orden
// ascendente. Respuesta: { eventos: [...], siguienteId, total }.
// siguienteId: eventoId desde donde seguir (null si no quedan más).
// total: eventos restantes con eventoId > desdeId (incluye esta página).
router.get("/robot-klinicos/turnos/eventos", async (req, res): Promise<void> => {
  const desdeIdRaw = req.query.desdeId;
  const limitRaw = req.query.limit;

  const desdeId = desdeIdRaw != null ? Number(desdeIdRaw) : 0;
  const limit = limitRaw != null ? Number(limitRaw) : 200;

  if (!Number.isInteger(desdeId) || desdeId < 0) {
    res.status(400).json({ error: "desdeId inválido: debe ser un entero >= 0" });
    return;
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    res.status(400).json({ error: "limit inválido: debe ser un entero entre 1 y 500" });
    return;
  }

  const [pagina, conteo] = await Promise.all([
    db.execute(sql`
      SELECT id, turno_id, version, evento, payload
      FROM robot_turnos_eventos
      WHERE id > ${desdeId}
      ORDER BY id ASC
      LIMIT ${limit}
    `),
    db.execute(
      sql`SELECT count(*)::int AS total FROM robot_turnos_eventos WHERE id > ${desdeId}`,
    ),
  ]);

  const eventos = pagina.rows.map((r) => {
    const fila = r as { id: number; version: number; evento: string; payload: unknown };
    const payload =
      fila.payload && typeof fila.payload === "object"
        ? (fila.payload as Record<string, unknown>)
        : {};
    return {
      eventoId: Number(fila.id),
      evento: fila.evento,
      version: Number(fila.version),
      ...payload,
    };
  });

  const total = Number((conteo.rows[0] as { total?: number } | undefined)?.total ?? 0);
  const ultimo = eventos.length > 0 ? eventos[eventos.length - 1]!.eventoId : null;
  const siguienteId = ultimo !== null && total > eventos.length ? ultimo : null;

  req.log.info(
    { desdeId, limit, devueltos: eventos.length, siguienteId, total },
    "robot-turnos-eventos: página de eventos entregada al Robot",
  );

  res.json({ eventos, siguienteId, total });
});

export default router;
