import { Router, type IRouter } from "express";
import multer from "multer";
import { eq, and, sql, count, type SQL } from "drizzle-orm";
import { db, obrasSocialesTable, nomencladorPracticasTable } from "@workspace/db";
import {
  CreateObraSocialBody,
  UpdateObraSocialBody,
  UpdateObraSocialParams,
  DeleteObraSocialParams,
  ListObrasSocialesQueryParams,
  ListNomencladorPracticasQueryParams,
  DeleteNomencladorObraSocialParams,
} from "@workspace/api-zod";
import { requireRol } from "./auth";
import { parsearNomenclador } from "../lib/nomenclador_parser";

const router: IRouter = Router();

const soloStaff = requireRol("admin", "recepcionista", "medico");
const uploadNomenclador = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 },
});

router.get("/obras-sociales", async (req, res): Promise<void> => {
  const params = ListObrasSocialesQueryParams.safeParse(req.query);
  const conditions: SQL[] = [];
  if (params.success) {
    if (params.data.activa != null)
      conditions.push(eq(obrasSocialesTable.activa, params.data.activa));
    if (params.data.q)
      conditions.push(
        sql`unaccent(${obrasSocialesTable.nombre}) ILIKE unaccent(${"%" + params.data.q + "%"})`,
      );
  }
  const rows = await db
    .select()
    .from(obrasSocialesTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(obrasSocialesTable.nombre);
  res.json(rows);
});

router.post("/obras-sociales", soloStaff, async (req, res): Promise<void> => {
  const parsed = CreateObraSocialBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [obra] = await db.insert(obrasSocialesTable).values(parsed.data).returning();
  res.status(201).json(obra);
});

router.patch("/obras-sociales/:id", soloStaff, async (req, res): Promise<void> => {
  const params = UpdateObraSocialParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateObraSocialBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [obra] = await db
    .update(obrasSocialesTable)
    .set(parsed.data)
    .where(eq(obrasSocialesTable.id, params.data.id))
    .returning();
  if (!obra) {
    res.status(404).json({ error: "Obra social no encontrada" });
    return;
  }
  res.json(obra);
});

router.delete("/obras-sociales/:id", soloStaff, async (req, res): Promise<void> => {
  const params = DeleteObraSocialParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await db.delete(obrasSocialesTable).where(eq(obrasSocialesTable.id, params.data.id));
  res.sendStatus(204);
});

// --- Nomenclador valorizado por obra social ---

router.get("/nomenclador", soloStaff, async (req, res): Promise<void> => {
  const params = ListNomencladorPracticasQueryParams.safeParse(req.query);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const { obraSocialId, buscar, limite } = params.data;
  const conditions: SQL[] = [];
  if (obraSocialId != null) conditions.push(eq(nomencladorPracticasTable.obraSocialId, obraSocialId));
  if (buscar) {
    conditions.push(
      sql`(unaccent(${nomencladorPracticasTable.descripcion}) ILIKE unaccent(${"%" + buscar + "%"}) OR ${nomencladorPracticasTable.codigo} ILIKE ${"%" + buscar + "%"})`,
    );
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  if (obraSocialId != null) {
    const [{ total }] = await db
      .select({ total: count() })
      .from(nomencladorPracticasTable)
      .where(where);
    const practicas = await db
      .select()
      .from(nomencladorPracticasTable)
      .where(where)
      .orderBy(nomencladorPracticasTable.codigo)
      .limit(Math.min(limite ?? 50, 500));
    res.json({ total, practicas });
    return;
  }
  // Sin obra social: búsqueda global sin repetir códigos (una fila por código,
  // se toma cualquiera de las obras sociales que lo tengan). Se usa para
  // asociar prácticas a una agenda, donde el código es lo que importa.
  const [{ total }] = await db
    .select({ total: sql<number>`count(DISTINCT ${nomencladorPracticasTable.codigo})`.mapWith(Number) })
    .from(nomencladorPracticasTable)
    .where(where);
  const practicas = await db
    .selectDistinctOn([nomencladorPracticasTable.codigo])
    .from(nomencladorPracticasTable)
    .where(where)
    .orderBy(nomencladorPracticasTable.codigo, nomencladorPracticasTable.obraSocialId)
    .limit(Math.min(limite ?? 50, 500));
  res.json({ total, practicas });
});

// Subida de archivo Excel (xls/xlsx) con el nomenclador valorizado.
// Reemplaza el nomenclador completo de la obra social.
router.post(
  "/obras-sociales/:id/nomenclador/importar",
  soloStaff,
  uploadNomenclador.single("archivo"),
  async (req, res): Promise<void> => {
    const obraSocialId = Number(req.params.id);
    if (!Number.isInteger(obraSocialId) || obraSocialId <= 0) {
      res.status(400).json({ error: "id inválido" });
      return;
    }
    const [obra] = await db
      .select()
      .from(obrasSocialesTable)
      .where(eq(obrasSocialesTable.id, obraSocialId));
    if (!obra) {
      res.status(404).json({ error: "Obra social no encontrada" });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: "Falta el archivo (campo 'archivo')" });
      return;
    }

    let practicas;
    try {
      practicas = parsearNomenclador(req.file.buffer, req.file.originalname);
    } catch (err) {
      req.log.warn({ err }, "nomenclador: error al parsear archivo");
      res.status(422).json({ error: "No se pudo leer el archivo. ¿Es un Excel válido (xls/xlsx)?" });
      return;
    }
    if (practicas.length === 0) {
      res.status(422).json({
        error:
          "No se encontraron prácticas con código y valor en el archivo. Verificá que tenga columnas de código, descripción y valores.",
      });
      return;
    }

    await db.transaction(async (tx) => {
      await tx
        .delete(nomencladorPracticasTable)
        .where(eq(nomencladorPracticasTable.obraSocialId, obraSocialId));
      // Insertar en lotes para no exceder límites de parámetros
      const lote = 500;
      for (let i = 0; i < practicas.length; i += lote) {
        await tx.insert(nomencladorPracticasTable).values(
          practicas.slice(i, i + lote).map((p) => ({ ...p, obraSocialId })),
        );
      }
    });

    req.log.info(
      { obraSocialId, archivo: req.file.originalname, practicas: practicas.length },
      "nomenclador: importado",
    );
    res.status(201).json({ importadas: practicas.length, obraSocialId });
  },
);

router.delete("/obras-sociales/:id/nomenclador", soloStaff, async (req, res): Promise<void> => {
  const params = DeleteNomencladorObraSocialParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await db
    .delete(nomencladorPracticasTable)
    .where(eq(nomencladorPracticasTable.obraSocialId, params.data.id));
  res.sendStatus(204);
});

export default router;
