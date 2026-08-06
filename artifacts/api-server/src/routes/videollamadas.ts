import { Router, type IRouter } from "express";
import { and, eq, desc } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db, videollamadasTable, pacientesTable, usersTable } from "@workspace/db";
import { CrearVideollamadaBody } from "@workspace/api-zod";
import { getUserFromRequest, requireRol } from "./auth";

const router: IRouter = Router();

const JITSI_BASE = "https://meet.jit.si";

function armarUrl(sala: string): string {
  return `${JITSI_BASE}/${sala}#config.prejoinConfig.enabled=false`;
}

type FilaVideollamada = {
  vc: typeof videollamadasTable.$inferSelect;
  pacienteNombre: string | null;
  pacienteApellido: string | null;
  medicoNombre: string | null;
};

function serializar(fila: FilaVideollamada) {
  const { vc } = fila;
  return {
    id: vc.id,
    pacienteId: vc.pacienteId,
    pacienteNombre: [fila.pacienteApellido, fila.pacienteNombre].filter(Boolean).join(", "),
    medicoNombre: fila.medicoNombre ?? "",
    sala: vc.sala,
    url: armarUrl(vc.sala),
    estado: vc.estado,
    creadaEn: vc.creadaEn.toISOString(),
  };
}

const seleccionConNombres = {
  vc: videollamadasTable,
  pacienteNombre: pacientesTable.nombre,
  pacienteApellido: pacientesTable.apellido,
  medicoNombre: usersTable.nombre,
};

// Iniciar videollamada (médico o admin)
router.post("/videollamadas", requireRol("medico", "admin"), async (req, res) => {
  const parsed = CrearVideollamadaBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Datos inválidos" });
    return;
  }
  const user = res.locals.user as typeof usersTable.$inferSelect;
  const { pacienteId } = parsed.data;

  const [paciente] = await db
    .select()
    .from(pacientesTable)
    .where(eq(pacientesTable.id, pacienteId))
    .limit(1);
  if (!paciente) {
    res.status(404).json({ error: "Paciente no encontrado" });
    return;
  }

  // Finalizar cualquier llamada activa previa del mismo médico
  await db
    .update(videollamadasTable)
    .set({ estado: "finalizada", finalizadaEn: new Date() })
    .where(and(eq(videollamadasTable.medicoUserId, user.id), eq(videollamadasTable.estado, "activa")));

  const sala = `ConectarDx-${randomUUID()}`;
  const [creada] = await db
    .insert(videollamadasTable)
    .values({ pacienteId, medicoUserId: user.id, sala })
    .returning();

  req.log.info({ videollamadaId: creada.id, pacienteId }, "videollamada iniciada");
  res.status(201).json(
    serializar({
      vc: creada,
      pacienteNombre: paciente.nombre,
      pacienteApellido: paciente.apellido,
      medicoNombre: user.nombre,
    }),
  );
});

// Videollamada activa del médico logueado
router.get("/videollamadas/activa", requireRol("medico", "admin"), async (_req, res) => {
  const user = res.locals.user as typeof usersTable.$inferSelect;
  const [fila] = await db
    .select(seleccionConNombres)
    .from(videollamadasTable)
    .innerJoin(pacientesTable, eq(videollamadasTable.pacienteId, pacientesTable.id))
    .innerJoin(usersTable, eq(videollamadasTable.medicoUserId, usersTable.id))
    .where(and(eq(videollamadasTable.medicoUserId, user.id), eq(videollamadasTable.estado, "activa")))
    .orderBy(desc(videollamadasTable.id))
    .limit(1);
  res.json(fila ? { videollamada: serializar(fila) } : {});
});

// Videollamada activa para el paciente logueado
router.get("/videollamadas/paciente", async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user || user.activo !== "true") {
    res.status(401).json({ error: "No autenticado" });
    return;
  }
  const pacienteIdUsuario = user.pacienteId != null ? Number(user.pacienteId) : null;
  if (user.rol !== "paciente" || pacienteIdUsuario == null || !Number.isInteger(pacienteIdUsuario)) {
    res.status(403).json({ error: "Solo pacientes" });
    return;
  }
  const [fila] = await db
    .select(seleccionConNombres)
    .from(videollamadasTable)
    .innerJoin(pacientesTable, eq(videollamadasTable.pacienteId, pacientesTable.id))
    .innerJoin(usersTable, eq(videollamadasTable.medicoUserId, usersTable.id))
    .where(and(eq(videollamadasTable.pacienteId, pacienteIdUsuario), eq(videollamadasTable.estado, "activa")))
    .orderBy(desc(videollamadasTable.id))
    .limit(1);
  res.json(fila ? { videollamada: serializar(fila) } : {});
});

// Finalizar (solo el médico que la creó o admin)
router.post("/videollamadas/:id/finalizar", requireRol("medico", "admin"), async (req, res) => {
  const user = res.locals.user as typeof usersTable.$inferSelect;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Id inválido" });
    return;
  }
  const [vc] = await db
    .select()
    .from(videollamadasTable)
    .where(eq(videollamadasTable.id, id))
    .limit(1);
  if (!vc) {
    res.status(404).json({ error: "Videollamada no encontrada" });
    return;
  }
  if (user.rol !== "admin" && vc.medicoUserId !== user.id) {
    res.status(403).json({ error: "No autorizado" });
    return;
  }
  const [actualizada] = await db
    .update(videollamadasTable)
    .set({ estado: "finalizada", finalizadaEn: new Date() })
    .where(eq(videollamadasTable.id, id))
    .returning();

  const [paciente] = await db
    .select()
    .from(pacientesTable)
    .where(eq(pacientesTable.id, actualizada.pacienteId))
    .limit(1);

  req.log.info({ videollamadaId: id }, "videollamada finalizada");
  res.json(
    serializar({
      vc: actualizada,
      pacienteNombre: paciente?.nombre ?? null,
      pacienteApellido: paciente?.apellido ?? null,
      medicoNombre: user.nombre,
    }),
  );
});

export default router;
