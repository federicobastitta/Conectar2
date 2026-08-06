import { Router, type IRouter, type Request, type Response } from "express";
import { eq, sql } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { GetEstadisticasResumenQueryParams } from "@workspace/api-zod";
import { getUserIdFromToken } from "./auth";
import { hoyArgentina } from "../lib/tiempo";

const router: IRouter = Router();

async function requireAdmin(req: Request, res: Response): Promise<boolean> {
  const token = req.headers.authorization?.replace("Bearer ", "");
  const userId = token ? await getUserIdFromToken(token) : null;
  if (!userId) {
    res.status(401).json({ error: "No autenticado" });
    return false;
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user || user.rol !== "admin") {
    res.status(403).json({ error: "Solo admin puede ver estadísticas" });
    return false;
  }
  return true;
}

type CantidadItem = { clave: string; cantidad: number };

function aItems(rows: { clave: string | null; cantidad: string | number }[]): CantidadItem[] {
  return rows.map((r) => ({ clave: r.clave ?? "Sin dato", cantidad: Number(r.cantidad) }));
}

// GET /estadisticas/resumen — tablero gerencial (solo admin)
router.get("/estadisticas/resumen", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const query = GetEstadisticasResumenQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const hoy = hoyArgentina();
  const hace12Meses = new Date();
  hace12Meses.setMonth(hace12Meses.getMonth() - 12);
  const desde = query.data.desde ?? hace12Meses.toISOString().split("T")[0];
  const hasta = query.data.hasta ?? hoy;

  const [
    consultasPorMedico,
    consultasPorEspecialidad,
    consultasPorSede,
    estudiosPorMedico,
    estudiosPorServicio,
    estudiosPorSede,
    estudiosPorCobertura,
    estadosOperativos,
    conversionPorServicio,
    indicadoresPorMedico,
    evolucionMensual,
    rankingEstudios,
    capacidadInstalada,
    estudiosExternosPorEstado,
  ] = await Promise.all([
    // Producción médica: consultas (encounters) por médico
    db.execute(sql`
      SELECT COALESCE(p.apellido || ', ' || p.nombre, 'Sin profesional') AS clave, COUNT(*)::int AS cantidad
      FROM encounters e
      LEFT JOIN profesionales p ON p.id = e.professional_id
      WHERE e.created_at::date BETWEEN ${desde} AND ${hasta}
      GROUP BY 1 ORDER BY cantidad DESC LIMIT 20`),
    db.execute(sql`
      SELECT COALESCE(esp.nombre, e.specialty, 'Sin especialidad') AS clave, COUNT(*)::int AS cantidad
      FROM encounters e
      LEFT JOIN profesionales p ON p.id = e.professional_id
      LEFT JOIN especialidades esp ON esp.id = p.especialidad_id
      WHERE e.created_at::date BETWEEN ${desde} AND ${hasta}
      GROUP BY 1 ORDER BY cantidad DESC LIMIT 20`),
    // Consultas por sede (vía turnos atendidos en el período)
    db.execute(sql`
      SELECT COALESCE(s.nombre, 'Sin sede') AS clave, COUNT(*)::int AS cantidad
      FROM turnos t
      LEFT JOIN turneras tn ON tn.id = t.turnera_id
      LEFT JOIN sedes s ON s.id = tn.sede_id
      WHERE t.estado IN ('visto','en_atencion') AND t.fecha BETWEEN ${desde} AND ${hasta}
      GROUP BY 1 ORDER BY cantidad DESC`),
    // Producción de prácticas: solicitudes por médico
    db.execute(sql`
      SELECT COALESCE(p.apellido || ', ' || p.nombre, 'Sin profesional') AS clave, COUNT(*)::int AS cantidad
      FROM solicitudes so
      LEFT JOIN profesionales p ON p.id = so.professional_id
      WHERE so.created_at::date BETWEEN ${desde} AND ${hasta}
      GROUP BY 1 ORDER BY cantidad DESC LIMIT 20`),
    db.execute(sql`
      SELECT COALESCE(sv.nombre, 'Sin servicio') AS clave, COUNT(*)::int AS cantidad
      FROM solicitudes so
      LEFT JOIN servicios sv ON sv.id = so.servicio_id
      WHERE so.created_at::date BETWEEN ${desde} AND ${hasta}
      GROUP BY 1 ORDER BY cantidad DESC`),
    db.execute(sql`
      SELECT COALESCE(s.nombre, 'Sin sede') AS clave, COUNT(*)::int AS cantidad
      FROM solicitudes so
      LEFT JOIN turnos t ON t.id = so.turno_id
      LEFT JOIN turneras tn ON tn.id = t.turnera_id
      LEFT JOIN sedes s ON s.id = tn.sede_id
      WHERE so.created_at::date BETWEEN ${desde} AND ${hasta}
      GROUP BY 1 ORDER BY cantidad DESC`),
    db.execute(sql`
      SELECT COALESCE(NULLIF(TRIM(so.cobertura), ''), 'Sin cobertura') AS clave, COUNT(*)::int AS cantidad
      FROM solicitudes so
      WHERE so.created_at::date BETWEEN ${desde} AND ${hasta}
      GROUP BY 1 ORDER BY cantidad DESC LIMIT 15`),
    // Estados operativos
    db.execute(sql`
      SELECT so.estado AS clave, COUNT(*)::int AS cantidad
      FROM solicitudes so
      WHERE so.created_at::date BETWEEN ${desde} AND ${hasta}
      GROUP BY 1 ORDER BY cantidad DESC`),
    // Conversión consulta → servicio
    db.execute(sql`
      WITH consultas AS (
        SELECT COUNT(*)::int AS total FROM encounters e
        WHERE e.created_at::date BETWEEN ${desde} AND ${hasta}
      )
      SELECT COALESCE(sv.nombre,'Sin servicio') AS servicio_nombre,
             COUNT(*)::int AS solicitudes,
             (SELECT total FROM consultas) AS consultas,
             CASE WHEN (SELECT total FROM consultas) > 0
                  THEN ROUND(COUNT(*)::numeric * 100 / (SELECT total FROM consultas), 1)
                  ELSE 0 END AS conversion_pct
      FROM solicitudes so
      LEFT JOIN servicios sv ON sv.id = so.servicio_id
      WHERE so.created_at::date BETWEEN ${desde} AND ${hasta}
      GROUP BY 1 ORDER BY solicitudes DESC`),
    // Indicadores por médico
    db.execute(sql`
      WITH cons AS (
        SELECT e.professional_id, COUNT(*)::int AS consultas
        FROM encounters e
        WHERE e.created_at::date BETWEEN ${desde} AND ${hasta}
        GROUP BY 1
      ), sols AS (
        SELECT so.professional_id,
               COUNT(*)::int AS estudios,
               COUNT(*) FILTER (WHERE so.tipo = 'derivacion')::int AS derivaciones,
               COUNT(*) FILTER (WHERE so.turno_id IS NOT NULL)::int AS internas
        FROM solicitudes so
        WHERE so.created_at::date BETWEEN ${desde} AND ${hasta}
        GROUP BY 1
      )
      SELECT p.id AS profesional_id,
             p.apellido || ', ' || p.nombre AS profesional_nombre,
             esp.nombre AS especialidad_nombre,
             COALESCE(c.consultas, 0) AS consultas,
             COALESCE(s.estudios, 0) AS estudios_solicitados,
             COALESCE(s.derivaciones, 0) AS derivaciones,
             CASE WHEN COALESCE(c.consultas,0) > 0
                  THEN ROUND(COALESCE(s.estudios,0)::numeric / c.consultas, 2) ELSE 0 END AS promedio,
             CASE WHEN COALESCE(c.consultas,0) > 0
                  THEN ROUND(LEAST(COALESCE(s.estudios,0), c.consultas)::numeric * 100 / c.consultas, 1) ELSE 0 END AS conversion_pct,
             CASE WHEN COALESCE(s.estudios,0) > 0
                  THEN ROUND(COALESCE(s.internas,0)::numeric * 100 / s.estudios, 1) ELSE 0 END AS resolucion_interna_pct
      FROM profesionales p
      LEFT JOIN especialidades esp ON esp.id = p.especialidad_id
      LEFT JOIN cons c ON c.professional_id = p.id
      LEFT JOIN sols s ON s.professional_id = p.id
      WHERE COALESCE(c.consultas,0) > 0 OR COALESCE(s.estudios,0) > 0
      ORDER BY COALESCE(c.consultas,0) + COALESCE(s.estudios,0) DESC
      LIMIT 30`),
    // Evolución mensual (consultas y solicitudes)
    db.execute(sql`
      WITH meses AS (
        SELECT to_char(d, 'YYYY-MM') AS mes
        FROM generate_series(${desde}::date, ${hasta}::date, interval '1 month') d
      ), c AS (
        SELECT to_char(e.created_at, 'YYYY-MM') AS mes, COUNT(*)::int AS consultas
        FROM encounters e WHERE e.created_at::date BETWEEN ${desde} AND ${hasta} GROUP BY 1
      ), s AS (
        SELECT to_char(so.created_at, 'YYYY-MM') AS mes, COUNT(*)::int AS solicitudes
        FROM solicitudes so WHERE so.created_at::date BETWEEN ${desde} AND ${hasta} GROUP BY 1
      )
      SELECT m.mes, COALESCE(c.consultas,0) AS consultas, COALESCE(s.solicitudes,0) AS solicitudes
      FROM meses m LEFT JOIN c ON c.mes = m.mes LEFT JOIN s ON s.mes = m.mes
      ORDER BY m.mes`),
    // Ranking estudios más solicitados (incluye órdenes de estudio históricas)
    db.execute(sql`
      SELECT clave, SUM(cantidad)::int AS cantidad FROM (
        SELECT COALESCE(sv.nombre,'Sin servicio') AS clave, COUNT(*)::int AS cantidad
        FROM solicitudes so LEFT JOIN servicios sv ON sv.id = so.servicio_id
        WHERE so.created_at::date BETWEEN ${desde} AND ${hasta} GROUP BY 1
        UNION ALL
        SELECT o.study_name AS clave, COUNT(*)::int AS cantidad
        FROM study_orders o
        WHERE o.created_at::date BETWEEN ${desde} AND ${hasta} GROUP BY 1
      ) u GROUP BY clave ORDER BY cantidad DESC LIMIT 15`),
    // Utilización de capacidad instalada (semana actual)
    db.execute(sql`
      SELECT tn.id AS turnera_id, tn.nombre AS turnera_nombre, s.nombre AS sede_nombre,
        (SELECT COUNT(*)::int FROM generate_series(date_trunc('week', now())::date, date_trunc('week', now())::date + 6, interval '1 day') d
          WHERE EXTRACT(dow FROM d)::int = ANY(string_to_array(tn.dias_atencion, ',')::int[]))
        * GREATEST(1, ((split_part(tn.hora_fin,':',1)::int * 60 + split_part(tn.hora_fin,':',2)::int)
           - (split_part(tn.hora_inicio,':',1)::int * 60 + split_part(tn.hora_inicio,':',2)::int)) / NULLIF(tn.duracion_minutos,0))
        AS capacidad_semanal,
        (SELECT COUNT(*)::int FROM turnos t
          WHERE t.turnera_id = tn.id
            AND t.fecha BETWEEN date_trunc('week', now())::date AND (date_trunc('week', now()) + interval '6 days')::date
            AND t.estado NOT IN ('cancelado','ausente')) AS ocupados_semana
      FROM turneras tn
      LEFT JOIN sedes s ON s.id = tn.sede_id
      WHERE tn.activa = true
      ORDER BY tn.nombre`),
    // Estudios externos (Phir-it) por estado en el período
    db.execute(sql`
      SELECT ee.estado AS clave, COUNT(*)::int AS cantidad
      FROM estudios_externos ee
      WHERE COALESCE(ee.estado_cambiado_en, ee.created_at)::date BETWEEN ${desde} AND ${hasta}
      GROUP BY 1 ORDER BY cantidad DESC`),
  ]);

  const capacidad = (capacidadInstalada.rows as any[]).map((r) => {
    const cap = Number(r.capacidad_semanal) || 0;
    const ocu = Number(r.ocupados_semana) || 0;
    return {
      turneraId: Number(r.turnera_id),
      turneraNombre: String(r.turnera_nombre),
      sedeNombre: r.sede_nombre ?? null,
      capacidadSemanal: cap,
      ocupadosSemana: ocu,
      utilizacionPct: cap > 0 ? Math.round((ocu * 1000) / cap) / 10 : 0,
    };
  });

  const indicadores = (indicadoresPorMedico.rows as any[]).map((r) => ({
    profesionalId: Number(r.profesional_id),
    profesionalNombre: String(r.profesional_nombre),
    especialidadNombre: r.especialidad_nombre ?? null,
    consultas: Number(r.consultas),
    estudiosSolicitados: Number(r.estudios_solicitados),
    derivaciones: Number(r.derivaciones),
    promedioEstudiosPorConsulta: Number(r.promedio),
    conversionPct: Number(r.conversion_pct),
    resolucionInternaPct: Number(r.resolucion_interna_pct),
  }));

  const conversion = (conversionPorServicio.rows as any[]).map((r) => ({
    servicioNombre: String(r.servicio_nombre),
    solicitudes: Number(r.solicitudes),
    consultas: Number(r.consultas),
    conversionPct: Number(r.conversion_pct),
  }));

  res.json({
    desde,
    hasta,
    consultasPorMedico: aItems(consultasPorMedico.rows as any[]),
    consultasPorEspecialidad: aItems(consultasPorEspecialidad.rows as any[]),
    consultasPorSede: aItems(consultasPorSede.rows as any[]),
    estudiosPorMedico: aItems(estudiosPorMedico.rows as any[]),
    estudiosPorServicio: aItems(estudiosPorServicio.rows as any[]),
    estudiosPorSede: aItems(estudiosPorSede.rows as any[]),
    estudiosPorCobertura: aItems(estudiosPorCobertura.rows as any[]),
    estadosOperativos: aItems(estadosOperativos.rows as any[]),
    conversionPorServicio: conversion,
    indicadoresPorMedico: indicadores,
    evolucionMensual: (evolucionMensual.rows as any[]).map((r) => ({
      mes: String(r.mes),
      consultas: Number(r.consultas),
      solicitudes: Number(r.solicitudes),
    })),
    rankingEstudios: aItems(rankingEstudios.rows as any[]),
    rankingMedicos: aItems(consultasPorMedico.rows as any[]),
    rankingEspecialidades: aItems(consultasPorEspecialidad.rows as any[]),
    capacidadInstalada: capacidad,
    estudiosExternosPorEstado: aItems(estudiosExternosPorEstado.rows as any[]),
  });
});

// ── Reportes estadísticos (estilo gestionsalud) ──────────────────────────

type ReporteDef = {
  clave: string;
  titulo: string;
  columnas: string[];
  ejecutar: (desde: string, hasta: string) => Promise<string[][]>;
};

function filas(rows: unknown[], cols: string[]): string[][] {
  return (rows as Record<string, unknown>[]).map((r) =>
    cols.map((c) => (r[c] === null || r[c] === undefined ? "—" : String(r[c]))),
  );
}

const REPORTES: ReporteDef[] = [
  {
    clave: "pacientes_por_obra_social",
    titulo: "Cantidad de pacientes por Obra Social atendidos entre fechas",
    columnas: ["Obra Social", "Pacientes", "Turnos"],
    ejecutar: async (desde, hasta) => {
      const r = await db.execute(sql`
        SELECT COALESCE(NULLIF(TRIM(t.cobertura), ''), 'Sin cobertura') AS c1,
               COUNT(DISTINCT t.paciente_id) AS c2, COUNT(*) AS c3
        FROM turnos t
        WHERE t.fecha BETWEEN ${desde} AND ${hasta} AND t.estado = 'atendido'
        GROUP BY 1 ORDER BY 2 DESC`);
      return filas(r.rows as unknown[], ["c1", "c2", "c3"]);
    },
  },
  {
    clave: "pacientes_por_os_especialidad",
    titulo: "Cantidad de pacientes por Obra Social atendidos entre fechas por Especialidad",
    columnas: ["Obra Social", "Especialidad", "Pacientes", "Turnos"],
    ejecutar: async (desde, hasta) => {
      const r = await db.execute(sql`
        SELECT COALESCE(NULLIF(TRIM(t.cobertura), ''), 'Sin cobertura') AS c1,
               COALESCE(e.nombre, 'Sin especialidad') AS c2,
               COUNT(DISTINCT t.paciente_id) AS c3, COUNT(*) AS c4
        FROM turnos t
        LEFT JOIN turneras tu ON tu.id = t.turnera_id
        LEFT JOIN especialidades e ON e.id = tu.especialidad_id
        WHERE t.fecha BETWEEN ${desde} AND ${hasta} AND t.estado = 'atendido'
        GROUP BY 1, 2 ORDER BY 3 DESC`);
      return filas(r.rows as unknown[], ["c1", "c2", "c3", "c4"]);
    },
  },
  {
    clave: "pacientes_por_localidad",
    titulo: "Cantidad de Pacientes por Localidad / Provincia",
    columnas: ["Localidad", "Provincia", "Pacientes"],
    ejecutar: async (desde, hasta) => {
      const r = await db.execute(sql`
        SELECT COALESCE(NULLIF(TRIM(p.localidad), ''), 'Sin localidad') AS c1,
               COALESCE(NULLIF(TRIM(p.provincia), ''), 'Sin provincia') AS c2,
               COUNT(DISTINCT p.id) AS c3
        FROM pacientes p
        JOIN turnos t ON t.paciente_id = p.id AND t.fecha BETWEEN ${desde} AND ${hasta}
        GROUP BY 1, 2 ORDER BY 3 DESC`);
      return filas(r.rows as unknown[], ["c1", "c2", "c3"]);
    },
  },
  {
    clave: "turnos_por_especialidad",
    titulo: "Cantidad de Turnos por Especialidad entre fecha de turno",
    columnas: ["Especialidad", "Turnos", "Atendidos", "Ausentes"],
    ejecutar: async (desde, hasta) => {
      const r = await db.execute(sql`
        SELECT COALESCE(e.nombre, 'Sin especialidad') AS c1,
               COUNT(*) AS c2,
               COUNT(*) FILTER (WHERE t.estado = 'atendido') AS c3,
               COUNT(*) FILTER (WHERE t.estado = 'ausente') AS c4
        FROM turnos t
        LEFT JOIN turneras tu ON tu.id = t.turnera_id
        LEFT JOIN especialidades e ON e.id = tu.especialidad_id
        WHERE t.fecha BETWEEN ${desde} AND ${hasta}
        GROUP BY 1 ORDER BY 2 DESC`);
      return filas(r.rows as unknown[], ["c1", "c2", "c3", "c4"]);
    },
  },
  {
    clave: "turnos_por_profesional",
    titulo: "Cantidad de Turnos por Profesional entre fechas",
    columnas: ["Profesional", "Turnos", "Atendidos", "Ausentes"],
    ejecutar: async (desde, hasta) => {
      const r = await db.execute(sql`
        SELECT COALESCE(pr.apellido || ', ' || pr.nombre, 'Sin profesional') AS c1,
               COUNT(*) AS c2,
               COUNT(*) FILTER (WHERE t.estado = 'atendido') AS c3,
               COUNT(*) FILTER (WHERE t.estado = 'ausente') AS c4
        FROM turnos t
        LEFT JOIN profesionales pr ON pr.id = t.profesional_id
        WHERE t.fecha BETWEEN ${desde} AND ${hasta}
        GROUP BY 1 ORDER BY 2 DESC`);
      return filas(r.rows as unknown[], ["c1", "c2", "c3", "c4"]);
    },
  },
  {
    clave: "turnos_por_motivo_consulta",
    titulo: "Cantidad de Turnos por Motivos de Consultas entre fechas",
    columnas: ["Motivo de consulta", "Turnos"],
    ejecutar: async (desde, hasta) => {
      const r = await db.execute(sql`
        SELECT COALESCE(NULLIF(TRIM(t.motivo_consulta), ''), 'Sin motivo') AS c1, COUNT(*) AS c2
        FROM turnos t
        WHERE t.fecha BETWEEN ${desde} AND ${hasta}
        GROUP BY 1 ORDER BY 2 DESC`);
      return filas(r.rows as unknown[], ["c1", "c2"]);
    },
  },
  {
    clave: "turnos_por_motivo_y_os",
    titulo: "Cantidad de Turnos por Motivos de Consultas y Obra Social entre fechas",
    columnas: ["Motivo de consulta", "Obra Social", "Turnos"],
    ejecutar: async (desde, hasta) => {
      const r = await db.execute(sql`
        SELECT COALESCE(NULLIF(TRIM(t.motivo_consulta), ''), 'Sin motivo') AS c1,
               COALESCE(NULLIF(TRIM(t.cobertura), ''), 'Sin cobertura') AS c2, COUNT(*) AS c3
        FROM turnos t
        WHERE t.fecha BETWEEN ${desde} AND ${hasta}
        GROUP BY 1, 2 ORDER BY 3 DESC`);
      return filas(r.rows as unknown[], ["c1", "c2", "c3"]);
    },
  },
  {
    clave: "listado_atendidos_os_medico",
    titulo: "Listado de Pacientes Atendidos por Obra Social y por Médico",
    columnas: ["Fecha", "Paciente", "DNI", "Obra Social", "Profesional"],
    ejecutar: async (desde, hasta) => {
      const r = await db.execute(sql`
        SELECT t.fecha AS c1,
               p.apellido || ', ' || p.nombre AS c2,
               p.dni AS c3,
               COALESCE(NULLIF(TRIM(t.cobertura), ''), 'Sin cobertura') AS c4,
               COALESCE(pr.apellido || ', ' || pr.nombre, 'Sin profesional') AS c5
        FROM turnos t
        JOIN pacientes p ON p.id = t.paciente_id
        LEFT JOIN profesionales pr ON pr.id = t.profesional_id
        WHERE t.fecha BETWEEN ${desde} AND ${hasta} AND t.estado = 'atendido'
        ORDER BY t.fecha DESC, c5, c2
        LIMIT 2000`);
      return filas(r.rows as unknown[], ["c1", "c2", "c3", "c4", "c5"]);
    },
  },
  {
    clave: "listado_tokens_por_profesional",
    titulo: "Listado de Pacientes por Profesional y por día, con Token",
    columnas: ["Fecha", "Profesional", "Hora", "Paciente", "DNI", "Token", "Estado del token"],
    ejecutar: async (desde, hasta) => {
      const r = await db.execute(sql`
        SELECT t.fecha AS c1,
               COALESCE(pr.apellido || ', ' || pr.nombre, 'Sin profesional') AS c2,
               SUBSTRING(t.hora_inicio FROM 1 FOR 5) AS c3,
               p.apellido || ', ' || p.nombre AS c4,
               p.dni AS c5,
               COALESCE(ct.token_completo, NULLIF(TRIM(t.klinicos_token), ''), ct.token_masked) AS c6,
               CASE WHEN ct.token_status IS NULL AND NULLIF(TRIM(t.klinicos_token), '') IS NOT NULL
                 THEN 'Validado'
               ELSE CASE ct.token_status
                 WHEN 'ACCEPTED' THEN 'Validado'
                 WHEN 'DENIED' THEN 'Rechazado'
                 WHEN 'EXPIRED' THEN 'Vencido'
                 WHEN 'ALREADY_USED' THEN 'Ya usado'
                 WHEN 'PATIENT_MISMATCH' THEN 'No corresponde al paciente'
                 WHEN 'PENDING' THEN 'Pendiente'
                 WHEN 'VALIDATING' THEN 'Validando'
                 WHEN 'TECHNICAL_ERROR' THEN 'Error técnico (reintentar)'
                 WHEN 'TIMEOUT' THEN 'Sin respuesta (reintentar)'
                 WHEN 'MANUAL_REVIEW' THEN 'Revisión manual'
                 WHEN 'NOT_REQUESTED' THEN 'Sin token'
                 ELSE COALESCE(ct.token_status, 'Sin token')
               END END AS c7
        FROM turnos t
        JOIN pacientes p ON p.id = t.paciente_id
        LEFT JOIN profesionales pr ON pr.id = t.profesional_id
        LEFT JOIN consultas_token ct ON ct.consultation_id = t.id
        WHERE t.fecha BETWEEN ${desde} AND ${hasta}
          AND t.estado NOT IN ('cancelado')
        ORDER BY t.fecha DESC, c2, t.hora_inicio, c4
        LIMIT 3000`);
      return filas(r.rows as unknown[], ["c1", "c2", "c3", "c4", "c5", "c6", "c7"]);
    },
  },
  {
    // Bonos IOMA computados al médico que ATENDIÓ (pedido Federico 02/08/2026):
    // en guardia/sala grupal el turno no tiene médico titular; el que llama al
    // paciente queda en llamado_por_profesional_id y el bono se le computa a él.
    clave: "bonos_por_medico_resumen",
    titulo: "Bonos IOMA por Médico (resumen para liquidación)",
    columnas: ["Médico", "Bonos", "Pacientes"],
    ejecutar: async (desde, hasta) => {
      const r = await db.execute(sql`
        SELECT COALESCE(pr.apellido || ', ' || pr.nombre, 'Sin médico asignado') AS c1,
               COUNT(*) AS c2,
               COUNT(DISTINCT t.paciente_id) AS c3
        FROM consultas_token ct
        JOIN turnos t ON t.id = ct.consultation_id
        LEFT JOIN profesionales pr
          ON pr.id = COALESCE(t.llamado_por_profesional_id, t.profesional_id)
        WHERE ct.authorization_number ~ '^[0-9]+$'
          AND ct.token_status = 'ACCEPTED'
          AND t.fecha BETWEEN ${desde} AND ${hasta}
          AND t.estado NOT IN ('cancelado')
        GROUP BY pr.id, 1 ORDER BY 2 DESC`);
      return filas(r.rows as unknown[], ["c1", "c2", "c3"]);
    },
  },
  {
    clave: "bonos_por_medico_detalle",
    titulo: "Bonos IOMA por Médico (detalle de atenciones con bono)",
    columnas: ["Fecha", "Hora", "Médico", "Paciente", "DNI", "Agenda", "N° de Bono"],
    ejecutar: async (desde, hasta) => {
      const r = await db.execute(sql`
        SELECT t.fecha AS c1,
               SUBSTRING(t.hora_inicio FROM 1 FOR 5) AS c2,
               COALESCE(prl.apellido || ', ' || prl.nombre,
                        prt.apellido || ', ' || prt.nombre,
                        'Sin médico asignado') AS c3,
               p.apellido || ', ' || p.nombre AS c4,
               p.dni AS c5,
               COALESCE(tu.nombre, 'Sin agenda') AS c6,
               ct.authorization_number AS c7
        FROM consultas_token ct
        JOIN turnos t ON t.id = ct.consultation_id
        JOIN pacientes p ON p.id = t.paciente_id
        LEFT JOIN turneras tu ON tu.id = t.turnera_id
        LEFT JOIN profesionales prl ON prl.id = t.llamado_por_profesional_id
        LEFT JOIN profesionales prt ON prt.id = t.profesional_id
        WHERE ct.authorization_number ~ '^[0-9]+$'
          AND ct.token_status = 'ACCEPTED'
          AND t.fecha BETWEEN ${desde} AND ${hasta}
          AND t.estado NOT IN ('cancelado')
        ORDER BY t.fecha DESC, c3, t.hora_inicio
        LIMIT 3000`);
      return filas(r.rows as unknown[], ["c1", "c2", "c3", "c4", "c5", "c6", "c7"]);
    },
  },
  {
    clave: "asistencia_por_profesional",
    titulo: "Porcentaje (Ausente y Asistencia) por Profesional entre fechas",
    columnas: ["Profesional", "Turnos", "Atendidos", "Ausentes", "% Asistencia", "% Ausentismo"],
    ejecutar: async (desde, hasta) => {
      const r = await db.execute(sql`
        SELECT COALESCE(pr.apellido || ', ' || pr.nombre, 'Sin profesional') AS c1,
               COUNT(*) AS c2,
               COUNT(*) FILTER (WHERE t.estado = 'atendido') AS c3,
               COUNT(*) FILTER (WHERE t.estado = 'ausente') AS c4,
               ROUND(100.0 * COUNT(*) FILTER (WHERE t.estado = 'atendido') / NULLIF(COUNT(*), 0), 1) || '%' AS c5,
               ROUND(100.0 * COUNT(*) FILTER (WHERE t.estado = 'ausente') / NULLIF(COUNT(*), 0), 1) || '%' AS c6
        FROM turnos t
        LEFT JOIN profesionales pr ON pr.id = t.profesional_id
        WHERE t.fecha BETWEEN ${desde} AND ${hasta}
        GROUP BY 1 ORDER BY 2 DESC`);
      return filas(r.rows as unknown[], ["c1", "c2", "c3", "c4", "c5", "c6"]);
    },
  },
  {
    clave: "tiempo_espera_por_profesional",
    titulo: "Tiempo de espera por Profesional (admisión → llamado)",
    columnas: ["Profesional", "Turnos medidos", "Espera promedio (min)", "Espera máxima (min)"],
    ejecutar: async (desde, hasta) => {
      const r = await db.execute(sql`
        SELECT COALESCE(pr.apellido || ', ' || pr.nombre, 'Sin profesional') AS c1,
               COUNT(*) AS c2,
               ROUND(AVG(EXTRACT(EPOCH FROM (t.llamado_en - t.admitido_en)) / 60)::numeric, 1) AS c3,
               ROUND(MAX(EXTRACT(EPOCH FROM (t.llamado_en - t.admitido_en)) / 60)::numeric, 1) AS c4
        FROM turnos t
        LEFT JOIN profesionales pr ON pr.id = t.profesional_id
        WHERE t.fecha BETWEEN ${desde} AND ${hasta}
          AND t.admitido_en IS NOT NULL AND t.llamado_en IS NOT NULL
          AND t.llamado_en >= t.admitido_en
        GROUP BY 1 ORDER BY 3 DESC`);
      return filas(r.rows as unknown[], ["c1", "c2", "c3", "c4"]);
    },
  },
  {
    clave: "tiempo_espera_promedio",
    titulo: "Tiempo de espera promedio (admisión → llamado)",
    columnas: ["Fecha", "Turnos medidos", "Espera promedio (min)", "Espera máxima (min)"],
    ejecutar: async (desde, hasta) => {
      const r = await db.execute(sql`
        SELECT t.fecha AS c1,
               COUNT(*) AS c2,
               ROUND(AVG(EXTRACT(EPOCH FROM (t.llamado_en - t.admitido_en)) / 60)::numeric, 1) AS c3,
               ROUND(MAX(EXTRACT(EPOCH FROM (t.llamado_en - t.admitido_en)) / 60)::numeric, 1) AS c4
        FROM turnos t
        WHERE t.fecha BETWEEN ${desde} AND ${hasta}
          AND t.admitido_en IS NOT NULL AND t.llamado_en IS NOT NULL
          AND t.llamado_en >= t.admitido_en
        GROUP BY 1 ORDER BY 1 DESC`);
      return filas(r.rows as unknown[], ["c1", "c2", "c3", "c4"]);
    },
  },
];

// GET /estadisticas/reportes — lista de reportes disponibles (solo admin)
router.get("/estadisticas/reportes", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  res.json(REPORTES.map(({ clave, titulo }) => ({ clave, titulo })));
});

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

// GET /estadisticas/reporte?clave&desde&hasta — ejecutar reporte (solo admin)
router.get("/estadisticas/reporte", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const { clave, desde, hasta } = req.query;
  if (typeof clave !== "string" || typeof desde !== "string" || typeof hasta !== "string"
      || !FECHA_RE.test(desde) || !FECHA_RE.test(hasta)) {
    res.status(400).json({ error: "Parámetros inválidos: clave, desde y hasta (YYYY-MM-DD) son obligatorios" });
    return;
  }
  const def = REPORTES.find((r) => r.clave === clave);
  if (!def) {
    res.status(404).json({ error: "Reporte no encontrado" });
    return;
  }
  const data = await def.ejecutar(desde, hasta);
  res.json({ clave: def.clave, titulo: def.titulo, desde, hasta, columnas: def.columnas, filas: data });
});

export default router;
