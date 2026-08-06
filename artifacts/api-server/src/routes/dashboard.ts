import { Router, type IRouter } from "express";
import { eq, and, gte, lte, type SQL } from "drizzle-orm";
import {
  db,
  turnosTable,
  pacientesTable,
  turnerasTable,
  profesionalesTable,
  especialidadesTable,
} from "@workspace/db";
import {
  GetDashboardResumenQueryParams,
  GetTurnosPorEstadoQueryParams,
  GetTurnosSemanaQueryParams,
  GetOcupacionTurnerasQueryParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/dashboard/resumen", async (req, res): Promise<void> => {
  const params = GetDashboardResumenQueryParams.safeParse(req.query);
  const todayRaw = params.success && params.data.fecha ? params.data.fecha : undefined;
  const today = todayRaw instanceof Date ? todayRaw.toISOString().split("T")[0] : (todayRaw ?? new Date().toISOString().split("T")[0]);
  const sedeId = params.success ? params.data.sedeId : undefined;

  let turnosDelDia = await db.select().from(turnosTable).where(eq(turnosTable.fecha, today));

  if (sedeId != null) {
    const turnerasIds = (
      await db.select({ id: turnerasTable.id }).from(turnerasTable).where(eq(turnerasTable.sedeId, sedeId))
    ).map((t) => t.id);
    turnosDelDia = turnosDelDia.filter((t) => turnerasIds.includes(t.turneraId));
  }

  const hoy = new Date(today);
  const manana = new Date(hoy);
  manana.setDate(manana.getDate() + 1);
  const pacientesNuevos = await db
    .select()
    .from(pacientesTable)
    .where(and(gte(pacientesTable.createdAt, hoy), lte(pacientesTable.createdAt, manana)));

  const turnerasActivas = await db.select().from(turnerasTable).where(eq(turnerasTable.activa, true));

  const byEstado = (estado: string) => turnosDelDia.filter((t) => t.estado === estado).length;

  res.json({
    fecha: today,
    turnosTotal: turnosDelDia.length,
    turnosPendientes: byEstado("pendiente"),
    turnosConfirmados: byEstado("confirmado"),
    turnosAtendidos: byEstado("atendido"),
    turnosCancelados: byEstado("cancelado"),
    turnosAusentes: byEstado("ausente"),
    pacientesNuevos: pacientesNuevos.length,
    turnerasActivas: turnerasActivas.length,
  });
});

router.get("/dashboard/turnos-por-estado", async (req, res): Promise<void> => {
  const params = GetTurnosPorEstadoQueryParams.safeParse(req.query);
  const todayRaw2 = params.success && params.data.fecha ? params.data.fecha : undefined;
  const today = todayRaw2 instanceof Date ? todayRaw2.toISOString().split("T")[0] : (todayRaw2 ?? new Date().toISOString().split("T")[0]);

  const turnos = await db.select().from(turnosTable).where(eq(turnosTable.fecha, today));
  const estados = ["pendiente", "confirmado", "en_sala", "atendido", "cancelado", "ausente"];
  const result = estados.map((estado) => ({
    estado,
    cantidad: turnos.filter((t) => t.estado === estado).length,
  }));
  res.json(result);
});

router.get("/dashboard/turnos-semana", async (req, res): Promise<void> => {
  const params = GetTurnosSemanaQueryParams.safeParse(req.query);
  const sedeId = params.success ? params.data.sedeId : undefined;

  const result = [];
  const base = new Date();
  let turnerasIds: number[] | null = null;
  if (sedeId != null) {
    turnerasIds = (
      await db.select({ id: turnerasTable.id }).from(turnerasTable).where(eq(turnerasTable.sedeId, sedeId))
    ).map((t) => t.id);
  }
  for (let i = 0; i < 7; i++) {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    const fechaStr = d.toISOString().split("T")[0];
    let turnos = await db.select().from(turnosTable).where(eq(turnosTable.fecha, fechaStr));
    if (turnerasIds !== null) {
      turnos = turnos.filter((t) => turnerasIds!.includes(t.turneraId));
    }
    result.push({ fecha: fechaStr, cantidad: turnos.length });
  }
  res.json(result);
});

router.get("/dashboard/ocupacion-turneras", async (req, res): Promise<void> => {
  const params = GetOcupacionTurnerasQueryParams.safeParse(req.query);
  const todayRaw3 = params.success && params.data.fecha ? params.data.fecha : undefined;
  const today = todayRaw3 instanceof Date ? todayRaw3.toISOString().split("T")[0] : (todayRaw3 ?? new Date().toISOString().split("T")[0]);
  const sedeId = params.success ? params.data.sedeId : undefined;

  const conditions: SQL[] = [eq(turnerasTable.activa, true)];
  if (sedeId != null) conditions.push(eq(turnerasTable.sedeId, sedeId));

  const turneras = await db.select().from(turnerasTable).where(and(...conditions));
  // today es YYYY-MM-DD → parsear como UTC y usar getUTCDay() (ver turnos.ts)
  const fechaDate = new Date(`${today}T00:00:00.000Z`);
  const diaSemana = fechaDate.getUTCDay();

  const result = [];
  for (const t of turneras) {
    const diasArray = t.diasAtencion?.split(",").map(Number) ?? [];
    if (!diasArray.includes(diaSemana)) continue;

    const [hIni] = t.horaInicio.split(":").map(Number);
    const mIni = parseInt(t.horaInicio.split(":")[1], 10);
    const [hFin] = t.horaFin.split(":").map(Number);
    const mFin = parseInt(t.horaFin.split(":")[1], 10);
    let current = hIni * 60 + mIni;
    const end = hFin * 60 + mFin;
    let totalSlots = 0;
    while (current + t.duracionMinutos <= end) {
      totalSlots++;
      current += t.duracionMinutos;
    }

    const turnosDia = await db
      .select()
      .from(turnosTable)
      .where(and(eq(turnosTable.turneraId, t.id), eq(turnosTable.fecha, today)));
    const ocupados = turnosDia.filter((tr) => !["cancelado", "ausente"].includes(tr.estado)).length;

    let profesionalNombre: string | null = null;
    if (t.profesionalId) {
      const [p] = await db
        .select()
        .from(profesionalesTable)
        .where(eq(profesionalesTable.id, t.profesionalId))
        .limit(1);
      if (p) profesionalNombre = `${p.nombre} ${p.apellido ?? ""}`.trim();
    }
    let espNombre: string | null = null;
    if (t.especialidadId) {
      const [e] = await db
        .select()
        .from(especialidadesTable)
        .where(eq(especialidadesTable.id, t.especialidadId))
        .limit(1);
      if (e) espNombre = e.nombre;
    }

    result.push({
      turneraId: t.id,
      nombre: t.nombre,
      profesional: profesionalNombre,
      especialidad: espNombre,
      totalSlots,
      ocupados,
      ocupacion: totalSlots > 0 ? ocupados / totalSlots : 0,
    });
  }
  res.json(result);
});

export default router;
