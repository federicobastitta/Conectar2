/**
 * Búsqueda rápida inteligente (para el buscador con el muñeco bailarín).
 *
 * Detecta qué escribió el usuario:
 *   - Solo dígitos (>= 6) → busca un paciente por DNI y devuelve sus próximos
 *     turnos y sus estudios más recientes.
 *   - Texto que matchea una especialidad → los 3 primeros turnos disponibles
 *     en días DISTINTOS entre las turneras activas de esa especialidad.
 *   - Texto que matchea un profesional → ídem con las turneras del profesional.
 *   - Nada de lo anterior → tipo "ninguno" (el frontend deriva la pregunta al
 *     asistente IA).
 */

import { Router, type IRouter } from "express";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import {
  db,
  turnerasTable,
  turnosTable,
  pacientesTable,
  especialidadesTable,
  profesionalesTable,
  sedesTable,
  pulsoEstudiosTable,
  estudiosExternosTable,
} from "@workspace/db";
import { BusquedaRapidaQueryParams } from "@workspace/api-zod";
import { requireRol } from "./auth";
import { calcularSlotsDisponibles } from "../lib/slots";
import { hoyArgentina } from "../lib/tiempo";

const router: IRouter = Router();

const DIAS_A_ESCANEAR = 30;

type SlotResultado = {
  turneraId: number;
  turneraNombre: string;
  fecha: string;
  horaInicio: string;
  profesional: string | null;
  especialidad: string | null;
  sede: string | null;
};

function sumarDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().split("T")[0];
}

// Busca los primeros `cantidad` turnos libres en días DISTINTOS entre las
// turneras dadas (el más temprano de cada día).
async function primerosSlotsEnDiasDistintos(
  turneras: (typeof turnerasTable.$inferSelect)[],
  cantidad: number,
): Promise<SlotResultado[]> {
  if (turneras.length === 0) return [];

  const [especialidades, profesionales, sedes] = await Promise.all([
    db.select().from(especialidadesTable),
    db.select().from(profesionalesTable),
    db.select().from(sedesTable),
  ]);
  const espPorId = new Map(especialidades.map((e) => [e.id, e.nombre]));
  const profPorId = new Map(
    profesionales.map((p) => [p.id, [p.apellido, p.nombre].filter(Boolean).join(", ")]),
  );
  const sedePorId = new Map(sedes.map((s) => [s.id, s.nombre]));

  const hoy = hoyArgentina();
  const resultados: SlotResultado[] = [];

  for (let i = 0; i < DIAS_A_ESCANEAR && resultados.length < cantidad; i++) {
    const fecha = sumarDias(hoy, i);
    let mejorDelDia: SlotResultado | null = null;

    for (const t of turneras) {
      const slots = await calcularSlotsDisponibles(t, fecha);
      const libre = slots.find((s) => s.disponible);
      if (!libre) continue;
      if (!mejorDelDia || libre.horaInicio < mejorDelDia.horaInicio) {
        mejorDelDia = {
          turneraId: t.id,
          turneraNombre: t.nombre,
          fecha,
          horaInicio: libre.horaInicio,
          profesional: t.profesionalId ? (profPorId.get(t.profesionalId) ?? null) : null,
          especialidad: t.especialidadId ? (espPorId.get(t.especialidadId) ?? null) : null,
          sede: t.sedeId ? (sedePorId.get(t.sedeId) ?? null) : null,
        };
      }
    }

    if (mejorDelDia) resultados.push(mejorDelDia);
  }

  return resultados;
}

router.get(
  "/busqueda-rapida",
  requireRol("admin", "recepcionista", "medico"),
  async (req, res): Promise<void> => {
    const parsed = BusquedaRapidaQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Parámetro q inválido" });
      return;
    }
    const consulta = parsed.data.q.trim();
    // Coincidencia por inicio de palabra ("eco" → Ecografía, NO Ginecología).
    const patronPalabra = `\\m${consulta.replace(/([\\^$.|?*+()[\]{}])/g, "\\$1")}`;

    // ── DNI ────────────────────────────────────────────────────────────────
    if (/^\d{6,}$/.test(consulta)) {
      const [paciente] = await db
        .select()
        .from(pacientesTable)
        .where(eq(pacientesTable.dni, consulta))
        .limit(1);

      if (!paciente) {
        res.json({ tipo: "ninguno", consulta, titulo: `No hay pacientes con DNI ${consulta}` });
        return;
      }

      const hoy = hoyArgentina();
      const [turnos, estudiosPulso, estudiosExternos] = await Promise.all([
        db
          .select({
            id: turnosTable.id,
            fecha: turnosTable.fecha,
            horaInicio: turnosTable.horaInicio,
            estado: turnosTable.estado,
            turneraNombre: turnerasTable.nombre,
          })
          .from(turnosTable)
          .leftJoin(turnerasTable, eq(turnosTable.turneraId, turnerasTable.id))
          .where(and(eq(turnosTable.pacienteId, paciente.id), gte(turnosTable.fecha, hoy)))
          .orderBy(turnosTable.fecha, turnosTable.horaInicio)
          .limit(3),
        db
          .select()
          .from(pulsoEstudiosTable)
          .where(eq(pulsoEstudiosTable.patientId, paciente.id))
          .orderBy(desc(pulsoEstudiosTable.fechaEstudio))
          .limit(3),
        db
          .select()
          .from(estudiosExternosTable)
          .where(eq(estudiosExternosTable.patientId, paciente.id))
          .orderBy(desc(estudiosExternosTable.createdAt))
          .limit(3),
      ]);

      const estudios = [
        ...estudiosPulso.map((e) => ({
          origen: "Pulso",
          descripcion: [e.modalidad, e.tipoEstudio].filter(Boolean).join(" · ") || "Estudio",
          estado: e.informeFirmado ? "informado" : (e.estado ?? "pendiente"),
          fecha: e.fechaEstudio ?? null,
        })),
        ...estudiosExternos.map((e) => ({
          origen: "Phir-it",
          descripcion: e.descripcion ?? "Estudio",
          estado: e.estado,
          fecha: e.informadoEn ? e.informadoEn.toISOString().split("T")[0] : null,
        })),
      ].slice(0, 3);

      res.json({
        tipo: "paciente",
        consulta,
        titulo: `${paciente.apellido}, ${paciente.nombre} (DNI ${paciente.dni})`,
        paciente: {
          id: paciente.id,
          nombre: paciente.nombre,
          apellido: paciente.apellido,
          dni: paciente.dni,
          turnos,
          estudios,
        },
      });
      return;
    }

    // ── Especialidad ───────────────────────────────────────────────────────
    const especialidades = await db
      .select()
      .from(especialidadesTable)
      .where(sql`unaccent(${especialidadesTable.nombre}) ~* unaccent(${patronPalabra})`);

    if (especialidades.length > 0) {
      const turneras = await db
        .select()
        .from(turnerasTable)
        .where(
          and(
            inArray(turnerasTable.especialidadId, especialidades.map((e) => e.id)),
            eq(turnerasTable.activa, true),
          ),
        );
      const slots = await primerosSlotsEnDiasDistintos(turneras, 3);
      res.json({
        tipo: slots.length > 0 ? "slots" : "ninguno",
        consulta,
        titulo:
          slots.length > 0
            ? `Próximos turnos de ${especialidades.map((e) => e.nombre).join(" / ")}`
            : `Sin turnos disponibles para ${especialidades.map((e) => e.nombre).join(" / ")} en los próximos ${DIAS_A_ESCANEAR} días`,
        slots,
      });
      return;
    }

    // ── Profesional ────────────────────────────────────────────────────────
    const profesionales = await db
      .select()
      .from(profesionalesTable)
      .where(
        sql`unaccent(coalesce(${profesionalesTable.apellido}, '') || ' ' || ${profesionalesTable.nombre}) ~* unaccent(${patronPalabra})`,
      );

    if (profesionales.length > 0) {
      const turneras = await db
        .select()
        .from(turnerasTable)
        .where(
          and(
            inArray(turnerasTable.profesionalId, profesionales.map((p) => p.id)),
            eq(turnerasTable.activa, true),
          ),
        );
      const slots = await primerosSlotsEnDiasDistintos(turneras, 3);
      const nombres = profesionales
        .map((p) => [p.apellido, p.nombre].filter(Boolean).join(", "))
        .join(" / ");
      res.json({
        tipo: slots.length > 0 ? "slots" : "ninguno",
        consulta,
        titulo:
          slots.length > 0
            ? `Próximos turnos de ${nombres}`
            : `Sin turnos disponibles para ${nombres} en los próximos ${DIAS_A_ESCANEAR} días`,
        slots,
      });
      return;
    }

    res.json({ tipo: "ninguno", consulta, titulo: null });
  },
);

export default router;
