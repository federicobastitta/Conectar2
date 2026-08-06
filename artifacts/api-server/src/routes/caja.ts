import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import {
  db,
  cajaMovimientosTable,
  cajaCierresTable,
  pacientesTable,
  profesionalesTable,
} from "@workspace/db";
import {
  GetCajaResumenQueryParams,
  CreateCajaMovimientoBody,
  DeleteCajaMovimientoParams,
  CerrarCajaBody,
} from "@workspace/api-zod";
import { requireRol, getUserFromRequest as getUser } from "./auth";

const router: IRouter = Router();

const soloStaff = requireRol("admin", "recepcionista");

router.get("/caja/resumen", soloStaff, async (req, res): Promise<void> => {
  const params = GetCajaResumenQueryParams.safeParse(req.query);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const fecha = params.data.fecha;

  const rows = await db
    .select({
      mov: cajaMovimientosTable,
      pacienteNombre: sql<string | null>`concat_ws(' ', ${pacientesTable.nombre}, ${pacientesTable.apellido})`,
      profesionalNombre: sql<string | null>`concat_ws(' ', ${profesionalesTable.nombre}, ${profesionalesTable.apellido})`,
    })
    .from(cajaMovimientosTable)
    .leftJoin(pacientesTable, eq(cajaMovimientosTable.pacienteId, pacientesTable.id))
    .leftJoin(profesionalesTable, eq(cajaMovimientosTable.profesionalId, profesionalesTable.id))
    .where(eq(cajaMovimientosTable.fecha, fecha))
    .orderBy(cajaMovimientosTable.id);

  const movimientos = rows.map(({ mov, pacienteNombre, profesionalNombre }) => ({
    id: mov.id,
    fecha: mov.fecha,
    pacienteId: mov.pacienteId,
    pacienteNombre: pacienteNombre?.trim() || null,
    profesionalId: mov.profesionalId,
    profesionalNombre: profesionalNombre?.trim() || null,
    turnoId: mov.turnoId,
    tipo: mov.tipo,
    concepto: mov.concepto,
    monto: mov.monto,
    medioPago: mov.medioPago,
    createdAt: mov.createdAt,
  }));

  const porMap = new Map<
    string,
    { profesionalId: number | null; profesionalNombre: string; turnos: number; sena: number; insumos: number; subtotal: number }
  >();
  for (const m of movimientos) {
    const nombre = m.profesionalNombre ?? "Sin profesional";
    const key = `${m.profesionalId ?? 0}`;
    const acc =
      porMap.get(key) ??
      { profesionalId: m.profesionalId, profesionalNombre: nombre, turnos: 0, sena: 0, insumos: 0, subtotal: 0 };
    if (m.tipo === "turno") acc.turnos += m.monto;
    else if (m.tipo === "sena") acc.sena += m.monto;
    else acc.insumos += m.monto;
    acc.subtotal += m.monto;
    porMap.set(key, acc);
  }

  const [cierre] = await db
    .select()
    .from(cajaCierresTable)
    .where(eq(cajaCierresTable.fecha, fecha))
    .limit(1);

  res.json({
    fecha,
    movimientos,
    porProfesional: [...porMap.values()].sort((a, b) =>
      a.profesionalNombre.localeCompare(b.profesionalNombre),
    ),
    total: movimientos.reduce((s, m) => s + m.monto, 0),
    cerrada: !!cierre,
    cierre: cierre ?? undefined,
  });
});

router.post("/caja/movimientos", soloStaff, async (req, res): Promise<void> => {
  const parsed = CreateCajaMovimientoBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const user = await getUser(req);
  const resultado = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"caja_" + parsed.data.fecha}))`);
    const [cierre] = await tx
      .select()
      .from(cajaCierresTable)
      .where(eq(cajaCierresTable.fecha, parsed.data.fecha))
      .limit(1);
    if (cierre) return null;
    const [row] = await tx
      .insert(cajaMovimientosTable)
      .values({ ...parsed.data, creadoPor: user?.id ?? null })
      .returning();
    return row;
  });
  if (!resultado) {
    res.status(409).json({ error: "La caja de ese día ya está cerrada" });
    return;
  }
  res.status(201).json(resultado);
});

router.delete("/caja/movimientos/:id", soloStaff, async (req, res): Promise<void> => {
  const params = DeleteCajaMovimientoParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const cerrada = await db.transaction(async (tx) => {
    const [mov] = await tx
      .select()
      .from(cajaMovimientosTable)
      .where(eq(cajaMovimientosTable.id, params.data.id))
      .limit(1);
    if (!mov) return false;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"caja_" + mov.fecha}))`);
    const [cierre] = await tx
      .select()
      .from(cajaCierresTable)
      .where(eq(cajaCierresTable.fecha, mov.fecha))
      .limit(1);
    if (cierre) return true;
    await tx.delete(cajaMovimientosTable).where(eq(cajaMovimientosTable.id, params.data.id));
    return false;
  });
  if (cerrada) {
    res.status(409).json({ error: "La caja de ese día ya está cerrada" });
    return;
  }
  res.sendStatus(204);
});

router.post("/caja/cierres", soloStaff, async (req, res): Promise<void> => {
  const parsed = CerrarCajaBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const fecha = parsed.data.fecha;
  const user = await getUser(req);
  const cierreNuevo = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"caja_" + fecha}))`);
    const [existente] = await tx
      .select()
      .from(cajaCierresTable)
      .where(eq(cajaCierresTable.fecha, fecha))
      .limit(1);
    if (existente) return null;
    const [{ total }] = await tx
      .select({ total: sql<number>`coalesce(sum(${cajaMovimientosTable.monto}), 0)` })
      .from(cajaMovimientosTable)
      .where(eq(cajaMovimientosTable.fecha, fecha));
    const [cierre] = await tx
      .insert(cajaCierresTable)
      .values({ fecha, total, cerradaPor: user?.id ?? null })
      .returning();
    return cierre;
  });
  if (!cierreNuevo) {
    res.status(409).json({ error: "La caja de ese día ya está cerrada" });
    return;
  }
  res.status(201).json(cierreNuevo);
});

export default router;
