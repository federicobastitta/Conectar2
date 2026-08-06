import { Router, type IRouter } from "express";
import { and, eq, isNull, asc } from "drizzle-orm";
import { db, mensajesProfesionalTable, profesionalesTable, usersTable } from "@workspace/db";
import { EnviarMensajeProfesionalBody } from "@workspace/api-zod";
import { requireRol } from "./auth";

const router: IRouter = Router();

type FilaMensaje = {
  m: typeof mensajesProfesionalTable.$inferSelect;
  deNombre: string | null;
};

function serializar(fila: FilaMensaje) {
  return {
    id: fila.m.id,
    profesionalId: fila.m.profesionalId,
    mensaje: fila.m.mensaje,
    deNombre: fila.deNombre ?? "",
    creadoEn: fila.m.creadoEn.toISOString(),
    leido: fila.m.leidoEn != null,
  };
}

// Recepción/administración manda un mensaje dirigido a un profesional activo.
router.post("/recepcion/mensaje-profesional", requireRol("admin", "recepcionista"), async (req, res) => {
  const parsed = EnviarMensajeProfesionalBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Datos inválidos" });
    return;
  }
  const user = res.locals.user as typeof usersTable.$inferSelect;
  const { profesionalId } = parsed.data;
  const mensaje = parsed.data.mensaje.trim();
  if (!mensaje) {
    res.status(400).json({ error: "Escribí el mensaje" });
    return;
  }

  const [prof] = await db
    .select()
    .from(profesionalesTable)
    .where(eq(profesionalesTable.id, profesionalId))
    .limit(1);
  if (!prof || !prof.activo) {
    res.status(404).json({ error: "Profesional inexistente o inactivo" });
    return;
  }

  const [creado] = await db
    .insert(mensajesProfesionalTable)
    .values({ profesionalId, deUsuarioId: user.id, mensaje })
    .returning();
  req.log.info({ profesionalId, deUsuarioId: user.id }, "mensaje dirigido a profesional enviado");
  res.status(201).json(serializar({ m: creado, deNombre: user.nombre }));
});

// El médico ve sus mensajes no leídos (los de su profesionalId).
router.get("/medico/mensajes", requireRol("medico", "admin"), async (req, res) => {
  const user = res.locals.user as typeof usersTable.$inferSelect;
  const profesionalId = user.profesionalId ? parseInt(user.profesionalId) : null;
  if (!profesionalId || !Number.isInteger(profesionalId)) {
    res.json([]);
    return;
  }
  const filas = await db
    .select({ m: mensajesProfesionalTable, deNombre: usersTable.nombre })
    .from(mensajesProfesionalTable)
    .innerJoin(usersTable, eq(mensajesProfesionalTable.deUsuarioId, usersTable.id))
    .where(and(eq(mensajesProfesionalTable.profesionalId, profesionalId), isNull(mensajesProfesionalTable.leidoEn)))
    .orderBy(asc(mensajesProfesionalTable.creadoEn));
  res.json(filas.map(serializar));
});

// Marcar leído: solo el destinatario (o un admin con ese profesionalId).
router.post("/medico/mensajes/:id/leido", requireRol("medico", "admin"), async (req, res) => {
  const user = res.locals.user as typeof usersTable.$inferSelect;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(404).json({ error: "Mensaje inexistente" });
    return;
  }
  const profesionalId = user.profesionalId ? parseInt(user.profesionalId) : null;
  const [msg] = await db
    .select()
    .from(mensajesProfesionalTable)
    .where(eq(mensajesProfesionalTable.id, id))
    .limit(1);
  if (!msg) {
    res.status(404).json({ error: "Mensaje inexistente" });
    return;
  }
  if (msg.profesionalId !== profesionalId && user.rol !== "admin") {
    res.status(403).json({ error: "Sin permisos" });
    return;
  }
  const [actualizado] = await db
    .update(mensajesProfesionalTable)
    .set({ leidoEn: new Date() })
    .where(eq(mensajesProfesionalTable.id, id))
    .returning();
  res.json(serializar({ m: actualizado, deNombre: user.nombre }));
});

export default router;
