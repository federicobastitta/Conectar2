import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { and, asc, eq, gt, isNotNull, sql } from "drizzle-orm";
import { db, pacientesTable } from "@workspace/db";

// ── Padrón de pacientes para el Robot Klinicos ────────────────────────────
// El Robot externo ("Centro de Control Klinicos") consume este endpoint para
// dar de alta pacientes en KLINICOS (decisión del usuario, jul 2026 — antes el
// alta era exclusivamente manual). Autenticación entrante: header x-api-key
// comparado en tiempo constante contra ROBOT_API_KEY (la misma clave compartida
// que usamos para llamar al Robot). Solo lectura, sin datos clínicos.

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
    req.log.warn("robot-padron: intento de acceso con x-api-key inválida o faltante");
    res.status(401).json({ error: "Clave de API inválida o faltante" });
    return;
  }
  next();
}

// Scopear SOLO a este prefijo para no filtrar el middleware a otros routers.
router.use("/robot-klinicos/padron", requireRobotApiKey);

// ── GET /robot-klinicos/padron ────────────────────────────────────────────
// Paginación por keyset: ?desdeId=<último id recibido>&limit=<1..1000>
// Devuelve pacientes activos con DNI, ordenados por id ascendente.
// Respuesta: { pacientes: [...], siguienteId: number | null, total: number }
router.get("/robot-klinicos/padron", async (req, res): Promise<void> => {
  const desdeIdRaw = req.query.desdeId;
  const limitRaw = req.query.limit;

  const desdeId = desdeIdRaw != null ? Number(desdeIdRaw) : 0;
  const limit = limitRaw != null ? Number(limitRaw) : 500;

  if (!Number.isInteger(desdeId) || desdeId < 0) {
    res.status(400).json({ error: "desdeId inválido: debe ser un entero >= 0" });
    return;
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    res.status(400).json({ error: "limit inválido: debe ser un entero entre 1 y 1000" });
    return;
  }

  const dniPresente = sql`btrim(${pacientesTable.dni}) <> ''`;

  const condiciones = and(
    eq(pacientesTable.activo, true),
    isNotNull(pacientesTable.dni),
    dniPresente,
    gt(pacientesTable.id, desdeId),
  );

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: pacientesTable.id,
        dni: pacientesTable.dni,
        nombre: pacientesTable.nombre,
        apellido: pacientesTable.apellido,
        fechaNacimiento: pacientesTable.fechaNacimiento,
        sexo: pacientesTable.sexo,
        email: pacientesTable.email,
        telefono: pacientesTable.telefono,
        direccion: pacientesTable.direccion,
        localidad: pacientesTable.localidad,
        cobertura: pacientesTable.cobertura,
        planCobertura: pacientesTable.planCobertura,
        nroAfiliado: pacientesTable.nroAfiliado,
      })
      .from(pacientesTable)
      .where(condiciones)
      .orderBy(asc(pacientesTable.id))
      .limit(limit),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(pacientesTable)
      .where(and(eq(pacientesTable.activo, true), isNotNull(pacientesTable.dni), dniPresente)),
  ]);

  const siguienteId = rows.length === limit ? rows[rows.length - 1].id : null;

  req.log.info(
    { desdeId, limit, devueltos: rows.length, siguienteId },
    "robot-padron: página de padrón entregada al Robot",
  );

  res.json({ pacientes: rows, siguienteId, total });
});

export default router;
