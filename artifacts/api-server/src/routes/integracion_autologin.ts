import { Router, type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, pacientesTable, usersTable } from "@workspace/db";
import { consumirTokenIngreso } from "../lib/autologin-paciente";

// ── Verificación de autologin para la app del paciente (Mi Diagnosticar) ───
// El portal del paciente es un proyecto APARTE: cuando el paciente llega con
// el link mágico del WhatsApp, el portal NO confía en el link solo — llama
// acá de servidor a servidor con la clave compartida (la misma del push de
// certificados) y recibe DNI + teléfono para crear su sesión sin login.
// El token se consume en esta llamada (un solo uso).

const router = Router();

function claveValida(recibida: string | undefined): boolean {
  const esperada = process.env.APP_PACIENTE_PUSH_TOKEN?.trim();
  if (!esperada || !recibida) return false;
  const a = Buffer.from(recibida);
  const b = Buffer.from(esperada);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function requireTokenCompartido(req: Request, res: Response, next: NextFunction): void {
  if (!process.env.APP_PACIENTE_PUSH_TOKEN?.trim()) {
    res.status(503).json({ error: "Integración con la app del paciente no configurada" });
    return;
  }
  const auth = req.header("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : undefined;
  if (!claveValida(token)) {
    req.log.warn("integracion-autologin: token compartido inválido o faltante");
    res.status(401).json({ error: "Clave compartida inválida o faltante" });
    return;
  }
  next();
}

router.use("/integraciones/app-paciente/autologin", requireTokenCompartido);

router.post("/integraciones/app-paciente/autologin", async (req, res): Promise<void> => {
  const { codigo } = (req.body ?? {}) as { codigo?: unknown };
  if (typeof codigo !== "string" || codigo.length < 20 || codigo.length > 200) {
    res.status(400).json({ ok: false, motivo: "invalido", error: "Código de ingreso inválido" });
    return;
  }
  const resultado = await consumirTokenIngreso(codigo);
  if (!resultado.ok) {
    res.status(410).json({ ok: false, motivo: resultado.motivo });
    return;
  }
  // Si el token quedó atado a un usuario de Conectar (links viejos), ese
  // usuario debe seguir activo. Los links nuevos van solo con la ficha.
  if (resultado.usuarioId !== null) {
    const [usuario] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, resultado.usuarioId))
      .limit(1);
    if (!usuario || usuario.activo !== "true" || usuario.rol !== "paciente") {
      res.status(410).json({ ok: false, motivo: "invalido" });
      return;
    }
  }
  const [paciente] = await db
    .select({
      id: pacientesTable.id,
      dni: pacientesTable.dni,
      telefono: pacientesTable.telefono,
      nombre: pacientesTable.nombre,
      apellido: pacientesTable.apellido,
    })
    .from(pacientesTable)
    .where(and(eq(pacientesTable.id, resultado.pacienteId), eq(pacientesTable.activo, true)))
    .limit(1);
  if (!paciente || !paciente.dni) {
    res.status(410).json({ ok: false, motivo: "invalido" });
    return;
  }
  req.log.info({ pacienteId: paciente.id }, "integracion-autologin: código verificado por la app del paciente");
  res.json({
    ok: true,
    dni: paciente.dni,
    telefono: paciente.telefono ?? null,
    nombre: paciente.nombre,
    apellido: paciente.apellido,
  });
});

export default router;
