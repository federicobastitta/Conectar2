import { Router, type IRouter } from "express";
import { eq, and, sql, count } from "drizzle-orm";
import { db, equivalenciasTable, nomencladorPracticasTable } from "@workspace/db";
import {
  ListEquivalenciasQueryParams,
  CreateEquivalenciaBody,
  UpdateEquivalenciaParams,
  UpdateEquivalenciaBody,
  DeleteEquivalenciaParams,
} from "@workspace/api-zod";
import { requireRol } from "./auth";

const router: IRouter = Router();

const soloStaff = requireRol("admin", "recepcionista", "medico");

function valoresInvalidos(datos: {
  pagoTipo?: string;
  pagoValor?: number;
  cobroObraSocial?: number | null;
}): string | null {
  if (datos.pagoValor != null && datos.pagoValor < 0) return "El valor de pago no puede ser negativo";
  if (datos.pagoTipo === "porcentaje" && datos.pagoValor != null && datos.pagoValor > 100)
    return "El porcentaje no puede superar 100";
  if (datos.cobroObraSocial != null && datos.cobroObraSocial < 0)
    return "El cobro no puede ser negativo";
  return null;
}

function calcular(row: {
  cobroObraSocial: number | null;
  pagoTipo: string;
  pagoValor: number;
  valorNomenclador: number | null;
}) {
  const cobroEfectivo = row.cobroObraSocial ?? row.valorNomenclador ?? null;
  let pagoCalculado: number | null = null;
  if (row.pagoTipo === "fijo") {
    pagoCalculado = row.pagoValor;
  } else if (cobroEfectivo != null) {
    pagoCalculado = Math.round(cobroEfectivo * row.pagoValor) / 100;
  }
  return { cobroEfectivo, pagoCalculado };
}

async function equivalenciaConCalculos(id: number) {
  const [row] = await db
    .select({
      id: equivalenciasTable.id,
      obraSocialId: equivalenciasTable.obraSocialId,
      codigo: equivalenciasTable.codigo,
      descripcion: equivalenciasTable.descripcion,
      cobroObraSocial: equivalenciasTable.cobroObraSocial,
      pagoTipo: equivalenciasTable.pagoTipo,
      pagoValor: equivalenciasTable.pagoValor,
      valorNomenclador: nomencladorPracticasTable.valorTotal,
    })
    .from(equivalenciasTable)
    .leftJoin(
      nomencladorPracticasTable,
      and(
        eq(nomencladorPracticasTable.obraSocialId, equivalenciasTable.obraSocialId),
        eq(nomencladorPracticasTable.codigo, equivalenciasTable.codigo),
      ),
    )
    .where(eq(equivalenciasTable.id, id));
  if (!row) return null;
  return { ...row, ...calcular(row) };
}

router.get("/equivalencias", soloStaff, async (req, res): Promise<void> => {
  const params = ListEquivalenciasQueryParams.safeParse(req.query);
  if (!params.success) {
    res.status(400).json({ error: "Parámetros inválidos" });
    return;
  }
  const { obraSocialId, buscar, limite } = params.data;
  const condiciones = [eq(equivalenciasTable.obraSocialId, obraSocialId)];
  if (buscar) {
    const patron = "%" + buscar + "%";
    condiciones.push(
      sql`(${equivalenciasTable.codigo} ILIKE ${patron} OR unaccent(coalesce(${equivalenciasTable.descripcion}, '')) ILIKE unaccent(${patron}))`,
    );
  }
  const where = and(...condiciones);
  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: equivalenciasTable.id,
        obraSocialId: equivalenciasTable.obraSocialId,
        codigo: equivalenciasTable.codigo,
        descripcion: equivalenciasTable.descripcion,
        cobroObraSocial: equivalenciasTable.cobroObraSocial,
        pagoTipo: equivalenciasTable.pagoTipo,
        pagoValor: equivalenciasTable.pagoValor,
        valorNomenclador: nomencladorPracticasTable.valorTotal,
      })
      .from(equivalenciasTable)
      .leftJoin(
        nomencladorPracticasTable,
        and(
          eq(nomencladorPracticasTable.obraSocialId, equivalenciasTable.obraSocialId),
          eq(nomencladorPracticasTable.codigo, equivalenciasTable.codigo),
        ),
      )
      .where(where)
      .orderBy(equivalenciasTable.codigo)
      .limit(Math.min(limite ?? 100, 500)),
    db.select({ total: count() }).from(equivalenciasTable).where(where),
  ]);
  res.json({
    total,
    equivalencias: rows.map((r) => ({ ...r, ...calcular(r) })),
  });
});

router.post("/equivalencias", soloStaff, async (req, res): Promise<void> => {
  const body = CreateEquivalenciaBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Datos inválidos" });
    return;
  }
  const { obraSocialId, codigo, descripcion, cobroObraSocial, pagoTipo, pagoValor } = body.data;
  const errorValores = valoresInvalidos(body.data);
  if (errorValores) {
    res.status(400).json({ error: errorValores });
    return;
  }
  const [fila] = await db
    .insert(equivalenciasTable)
    .values({
      obraSocialId,
      codigo: codigo.trim(),
      descripcion: descripcion ?? null,
      cobroObraSocial: cobroObraSocial ?? null,
      pagoTipo,
      pagoValor,
    })
    .onConflictDoUpdate({
      target: [equivalenciasTable.obraSocialId, equivalenciasTable.codigo],
      set: {
        descripcion: descripcion ?? null,
        cobroObraSocial: cobroObraSocial ?? null,
        pagoTipo,
        pagoValor,
        updatedAt: sql`now()`,
      },
    })
    .returning({ id: equivalenciasTable.id });
  const completa = await equivalenciaConCalculos(fila.id);
  req.log.info({ equivalenciaId: fila.id, obraSocialId, codigo }, "equivalencia guardada");
  res.status(201).json(completa);
});

router.patch("/equivalencias/:id", soloStaff, async (req, res): Promise<void> => {
  const params = UpdateEquivalenciaParams.safeParse(req.params);
  const body = UpdateEquivalenciaBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Datos inválidos" });
    return;
  }
  const errorValores = valoresInvalidos(body.data);
  if (errorValores) {
    res.status(400).json({ error: errorValores });
    return;
  }
  const cambios: Record<string, unknown> = {};
  if ("descripcion" in req.body) cambios.descripcion = body.data.descripcion ?? null;
  if ("cobroObraSocial" in req.body) cambios.cobroObraSocial = body.data.cobroObraSocial ?? null;
  if (body.data.pagoTipo !== undefined) cambios.pagoTipo = body.data.pagoTipo;
  if (body.data.pagoValor !== undefined) cambios.pagoValor = body.data.pagoValor;
  if (Object.keys(cambios).length === 0) {
    res.status(400).json({ error: "Sin cambios" });
    return;
  }
  cambios.updatedAt = sql`now()`;
  const [fila] = await db
    .update(equivalenciasTable)
    .set(cambios)
    .where(eq(equivalenciasTable.id, params.data.id))
    .returning({ id: equivalenciasTable.id });
  if (!fila) {
    res.status(404).json({ error: "Equivalencia no encontrada" });
    return;
  }
  const completa = await equivalenciaConCalculos(fila.id);
  res.json(completa);
});

router.delete("/equivalencias/:id", soloStaff, async (req, res): Promise<void> => {
  const params = DeleteEquivalenciaParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Parámetros inválidos" });
    return;
  }
  const [fila] = await db
    .delete(equivalenciasTable)
    .where(eq(equivalenciasTable.id, params.data.id))
    .returning({ id: equivalenciasTable.id });
  if (!fila) {
    res.status(404).json({ error: "Equivalencia no encontrada" });
    return;
  }
  res.status(204).end();
});

export default router;
