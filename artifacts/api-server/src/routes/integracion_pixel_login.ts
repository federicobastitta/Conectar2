/**
 * Integración servidor a servidor para que Pixel (PACS) valide credenciales
 * de usuarios contra Conectar. Así el personal usa en Pixel el MISMO usuario
 * y contraseña que en Conectar, sin cuentas duplicadas.
 *
 * Autenticación: header x-api-key comparado en tiempo constante contra
 * PACS_API_TOKEN (la clave compartida con Pixel).
 *
 * POST /integraciones/pixel/validar-credenciales
 *   { usuario, password } → 200 { valido: true, usuario: {...} }
 *   usuario acepta el mail completo o la parte antes de la @ (si es única).
 *   Credenciales inválidas → 401 { valido: false }.
 *   La contraseña nunca se loguea ni se devuelve.
 */

import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  usersTable,
  salasLlamadoTable,
  turnosTable,
  turnerasTable,
  profesionalesTable,
  auditLogTable,
  consultoriosTable,
} from "@workspace/db";
import { and, inArray } from "drizzle-orm";
import { hashPassword } from "./auth";

const router: IRouter = Router();

// Claves aceptadas: la nueva CONECTAR_PIXEL_API_KEY (solo letras/números, la
// vieja PACS_API_TOKEN tenía tildes que no viajan bien en headers HTTP y
// además viene de un secreto de cuenta que no se puede pisar desde la app).
// Se aceptan ambas para no cortar el login de Pixel mientras migran.
function clavesEsperadas(): string[] {
  return [process.env.CONECTAR_PIXEL_API_KEY, process.env.PACS_API_TOKEN]
    .map((s) => s?.trim())
    .filter((s): s is string => Boolean(s));
}

function claveValida(provista: string | undefined): boolean {
  if (!provista) return false;
  const a = Buffer.from(provista);
  return clavesEsperadas().some((esperada) => {
    const b = Buffer.from(esperada);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  if (clavesEsperadas().length === 0) {
    res.status(503).json({ error: "Integración con Pixel no configurada" });
    return;
  }
  if (!claveValida(req.header("x-api-key"))) {
    req.log.warn("integracion-pixel: x-api-key inválida o faltante");
    res.status(401).json({ error: "Clave de API inválida o faltante" });
    return;
  }
  next();
}

// Scopear SOLO a este prefijo para no filtrar el middleware a otros routers.
router.use("/integraciones/pixel", requireApiKey);

const CredencialesBody = z.object({
  usuario: z.string().trim().min(1).max(200),
  password: z.string().min(1).max(200),
});

const ROLES_STAFF = new Set(["admin", "recepcionista", "medico"]);

// ── POST /integraciones/pixel/validar-credenciales ────────────────────────
router.post("/integraciones/pixel/validar-credenciales", async (req: Request, res: Response) => {
  const parsed = CredencialesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Se esperan los campos usuario y password" });
    return;
  }
  const { usuario, password } = parsed.data;

  let candidatos;
  if (usuario.includes("@")) {
    candidatos = await db
      .select()
      .from(usersTable)
      .where(eq(sql`lower(${usersTable.email})`, usuario.toLowerCase()))
      .limit(2);
  } else {
    // Parte antes de la @: solo si identifica a un único usuario
    candidatos = await db
      .select()
      .from(usersTable)
      .where(eq(sql`lower(split_part(${usersTable.email}, '@', 1))`, usuario.toLowerCase()))
      .limit(2);
  }

  const hash = hashPassword(password);
  const user = candidatos.length === 1 ? candidatos[0] : undefined;

  if (!user || user.passwordHash !== hash || user.activo !== "true" || !ROLES_STAFF.has(user.rol)) {
    req.log.info({ resultado: "rechazado" }, "integracion-pixel: validación de credenciales fallida");
    res.status(401).json({ valido: false });
    return;
  }

  req.log.info({ userId: user.id }, "integracion-pixel: credenciales validadas");
  res.json({
    valido: true,
    usuario: {
      id: user.id,
      email: user.email,
      nombre: user.nombre,
      rol: user.rol,
      perfil: user.perfil ?? null,
    },
  });
});

// ── GET /integraciones/pixel/llamador/salas ────────────────────────────────
// Pedido de Pixel (ago 2026): lista de salas del llamador para que su UI
// muestre siempre las salas vigentes de Conectar (sin duplicar la lista).
// Misma autenticación de la integración Pixel (header x-api-key).
router.get("/integraciones/pixel/llamador/salas", async (_req: Request, res: Response) => {
  const rows = await db
    .select({ id: salasLlamadoTable.id, nombre: salasLlamadoTable.nombre })
    .from(salasLlamadoTable)
    .where(eq(salasLlamadoTable.activa, true))
    .orderBy(salasLlamadoTable.nombre);
  res.json({ salas: rows.map((s) => ({ sala_id: s.id, nombre: s.nombre })) });
});

// ── POST /integraciones/pixel/llamador/llamar ──────────────────────────────
// Camino inverso del llamador (ago 2026): en imágenes el médico llama desde
// la worklist de Pixel, y el llamado tiene que salir en las TVs de sala de
// espera de Conectar. Pixel manda el turno_id (el mismo que le enviamos en
// los avisos) y opcionalmente la sala elegida por el médico en su UI
// (sala_id de GET /llamador/salas).
//
// Reglas espejadas del llamado interno (POST /turnos/:id/llamar):
// - El turno pasa a estado "llamado" (bloquea al paciente para otros médicos).
// - Guard atómico anti-carrera: si ya está "llamado" por OTRO médico → 409.
// - Se persiste llamadoPorProfesionalId (profesional del turno o titular de
//   agenda) para que la TV resuelva la sala; si Pixel manda sala_id, se
//   actualiza la sala de llamado de ese profesional (es la misma elección
//   que hace un médico desde su pantalla en Conectar).
// - Queda auditado como llamado vía Pixel. NO se re-avisa a Pixel (evita eco).
const LLAMABLES_PIXEL = ["arribo", "en_sala", "llamado"];

// ── GET /integraciones/pixel/llamador/consultorios ─────────────────────────
// Catálogo único de consultorios (el mismo que usan los médicos en Conectar):
// Pixel arma su desplegable con esta lista y los IDs significan lo mismo en
// los dos sistemas.
router.get("/integraciones/pixel/llamador/consultorios", async (_req: Request, res: Response) => {
  const rows = await db
    .select({ id: consultoriosTable.id, nombre: consultoriosTable.nombre })
    .from(consultoriosTable)
    .where(eq(consultoriosTable.activo, true))
    .orderBy(consultoriosTable.nombre);
  res.json({ consultorios: rows.map((c) => ({ consultorio_id: c.id, nombre: c.nombre })) });
});

const LlamarBody = z.object({
  turno_id: z.number().int().positive(),
  sala_id: z.number().int().positive().optional(),
  consultorio_id: z.number().int().positive().optional(),
  // Texto opcional a mostrar en la TV en lugar del nombre de la agenda
  // (ej: "Ergometrías"). Si no viene, la TV muestra lo de siempre.
  practica: z.string().trim().min(1).max(120).optional(),
});

router.post("/integraciones/pixel/llamador/llamar", async (req: Request, res: Response) => {
  const parsed = LlamarBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Se espera turno_id (número) y opcionalmente sala_id" });
    return;
  }
  const { turno_id: turnoId, sala_id: salaId, consultorio_id: consultorioId, practica } = parsed.data;

  const [turno] = await db.select().from(turnosTable).where(eq(turnosTable.id, turnoId)).limit(1);
  if (!turno) {
    res.status(404).json({ error: "Turno no encontrado" });
    return;
  }

  // Profesional que "llama": el del turno, o el titular de la agenda.
  let profId: number | null = turno.profesionalId ?? null;
  if (profId == null && turno.turneraId != null) {
    const [t] = await db
      .select({ profesionalId: turnerasTable.profesionalId })
      .from(turnerasTable)
      .where(eq(turnerasTable.id, turno.turneraId))
      .limit(1);
    profId = t?.profesionalId ?? null;
  }

  // Sala elegida en Pixel: se refleja en la sala de llamado del profesional
  // (misma semántica que elegir la sala desde Conectar). Solo salas activas.
  if (salaId != null && profId != null) {
    const [sala] = await db
      .select({ id: salasLlamadoTable.id })
      .from(salasLlamadoTable)
      .where(and(eq(salasLlamadoTable.id, salaId), eq(salasLlamadoTable.activa, true)))
      .limit(1);
    if (!sala) {
      res.status(400).json({ error: "sala_id no corresponde a una sala activa" });
      return;
    }
    await db
      .update(profesionalesTable)
      .set({ salaLlamadoId: salaId })
      .where(eq(profesionalesTable.id, profId));
  }

  // Consultorio elegido en Pixel: mismo catálogo que el desplegable del
  // médico en Conectar (la TV muestra ese nombre como destino del llamado).
  if (consultorioId != null && profId != null) {
    const [cons] = await db
      .select({ id: consultoriosTable.id })
      .from(consultoriosTable)
      .where(and(eq(consultoriosTable.id, consultorioId), eq(consultoriosTable.activo, true)))
      .limit(1);
    if (!cons) {
      res.status(400).json({ error: "consultorio_id no corresponde a un consultorio activo" });
      return;
    }
    await db
      .update(profesionalesTable)
      .set({ consultorioId })
      .where(eq(profesionalesTable.id, profId));
  }

  // Aviso amable antes del update atómico (paridad con el llamado interno).
  if (turno.estado === "llamado" && turno.llamadoPorProfesionalId != null && turno.llamadoPorProfesionalId !== profId) {
    res.status(409).json({ error: "El paciente ya está en consulta con otro médico", codigo: "paciente_en_consulta" });
    return;
  }

  const updated = await db.transaction(async (tx) => {
    const [u] = await tx
      .update(turnosTable)
      .set({ estado: "llamado", llamadoEn: new Date(), llamadoPorProfesionalId: profId, llamadoPractica: practica ?? null })
      .where(
        and(
          eq(turnosTable.id, turnoId),
          inArray(turnosTable.estado, LLAMABLES_PIXEL),
          sql`(${turnosTable.estado} <> 'llamado' OR ${turnosTable.llamadoPorProfesionalId} IS NOT DISTINCT FROM ${profId})`,
        ),
      )
      .returning();
    if (!u) return undefined;
    await tx.insert(auditLogTable).values({
      usuarioId: null,
      usuarioEmail: "integracion-pixel",
      rol: "integracion",
      accion: "llamar",
      entidad: "turno",
      entidadId: turnoId,
      pacienteId: turno.pacienteId,
      detalle: {
        estadoAnterior: turno.estado,
        estadoNuevo: "llamado",
        origen: "pixel",
        salaId: salaId ?? null,
        consultorioId: consultorioId ?? null,
        practica: practica ?? null,
        llamadoPorProfesionalId: profId,
      },
    });
    return u;
  });

  if (!updated) {
    // Releer: si otro médico ganó la carrera entre el pre-check y el UPDATE,
    // corresponde 409 (paciente en consulta), no 422.
    const [actual] = await db
      .select({ estado: turnosTable.estado, llamadoPor: turnosTable.llamadoPorProfesionalId })
      .from(turnosTable)
      .where(eq(turnosTable.id, turnoId))
      .limit(1);
    if (actual?.estado === "llamado" && actual.llamadoPor != null && actual.llamadoPor !== profId) {
      res.status(409).json({ error: "El paciente ya está en consulta con otro médico", codigo: "paciente_en_consulta" });
      return;
    }
    res.status(422).json({
      error: `El turno no está en un estado llamable (estado actual: ${actual?.estado ?? turno.estado})`,
      estadosPermitidos: LLAMABLES_PIXEL,
    });
    return;
  }

  req.log.info({ turnoId, profId, salaId: salaId ?? null }, "integracion-pixel: llamado desde Pixel");
  res.json({ ok: true, turno_id: turnoId, estado: "llamado" });
});

export default router;
