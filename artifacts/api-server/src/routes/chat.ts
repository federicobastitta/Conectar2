import { Router, type IRouter } from "express";
import { and, eq, isNull, desc, sql, inArray } from "drizzle-orm";
import { db, chatMensajesTable, profesionalesTable, usersTable } from "@workspace/db";
import { EnviarChatMensajeBody } from "@workspace/api-zod";
import { requireRol } from "./auth";

const router: IRouter = Router();

function serializar(m: typeof chatMensajesTable.$inferSelect, enviadoPorNombre?: string | null) {
  return {
    id: m.id,
    profesionalId: m.profesionalId,
    staffUsuarioId: m.staffUsuarioId,
    enviadoPorNombre: enviadoPorNombre ?? null,
    emisor: m.emisor,
    mensaje: m.mensaje,
    creadoEn: m.creadoEn.toISOString(),
    leido: m.leidoEn != null,
  };
}

function profesionalIdDe(user: typeof usersTable.$inferSelect): number | null {
  const id = user.profesionalId ? parseInt(user.profesionalId) : null;
  return id && Number.isInteger(id) ? id : null;
}

// Enviar un mensaje. El staff indica profesionalId (y canal:true para el canal
// general); el medico indica staffUsuarioId (chat directo) o canal:true /
// nada para escribirle a toda la recepcion.
router.post("/chat/mensajes", requireRol("admin", "recepcionista", "medico"), async (req, res) => {
  const parsed = EnviarChatMensajeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Datos inválidos" });
    return;
  }
  const user = res.locals.user as typeof usersTable.$inferSelect;
  const mensaje = parsed.data.mensaje.trim();
  if (!mensaje || mensaje.length > 1000) {
    res.status(400).json({ error: "Escribí el mensaje (máx. 1000 caracteres)" });
    return;
  }

  // Política única: admin y recepcionista actúan siempre como staff;
  // solo el rol medico emite como médico (sin impersonación).
  let profesionalId: number;
  let staffUsuarioId: number | null;
  let emisor: "staff" | "medico";

  if (user.rol === "medico") {
    const miProfesionalId = profesionalIdDe(user);
    if (!miProfesionalId) {
      res.status(400).json({ error: "Tu usuario no tiene profesional asociado" });
      return;
    }
    profesionalId = miProfesionalId;
    emisor = "medico";
    const destino = parsed.data.staffUsuarioId;
    if (destino && !parsed.data.canal) {
      const [staff] = await db.select().from(usersTable).where(eq(usersTable.id, destino)).limit(1);
      if (!staff || (staff.rol !== "admin" && staff.rol !== "recepcionista")) {
        res.status(404).json({ error: "Destinatario inexistente" });
        return;
      }
      staffUsuarioId = destino;
    } else {
      // Sin destinatario puntual: canal general con toda la recepción.
      staffUsuarioId = null;
    }
  } else {
    const destino = parsed.data.profesionalId;
    if (!destino) {
      res.status(400).json({ error: "Falta el profesional" });
      return;
    }
    const [prof] = await db.select().from(profesionalesTable).where(eq(profesionalesTable.id, destino)).limit(1);
    if (!prof || !prof.activo) {
      res.status(404).json({ error: "Profesional inexistente o inactivo" });
      return;
    }
    profesionalId = destino;
    staffUsuarioId = parsed.data.canal ? null : user.id;
    emisor = "staff";
  }

  const [creado] = await db
    .insert(chatMensajesTable)
    .values({ profesionalId, staffUsuarioId, enviadoPorId: user.id, emisor, mensaje })
    .returning();
  req.log.info({ profesionalId, staffUsuarioId, emisor, canal: staffUsuarioId == null }, "mensaje de chat enviado");
  res.status(201).json(serializar(creado, user.nombre));
});

// Mensajes de una conversacion (directa o canal general). Marca como leidos
// los mensajes que recibio quien consulta.
router.get("/chat/mensajes", requireRol("admin", "recepcionista", "medico"), async (req, res) => {
  const user = res.locals.user as typeof usersTable.$inferSelect;
  const qProfesionalId = req.query.profesionalId ? Number(req.query.profesionalId) : null;
  const qStaffUsuarioId = req.query.staffUsuarioId ? Number(req.query.staffUsuarioId) : null;
  const canal = req.query.canal === "true";

  let profesionalId: number | null;
  let staffUsuarioId: number | null;
  let recibidoDe: "staff" | "medico";
  if (user.rol === "medico") {
    profesionalId = profesionalIdDe(user);
    staffUsuarioId = canal ? null : qStaffUsuarioId;
    recibidoDe = "staff";
  } else {
    profesionalId = qProfesionalId;
    staffUsuarioId = canal ? null : user.id;
    recibidoDe = "medico";
  }
  if (!profesionalId || !Number.isInteger(profesionalId) || (!canal && (!staffUsuarioId || !Number.isInteger(staffUsuarioId)))) {
    res.status(400).json({ error: "Falta identificar la conversación" });
    return;
  }

  const filtroStaff = canal
    ? isNull(chatMensajesTable.staffUsuarioId)
    : eq(chatMensajesTable.staffUsuarioId, staffUsuarioId!);
  const filas = await db
    .select({ m: chatMensajesTable, enviadoPorNombre: usersTable.nombre })
    .from(chatMensajesTable)
    .leftJoin(usersTable, eq(chatMensajesTable.enviadoPorId, usersTable.id))
    .where(and(eq(chatMensajesTable.profesionalId, profesionalId), filtroStaff))
    .orderBy(desc(chatMensajesTable.id))
    .limit(200);
  filas.reverse();

  const pendientes = filas.filter((f) => f.m.emisor === recibidoDe && f.m.leidoEn == null).map((f) => f.m.id);
  if (pendientes.length > 0) {
    await db.update(chatMensajesTable).set({ leidoEn: new Date() }).where(inArray(chatMensajesTable.id, pendientes));
  }
  const ahora = new Date();
  res.json(
    filas.map((f) =>
      serializar(pendientes.includes(f.m.id) ? { ...f.m, leidoEn: ahora } : f.m, f.enviadoPorNombre),
    ),
  );
});

// Conversaciones del usuario: el staff ve una por profesional (directas y
// canales generales); el medico una por usuario de recepcion mas su canal
// general con toda la recepcion.
router.get("/chat/conversaciones", requireRol("admin", "recepcionista", "medico"), async (req, res) => {
  const user = res.locals.user as typeof usersTable.$inferSelect;
  const miProfesionalId = profesionalIdDe(user);
  const comoMedico = user.rol === "medico" && !!miProfesionalId;

  if (comoMedico) {
    const directas = await db
      .select({
        staffUsuarioId: chatMensajesTable.staffUsuarioId,
        nombre: usersTable.nombre,
        ultimoMensaje: sql<string>`(array_agg(${chatMensajesTable.mensaje} ORDER BY ${chatMensajesTable.id} DESC))[1]`,
        ultimoEn: sql<string>`max(${chatMensajesTable.creadoEn})`,
        noLeidos: sql<number>`count(*) FILTER (WHERE ${chatMensajesTable.emisor} = 'staff' AND ${chatMensajesTable.leidoEn} IS NULL)::int`,
      })
      .from(chatMensajesTable)
      .leftJoin(usersTable, eq(chatMensajesTable.staffUsuarioId, usersTable.id))
      .where(eq(chatMensajesTable.profesionalId, miProfesionalId!))
      .groupBy(chatMensajesTable.staffUsuarioId, usersTable.nombre)
      .orderBy(sql`max(${chatMensajesTable.id}) DESC`);
    res.json(
      directas.map((f) => ({
        profesionalId: miProfesionalId,
        staffUsuarioId: f.staffUsuarioId,
        canal: f.staffUsuarioId == null,
        nombre: f.staffUsuarioId == null ? "Recepción (todos)" : (f.nombre ?? ""),
        ultimoMensaje: f.ultimoMensaje ?? "",
        ultimoEn: new Date(f.ultimoEn).toISOString(),
        noLeidos: f.noLeidos,
      })),
    );
    return;
  }

  if (user.rol !== "admin" && user.rol !== "recepcionista") {
    res.json([]);
    return;
  }
  // Directas mias + canales generales (visibles para todo el staff).
  const filas = await db
    .select({
      profesionalId: chatMensajesTable.profesionalId,
      esCanal: sql<boolean>`${chatMensajesTable.staffUsuarioId} IS NULL`,
      nombre: sql<string>`coalesce(${profesionalesTable.apellido} || ', ' || ${profesionalesTable.nombre}, ${profesionalesTable.nombre})`,
      ultimoMensaje: sql<string>`(array_agg(${chatMensajesTable.mensaje} ORDER BY ${chatMensajesTable.id} DESC))[1]`,
      ultimoEn: sql<string>`max(${chatMensajesTable.creadoEn})`,
      noLeidos: sql<number>`count(*) FILTER (WHERE ${chatMensajesTable.emisor} = 'medico' AND ${chatMensajesTable.leidoEn} IS NULL)::int`,
    })
    .from(chatMensajesTable)
    .innerJoin(profesionalesTable, eq(chatMensajesTable.profesionalId, profesionalesTable.id))
    .where(sql`(${chatMensajesTable.staffUsuarioId} = ${user.id} OR ${chatMensajesTable.staffUsuarioId} IS NULL)`)
    .groupBy(chatMensajesTable.profesionalId, sql`${chatMensajesTable.staffUsuarioId} IS NULL`, profesionalesTable.apellido, profesionalesTable.nombre)
    .orderBy(sql`max(${chatMensajesTable.id}) DESC`);
  res.json(
    filas.map((f) => ({
      profesionalId: f.profesionalId,
      staffUsuarioId: f.esCanal ? null : user.id,
      canal: f.esCanal,
      nombre: f.esCanal ? `${f.nombre ?? ""} — canal recepción` : (f.nombre ?? ""),
      ultimoMensaje: f.ultimoMensaje ?? "",
      ultimoEn: new Date(f.ultimoEn).toISOString(),
      noLeidos: f.noLeidos,
    })),
  );
});

export default router;
