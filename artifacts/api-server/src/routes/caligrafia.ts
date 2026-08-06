// Caligrafía manuscrita del médico: se elige UNA sola vez desde el perfil y
// queda fija (pedido del usuario: que no la puedan cambiar después).
// Mientras el médico no elija, sus documentos siguen usando id % 5 como antes.
import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import { db, profesionalesTable, usersTable } from "@workspace/db";
import { getUserIdFromToken } from "./auth";
import { CANTIDAD_CALIGRAFIAS, ttfDeCaligrafia, fuenteManuscritaParaProfesional } from "../pdf/fuentes_manuscritas";

const router: IRouter = Router();

async function profesionalDelToken(req: Parameters<Parameters<IRouter["get"]>[1]>[0]): Promise<number | null> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;
  const userId = await getUserIdFromToken(auth.slice(7));
  if (userId == null) return null;
  const [user] = await db.select({ profesionalId: usersTable.profesionalId })
    .from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  const id = user?.profesionalId != null ? Number(user.profesionalId) : NaN;
  return Number.isFinite(id) ? id : null;
}

// Estado de la caligrafía del médico logueado.
router.get("/perfil/caligrafia", async (req, res): Promise<void> => {
  const profesionalId = await profesionalDelToken(req);
  if (profesionalId == null) {
    res.status(401).json({ error: "Solo médicos con perfil profesional" });
    return;
  }
  const [prof] = await db.select({ caligrafia: profesionalesTable.caligrafia })
    .from(profesionalesTable).where(eq(profesionalesTable.id, profesionalId)).limit(1);
  const elegida = prof?.caligrafia ?? null;
  const efectiva = fuenteManuscritaParaProfesional(profesionalId, elegida);
  res.json({
    elegida,
    // Estilo que hoy usan sus documentos (elegida, o la asignada por defecto).
    // Sorteo por defecto congelado en las 5 bases originales.
    estiloActual: elegida ?? profesionalId % 5,
    cantidad: CANTIDAD_CALIGRAFIAS,
    tinta: efectiva.tinta,
  });
});

// Elegir caligrafía: solo se acepta si todavía no eligió (elección definitiva).
router.post("/perfil/caligrafia", async (req, res): Promise<void> => {
  const profesionalId = await profesionalDelToken(req);
  if (profesionalId == null) {
    res.status(401).json({ error: "Solo médicos con perfil profesional" });
    return;
  }
  const estilo = req.body?.estilo;
  if (!Number.isInteger(estilo) || estilo < 0 || estilo >= CANTIDAD_CALIGRAFIAS) {
    res.status(400).json({ error: "Estilo inválido" });
    return;
  }
  // Update atómico: solo escribe si caligrafia sigue NULL — dos pedidos en
  // paralelo no pueden pisarse, y una vez elegida nadie la cambia por acá.
  const actualizadas = await db.update(profesionalesTable)
    .set({ caligrafia: estilo })
    .where(sql`${profesionalesTable.id} = ${profesionalId} AND ${profesionalesTable.caligrafia} IS NULL`)
    .returning({ id: profesionalesTable.id });
  if (actualizadas.length === 0) {
    res.status(409).json({ error: "La caligrafía ya fue elegida y no se puede cambiar" });
    return;
  }
  req.log.info({ profesionalId, estilo }, "caligrafía manuscrita elegida (definitiva)");
  res.json({ elegida: estilo });
});

// Fuente TTF de un estilo, para la vista previa en vivo del frontend.
router.get("/perfil/caligrafia/fuente/:estilo", async (req, res): Promise<void> => {
  const profesionalId = await profesionalDelToken(req);
  if (profesionalId == null) {
    res.status(401).json({ error: "Solo médicos con perfil profesional" });
    return;
  }
  const ttf = ttfDeCaligrafia(Number(req.params.estilo));
  if (!ttf) {
    res.status(404).json({ error: "Estilo inexistente" });
    return;
  }
  res.setHeader("Content-Type", "font/ttf");
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.send(ttf);
});

export default router;
