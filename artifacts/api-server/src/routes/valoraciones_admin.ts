import { Router, type IRouter, type Request, type Response } from "express";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db, usersTable, pacientesTable, profesionalesTable, especialidadesTable, valoracionesAtencionTable } from "@workspace/db";
import { getUserIdFromToken } from "./auth";

// Estadísticas de puntajes (valoraciones de pacientes) por médico.
// Solo para usuarios con rol admin (perfiles administrador, gerente, desarrollador).

const router: IRouter = Router();

async function getAdminUser(req: Request) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return null;
  const userId = await getUserIdFromToken(token);
  if (!userId) return null;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user || user.rol !== "admin") return null;
  return user;
}

// Resumen por médico: invitaciones, respuestas, promedio y cantidad por estrella.
router.get("/valoraciones/estadisticas", async (req: Request, res: Response) => {
  const user = await getAdminUser(req);
  if (!user) return res.status(403).json({ error: "Solo administradores" });

  const filas = await db
    .select({
      profesionalId: valoracionesAtencionTable.profesionalId,
      nombre: profesionalesTable.nombre,
      apellido: profesionalesTable.apellido,
      especialidad: especialidadesTable.nombre,
      invitaciones: sql<number>`count(*)::int`,
      respuestas: sql<number>`count(${valoracionesAtencionTable.puntaje})::int`,
      promedio: sql<number | null>`avg(${valoracionesAtencionTable.puntaje})::float`,
      estrellas1: sql<number>`count(*) filter (where ${valoracionesAtencionTable.puntaje} = 1)::int`,
      estrellas2: sql<number>`count(*) filter (where ${valoracionesAtencionTable.puntaje} = 2)::int`,
      estrellas3: sql<number>`count(*) filter (where ${valoracionesAtencionTable.puntaje} = 3)::int`,
      estrellas4: sql<number>`count(*) filter (where ${valoracionesAtencionTable.puntaje} = 4)::int`,
      estrellas5: sql<number>`count(*) filter (where ${valoracionesAtencionTable.puntaje} = 5)::int`,
      comentarios: sql<number>`count(*) filter (where ${valoracionesAtencionTable.comentario} is not null and ${valoracionesAtencionTable.comentario} <> '')::int`,
      ultimaRespuesta: sql<string | null>`max(${valoracionesAtencionTable.calificadoEn})::text`,
    })
    .from(valoracionesAtencionTable)
    .leftJoin(profesionalesTable, eq(profesionalesTable.id, valoracionesAtencionTable.profesionalId))
    .leftJoin(especialidadesTable, eq(especialidadesTable.id, profesionalesTable.especialidadId))
    .groupBy(valoracionesAtencionTable.profesionalId, profesionalesTable.nombre, profesionalesTable.apellido, especialidadesTable.nombre)
    .orderBy(sql`avg(${valoracionesAtencionTable.puntaje}) DESC NULLS LAST`);

  return res.json(
    filas.map((f) => ({
      profesionalId: f.profesionalId,
      nombre: [f.nombre, f.apellido].filter(Boolean).join(" ") || `Profesional #${f.profesionalId}`,
      especialidad: f.especialidad ?? null,
      invitaciones: f.invitaciones,
      respuestas: f.respuestas,
      promedio: f.promedio,
      comentarios: f.comentarios,
      distribucion: { "1": f.estrellas1, "2": f.estrellas2, "3": f.estrellas3, "4": f.estrellas4, "5": f.estrellas5 },
      ultimaRespuesta: f.ultimaRespuesta,
    })),
  );
});

// Detalle de un médico: cada valoración respondida con paciente y comentario.
router.get("/valoraciones/profesional/:profesionalId", async (req: Request, res: Response) => {
  const user = await getAdminUser(req);
  if (!user) return res.status(403).json({ error: "Solo administradores" });
  const rawId = String(req.params.profesionalId);
  if (!/^\d+$/.test(rawId)) return res.status(400).json({ error: "profesionalId inválido" });
  const profesionalId = parseInt(rawId);

  const [prof] = await db
    .select({ nombre: profesionalesTable.nombre, apellido: profesionalesTable.apellido, especialidad: especialidadesTable.nombre })
    .from(profesionalesTable)
    .leftJoin(especialidadesTable, eq(especialidadesTable.id, profesionalesTable.especialidadId))
    .where(eq(profesionalesTable.id, profesionalId))
    .limit(1);

  const filas = await db
    .select({
      id: valoracionesAtencionTable.id,
      puntaje: valoracionesAtencionTable.puntaje,
      comentario: valoracionesAtencionTable.comentario,
      calificadoEn: valoracionesAtencionTable.calificadoEn,
      pacienteNombre: pacientesTable.nombre,
      pacienteApellido: pacientesTable.apellido,
    })
    .from(valoracionesAtencionTable)
    .leftJoin(pacientesTable, eq(pacientesTable.id, valoracionesAtencionTable.pacienteId))
    .where(and(eq(valoracionesAtencionTable.profesionalId, profesionalId), isNotNull(valoracionesAtencionTable.puntaje)))
    .orderBy(desc(valoracionesAtencionTable.calificadoEn));

  return res.json({
    profesional: { id: profesionalId, nombre: [prof?.nombre, prof?.apellido].filter(Boolean).join(" ") || `Profesional #${profesionalId}`, especialidad: prof?.especialidad ?? null },
    valoraciones: filas.map((f) => ({
      id: f.id,
      puntaje: f.puntaje ?? 0,
      comentario: f.comentario ?? null,
      fecha: f.calificadoEn?.toISOString() ?? null,
      paciente: [f.pacienteApellido, f.pacienteNombre].filter(Boolean).join(", ") || "Paciente desconocido",
    })),
  });
});

// Forzar el envío inmediato de las invitaciones pendientes (herramienta de
// prueba para administradores): adelanta proximo_intento_en a ahora.
router.post("/valoraciones/enviar-ahora", async (req: Request, res: Response) => {
  const user = await getAdminUser(req);
  if (!user) return res.status(403).json({ error: "Solo administradores" });

  const filas = await db
    .update(valoracionesAtencionTable)
    .set({ proximoIntentoEn: new Date(), actualizadoEn: new Date() })
    .where(eq(valoracionesAtencionTable.estadoEnvio, "pendiente"))
    .returning({ id: valoracionesAtencionTable.id, encounterId: valoracionesAtencionTable.encounterId });

  return res.json({ adelantadas: filas.length, encounters: filas.map((f) => f.encounterId) });
});

export default router;
