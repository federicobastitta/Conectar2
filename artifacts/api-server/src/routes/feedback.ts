import { Router, type IRouter } from "express";
import { z } from "zod";
import { and, eq, isNull, desc, sql, inArray } from "drizzle-orm";
import { db, feedbackMensajesTable, usersTable } from "@workspace/db";
import { requireRol } from "./auth";

// ── Chat de feedback "usuarios → desarrollo" ────────────────────────────────
// Todo usuario del sistema tiene un hilo directo con el equipo de desarrollo
// para reportar fallas o proponer mejoras (texto + capturas de pantalla).
// El perfil "desarrollador" ve todas las conversaciones y responde.

const router: IRouter = Router();
const todosLosUsuarios = requireRol("admin", "recepcionista", "medico");

const AdjuntoSchema = z.object({
  path: z.string().min(1).max(500),
  nombre: z.string().min(1).max(200),
  tipo: z.string().max(100).optional(),
});
const EnviarBody = z.object({
  mensaje: z.string().max(2000).optional(),
  adjuntos: z.array(AdjuntoSchema).max(5).optional(),
  // Solo lo usa desarrollo para responder en el hilo de otro usuario.
  usuarioId: z.number().int().positive().optional(),
});

type Usuario = typeof usersTable.$inferSelect;
const esDesarrollo = (u: Usuario) => (u as { perfil?: string | null }).perfil === "desarrollador";

function serializar(m: typeof feedbackMensajesTable.$inferSelect, enviadoPorNombre?: string | null) {
  let adjuntos: unknown[] = [];
  try {
    adjuntos = m.adjuntos ? (JSON.parse(m.adjuntos) as unknown[]) : [];
  } catch {
    adjuntos = [];
  }
  return {
    id: m.id,
    usuarioId: m.usuarioId,
    emisor: m.emisor,
    enviadoPorNombre: enviadoPorNombre ?? null,
    mensaje: m.mensaje,
    adjuntos,
    creadoEn: m.creadoEn.toISOString(),
    leido: m.leidoEn != null,
  };
}

// Enviar un mensaje. Usuario común: siempre a su propio hilo. Desarrollo:
// responde en el hilo indicado por usuarioId (o escribe en el suyo si no).
router.post("/feedback/mensajes", todosLosUsuarios, async (req, res) => {
  const parsed = EnviarBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Datos inválidos" });
    return;
  }
  const user = res.locals.user as Usuario;
  const mensaje = (parsed.data.mensaje ?? "").trim();
  const adjuntos = parsed.data.adjuntos ?? [];
  if (!mensaje && adjuntos.length === 0) {
    res.status(400).json({ error: "Escribí un mensaje o adjuntá un archivo" });
    return;
  }

  let usuarioId = user.id;
  let emisor: "usuario" | "desarrollo" = "usuario";
  if (esDesarrollo(user) && parsed.data.usuarioId && parsed.data.usuarioId !== user.id) {
    const [destino] = await db.select().from(usersTable).where(eq(usersTable.id, parsed.data.usuarioId)).limit(1);
    if (!destino) {
      res.status(404).json({ error: "Usuario inexistente" });
      return;
    }
    usuarioId = destino.id;
    emisor = "desarrollo";
  }

  const [creado] = await db
    .insert(feedbackMensajesTable)
    .values({
      usuarioId,
      enviadoPorId: user.id,
      emisor,
      mensaje,
      adjuntos: adjuntos.length > 0 ? JSON.stringify(adjuntos) : null,
    })
    .returning();
  req.log.info({ usuarioId, emisor, adjuntos: adjuntos.length }, "feedback: mensaje enviado");
  res.status(201).json(serializar(creado, user.nombre));
});

// Mensajes de un hilo. Usuario común: el suyo. Desarrollo: ?usuarioId=N.
// Marca como leídos los mensajes que recibió quien consulta.
router.get("/feedback/mensajes", todosLosUsuarios, async (req, res) => {
  const user = res.locals.user as Usuario;
  const dev = esDesarrollo(user);
  const qUsuarioId = req.query.usuarioId ? Number(req.query.usuarioId) : null;
  const usuarioId = dev && qUsuarioId && Number.isInteger(qUsuarioId) ? qUsuarioId : user.id;
  const recibidoDe = dev && usuarioId !== user.id ? "usuario" : "desarrollo";

  const filas = await db
    .select({ m: feedbackMensajesTable, enviadoPorNombre: usersTable.nombre })
    .from(feedbackMensajesTable)
    .leftJoin(usersTable, eq(feedbackMensajesTable.enviadoPorId, usersTable.id))
    .where(eq(feedbackMensajesTable.usuarioId, usuarioId))
    .orderBy(desc(feedbackMensajesTable.id))
    .limit(200);
  filas.reverse();

  const pendientes = filas.filter((f) => f.m.emisor === recibidoDe && f.m.leidoEn == null).map((f) => f.m.id);
  if (pendientes.length > 0) {
    await db.update(feedbackMensajesTable).set({ leidoEn: new Date() }).where(inArray(feedbackMensajesTable.id, pendientes));
  }
  const ahora = new Date();
  res.json(filas.map((f) => serializar(pendientes.includes(f.m.id) ? { ...f.m, leidoEn: ahora } : f.m, f.enviadoPorNombre)));
});

// Bandeja de desarrollo: una conversación por usuario que escribió alguna vez.
router.get("/feedback/conversaciones", todosLosUsuarios, async (req, res) => {
  const user = res.locals.user as Usuario;
  if (!esDesarrollo(user)) {
    res.status(403).json({ error: "Solo el perfil desarrollador ve la bandeja de feedback" });
    return;
  }
  const filas = await db
    .select({
      usuarioId: feedbackMensajesTable.usuarioId,
      nombre: usersTable.nombre,
      email: usersTable.email,
      rol: usersTable.rol,
      perfil: usersTable.perfil,
      ultimoMensaje: sql<string>`(array_agg(${feedbackMensajesTable.mensaje} ORDER BY ${feedbackMensajesTable.id} DESC))[1]`,
      ultimoEn: sql<string>`max(${feedbackMensajesTable.creadoEn})`,
      noLeidos: sql<number>`count(*) FILTER (WHERE ${feedbackMensajesTable.emisor} = 'usuario' AND ${feedbackMensajesTable.leidoEn} IS NULL)::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(feedbackMensajesTable)
    .leftJoin(usersTable, eq(feedbackMensajesTable.usuarioId, usersTable.id))
    .groupBy(feedbackMensajesTable.usuarioId, usersTable.nombre, usersTable.email, usersTable.rol, usersTable.perfil)
    .orderBy(sql`max(${feedbackMensajesTable.id}) DESC`);
  res.json(
    filas.map((f) => ({
      usuarioId: f.usuarioId,
      nombre: f.nombre ?? "(usuario eliminado)",
      email: f.email ?? "",
      rol: f.rol ?? "",
      perfil: f.perfil ?? null,
      ultimoMensaje: f.ultimoMensaje ?? "",
      ultimoEn: new Date(f.ultimoEn).toISOString(),
      noLeidos: f.noLeidos,
      total: f.total,
    })),
  );
});

// Contador para el badge. Usuario: respuestas de desarrollo sin leer en su
// hilo. Desarrollo: mensajes de usuarios sin leer en todos los hilos.
router.get("/feedback/no-leidos", todosLosUsuarios, async (req, res) => {
  const user = res.locals.user as Usuario;
  const dev = esDesarrollo(user);
  const cond = dev
    ? and(eq(feedbackMensajesTable.emisor, "usuario"), isNull(feedbackMensajesTable.leidoEn))
    : and(
        eq(feedbackMensajesTable.usuarioId, user.id),
        eq(feedbackMensajesTable.emisor, "desarrollo"),
        isNull(feedbackMensajesTable.leidoEn),
      );
  const [fila] = await db.select({ n: sql<number>`count(*)::int` }).from(feedbackMensajesTable).where(cond);
  res.json({ noLeidos: fila?.n ?? 0 });
});

export default router;
