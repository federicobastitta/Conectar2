import { Router, type IRouter, type Request, type Response } from "express";
import { hoyArgentina, horaArgentina } from "../lib/tiempo";
import { crearEstimadorEspera } from "../lib/espera";
import { eq, and, or, ilike, like, lt, inArray, sql, type SQL } from "drizzle-orm";
import {
  db,
  turnosTable,
  pacientesTable,
  turnerasTable,
  sedesTable,
  profesionalesTable,
  consultoriosTable,
  salasLlamadoTable,
  usersTable,
  auditLogTable,
  documentacionRecepcionTable,
  klinicosTrabajos,
  configSistemaTable,
  encountersTable,
} from "@workspace/db";
import { ReprogramarTurnoBody, GuardarIngresoConsultaBody, CanjearCodigoTvBody } from "@workspace/api-zod";
import { getUserFromRequest } from "./auth";
import { turneraIdsDelProfesional } from "../lib/alcance-medico";
import { registrarEventoTurnoRobot } from "../lib/robot-turnos-eventos";
import { codigoFacturacionPractica } from "../lib/klinicos-codigo-facturacion";
import { verificarCupoObraSocial, lockCupoObraSocial } from "../lib/cupos-obra-social";
import { notificacionesSalientesTable } from "@workspace/db";
import {
  enviarWhatsappWhaticket,
  renderPlantilla,
  PLANTILLA_REPROGRAMACION_DEFAULT,
} from "../integraciones/whaticket";
import { encolarTrabajoKlinicos, resolverSectorServicio, esSectorConsultorio, actualizarTokenTrabajosDeTurno, coberturaValidaEnKlinicos } from "../integraciones/klinicos-cola";
import { autorizarConsultaConToken, procesarTrabajo, ejecutarTrabajoAprobado, releerBonoConsulta } from "../integraciones/klinicos-worker";
import { notificarEventoVideollamadaPorTurno, avanzarFilaGuardia } from "../integraciones/app-paciente-videollamadas";
import { encolarAvisoTurno } from "../integraciones/app-paciente-turnos";
import { klinicosHabilitado, klinicosDryRun } from "../integraciones/klinicos-robot";
import { avisarRecepcionPacs } from "../integraciones/pacs-recepcion";
import { avisarLlamadoPixel } from "../integraciones/pixel-llamador";
import { obtenerSecretoSupervisor } from "./recepcion";
import { verificarTotpConPaso } from "../lib/totp";
import {
  consultasProcessHabilitadas,
  procesarConsultaConRobot,
  consultarProcesoConsulta,
  reintentarProcesoConsulta,
  saludConsultasRobot,
  armarScheduledAt,
  type ConsultaProcesoEntrada,
  type ResultadoProceso,
} from "../integraciones/robot-consultas";
import { randomUUID, randomInt } from "node:crypto";
import {
  enmascararToken,
  validarTokenConRobot,
  consultarSolicitudToken,
  normalizarCie10,
  type EstadoValidacionToken,
} from "../integraciones/robot-cliente";
import { klinicosPracticas, turnoPracticasTable } from "@workspace/db";
import {
  practicasDeTurno,
  guardarPracticasDeTurno,
  filtrarPracticasValidas,
} from "../lib/turno-practicas";
import {
  robotTokenValidationProvider,
  internoTokenValidationProvider,
  validacionInternaDisponible,
  validacionTokenHabilitada,
  _resetSaludKlinicosCache,
  mapearEstadoToken,
  mapearRobotSyncStatus,
} from "../integraciones/token-validation-provider";
import {
  klinicosTokenValidaciones,
  consultasTokenTable,
  klinicosReglasCie10,
  klinicosReglasPractica,
} from "@workspace/db";
import {
  ValidarTokenTurnoBody,
  ProbarRobotKlinicosBody,
  RegistrarPrestacionCargadaPruebaBody,
  ProcesarConsultaRobotPruebaBody,
  EjecutarPruebaRealRobotBody,
  ValidarAtencionTurnoBody,
} from "@workspace/api-zod";
import { klinicosConsultasProcesosTable } from "@workspace/db";
import { especialidadesTable, type TokenEstado, type RobotSyncEstado } from "@workspace/db";
import { urlVideollamadaTurno } from "../lib/videollamada-turno";

const router: IRouter = Router();

type SalaUser = typeof usersTable.$inferSelect;
// Actor de una validación de token: usuario staff o el canal público de la
// app del paciente (id null en la auditoría).
export type ActorToken = Pick<SalaUser, "email" | "rol" | "nombre"> & { id: number | null };

const getUser = getUserFromRequest;

const ROLES_OPERACION = ["admin", "recepcionista"];
const ROLES_LECTURA = ["admin", "recepcionista", "medico"];

async function registrarAuditoria(
  user: ActorToken,
  accion: string,
  turnoId: number,
  pacienteId: number | null,
  detalle: unknown,
  executor: Pick<typeof db, "insert"> = db,
): Promise<void> {
  await executor.insert(auditLogTable).values({
    usuarioId: user.id,
    usuarioEmail: user.email,
    rol: user.rol,
    accion,
    entidad: "turno",
    entidadId: turnoId,
    pacienteId,
    detalle,
  });
}

function hoy(): string {
  return hoyArgentina();
}

// Transiciones válidas de la sala de espera, integradas con la máquina de episodios
const ADMISIBLES = ["pendiente", "reservado", "confirmado", "publicado", "ausente"];
const LLAMABLES = ["arribo", "en_sala"];
const ATENDIBLES = ["llamado", "arribo", "en_sala"];
const AUSENTABLES = ["pendiente", "reservado", "confirmado", "arribo", "en_sala", "llamado"];

async function transicionar(
  req: Request,
  res: Response,
  opts: {
    estadosPermitidos: string[];
    nuevoEstado: string;
    accion: string;
    timestampField?: "admitidoEn" | "llamadoEn" | "atendidoEn";
    detalleExtra?: (turno: typeof turnosTable.$inferSelect) => Promise<Record<string, unknown>>;
    updateExtra?: (user: { id: number; nombre: string; email: string; rol: string; profesionalId: string | null }) => Partial<typeof turnosTable.$inferInsert>;
    /** Permite al médico operar, pero solo sobre turnos de sus propias agendas. */
    permitirMedico?: boolean;
    /** No cambia el estado del turno: solo estampa el timestamp y audita (ej. llamar). */
    mantenerEstado?: boolean;
    /** Condición SQL adicional del UPDATE atómico (ej. bloqueo por otro médico). */
    condicionExtra?: SQL;
  },
): Promise<void> {
  const user = await getUser(req);
  if (!user) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }
  const esMedicoPermitido = opts.permitirMedico && user.rol === "medico" && user.profesionalId != null;
  if (!ROLES_OPERACION.includes(user.rol) && !esMedicoPermitido) {
    res.status(403).json({ error: "Sin permisos para operar la sala de espera" });
    return;
  }

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "ID inválido" });
    return;
  }

  const [turno] = await db.select().from(turnosTable).where(eq(turnosTable.id, id)).limit(1);
  if (!turno) {
    res.status(404).json({ error: "Turno no encontrado" });
    return;
  }

  // Médico: solo puede operar turnos dentro de su alcance — asignados a él,
  // de sus agendas (propias/grupales) o de la bolsa de guardia (los turnos de
  // demanda espontánea entran sin médico asignado).
  if (esMedicoPermitido && !ROLES_OPERACION.includes(user.rol)) {
    const profId = Number(user.profesionalId);
    const asignadoAEl = turno.profesionalId != null && turno.profesionalId === profId;
    let permitido = asignadoAEl;
    if (!permitido && turno.turneraId != null) {
      const ids = await turneraIdsDelProfesional(profId);
      permitido = ids.includes(turno.turneraId);
      if (!permitido) {
        const [tg] = await db
          .select({ esGuardia: turnerasTable.esGuardia })
          .from(turnerasTable)
          .where(eq(turnerasTable.id, turno.turneraId))
          .limit(1);
        permitido = Boolean(tg?.esGuardia);
      }
    }
    if (!permitido) {
      res.status(403).json({ error: "El turno no pertenece a tus agendas" });
      return;
    }
  }

  const updateData: Partial<typeof turnosTable.$inferInsert> = opts.mantenerEstado
    ? {}
    : { estado: opts.nuevoEstado };
  if (opts.timestampField) updateData[opts.timestampField] = new Date();
  if (opts.updateExtra) Object.assign(updateData, opts.updateExtra(user));

  // Transición atómica: la condición de estado va en el UPDATE para evitar
  // que dos operadores concurrentes pisen la misma transición. El cambio de
  // estado y su auditoría van en UNA transacción: si la auditoría falla, la
  // transición se revierte (auditoría obligatoria).
  const updated = await db.transaction(async (tx) => {
    const [u] = await tx
      .update(turnosTable)
      .set(updateData)
      .where(
        and(
          eq(turnosTable.id, id),
          inArray(turnosTable.estado, opts.estadosPermitidos),
          ...(opts.condicionExtra ? [opts.condicionExtra] : []),
        ),
      )
      .returning();
    if (!u) return undefined;

    const detalleExtra = opts.detalleExtra ? await opts.detalleExtra(turno) : {};
    await registrarAuditoria(
      user,
      opts.accion,
      id,
      turno.pacienteId,
      { estadoAnterior: turno.estado, estadoNuevo: opts.mantenerEstado ? turno.estado : opts.nuevoEstado, ...detalleExtra },
      tx,
    );
    return u;
  });

  if (!updated) {
    const [actual] = await db
      .select({ estado: turnosTable.estado })
      .from(turnosTable)
      .where(eq(turnosTable.id, id))
      .limit(1);
    res.status(422).json({
      error: `Transición no permitida: ${actual?.estado ?? turno.estado} → ${opts.nuevoEstado}`,
      estadosPermitidos: opts.estadosPermitidos,
    });
    return;
  }

  req.log.info(
    { turnoId: id, estadoAnterior: turno.estado, estadoNuevo: opts.nuevoEstado, usuario: user.email },
    `sala-espera: ${opts.accion}`,
  );

  // Al recepcionar (admitir), encolar el trabajo del robot Klinicos.
  // Fire-and-forget: nunca debe frenar ni romper la recepción.
  if (opts.accion === "admitir") {
    // Regla de facturación (02/08/2026): la consulta se genera recién al
    // Validar Token; acá solo origen "auto" (frenado por el kill-switch).
    void encolarTrabajoKlinicos(id, user.id ?? null, "auto");
    // Aviso de recepción al PACS: las órdenes del paciente pasan a
    // "recepcionado" en la lista de trabajo. Fire-and-forget.
    void avisarRecepcionPacs(turno.pacienteId, req.log);
  }

  // Aviso de llamado a Pixel (llamador): fire-and-forget, nunca frena el llamado.
  if (opts.accion === "llamar") {
    void avisarLlamadoPixel(id, req.log);
    // Guardia virtual: si el turno es de una videollamada, avisar "tu turno"
    // al portal con el link de Jitsi (fire-and-forget).
    void notificarEventoVideollamadaPorTurno(id, "tu_turno");
  }
  if (opts.accion === "devolver_sala") {
    // El médico devolvió al paciente: vuelve a figurar en cola en el portal.
    void notificarEventoVideollamadaPorTurno(id, "en_cola");
  }
  if (opts.accion === "no_presentado") {
    void notificarEventoVideollamadaPorTurno(id, "cancelada", "No se presentó a la videollamada");
  }
  // Guardia: si el turno salió/entró de la fila, avisar el avance a los que esperan.
  if (["llamar", "no_presentado", "devolver_sala"].includes(opts.accion)) {
    void avanzarFilaGuardia(id);
  }

  res.json(updated);
}

// Token validado ⇒ el paciente queda recepcionado automáticamente (pedido
// jul 2026). Solo aplica a turnos del día en estados admisibles; la
// transición es atómica y queda auditada como recepción por token validado.
// Nunca debe romper el flujo del token: los errores solo se loguean.
async function recepcionarTrasTokenValidado(
  user: ActorToken,
  turnoId: number,
  log: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void },
): Promise<boolean> {
  try {
    const [turno] = await db.select().from(turnosTable).where(eq(turnosTable.id, turnoId)).limit(1);
    if (!turno) return false;
    if (turno.fecha !== hoy()) return false; // solo turnos de hoy
    if (!ADMISIBLES.includes(turno.estado)) return false; // ya recepcionado o fuera de circuito
    const admitido = await db.transaction(async (tx) => {
      const [u] = await tx
        .update(turnosTable)
        .set({
          estado: "arribo",
          admitidoEn: new Date(),
          admitidoPor: user.nombre || user.email,
        })
        .where(and(eq(turnosTable.id, turnoId), inArray(turnosTable.estado, ADMISIBLES)))
        .returning();
      if (!u) return undefined;
      await registrarAuditoria(
        user,
        "admitir",
        turnoId,
        turno.pacienteId,
        { estadoAnterior: turno.estado, estadoNuevo: "arribo", motivo: "token_validado" },
        tx,
      );
      return u;
    });
    if (!admitido) return false;
    log.info({ turnoId, estadoAnterior: turno.estado }, "sala-espera: recepcionado automático por token validado");
    // Mismos efectos que la recepción manual (fire-and-forget). La consulta
    // real la crea el circuito de Validar Token (origen "manual").
    void encolarTrabajoKlinicos(turnoId, user.id ?? null, "auto");
    void avisarRecepcionPacs(turno.pacienteId, log as Parameters<typeof avisarRecepcionPacs>[1]);
    return true;
  } catch (err) {
    log.warn({ turnoId, err: String(err) }, "sala-espera: no se pudo recepcionar automático tras token validado");
    return false;
  }
}

// ── POST /turnos/:id/admitir ─────────────────────────────────────────────
// Auditoría de recepción: incluye snapshot de documentación validada, sede y
// observaciones (requisito del flujo Recepcionar Paciente).
router.post("/turnos/:id/admitir", async (req, res) => {
  // Recepcionar SIN token validado requiere el código de supervisor
  // (TOTP de app authenticator), si el admin lo configuró. Aplica solo a
  // consultas: los turnos de práctica generan su orden automáticamente.
  const turnoId = Number(req.params.id);
  // Tilde "token por Klinicos": el token de la orden se cargó directamente en
  // Klinicos (acá no queda registrado). El paciente pasa sin código de
  // supervisor, pero queda pintado en amarillo bien clarito como constancia.
  const tokenPorKlinicos =
    typeof req.body === "object" && req.body !== null && req.body.tokenPorKlinicos === true;
  let sinTokenAutorizado = false;
  // Consulta recepcionada SIN token validado → marca naranja, haya o no
  // código de supervisor configurado. Solo gerencia (admin) la quita.
  let sinTokenValidado = false;
  if (Number.isInteger(turnoId) && turnoId > 0 && !tokenPorKlinicos) {
    const ingreso = await cargarIngresoConsulta(turnoId);
    if (ingreso && ingreso.esConsulta && !ingreso.token) {
      sinTokenValidado = true;
      const secreto = await obtenerSecretoSupervisor();
      if (secreto) {
        const codigo =
          typeof req.body === "object" && req.body !== null && typeof req.body.codigoSupervisor === "string"
            ? req.body.codigoSupervisor.trim()
            : "";
        if (!codigo) {
          res.status(403).json({
            error: "Para recepcionar sin token validado hace falta el código del supervisor",
            codigo: "codigo_supervisor_requerido",
          });
          return;
        }
        const paso = verificarTotpConPaso(secreto, codigo);
        if (paso === null) {
          req.log.warn({ turnoId }, "código de supervisor inválido al recepcionar sin token");
          res.status(403).json({
            error: "Código de supervisor incorrecto o vencido",
            codigo: "codigo_supervisor_invalido",
          });
          return;
        }
        // Anti-replay: cada código (time-step) se acepta una sola vez.
        const reclamo = await db.execute(sql`
          INSERT INTO config_sistema (clave, valor)
          VALUES ('supervisor_totp_ultimo_paso', ${String(paso)})
          ON CONFLICT (clave) DO UPDATE
            SET valor = EXCLUDED.valor, actualizado_en = now()
            WHERE config_sistema.valor::bigint < EXCLUDED.valor::bigint
          RETURNING clave
        `);
        if (reclamo.rows.length === 0) {
          req.log.warn({ turnoId }, "código de supervisor reutilizado al recepcionar sin token");
          res.status(403).json({
            error: "Ese código ya fue usado, pedí uno nuevo al supervisor",
            codigo: "codigo_supervisor_invalido",
          });
          return;
        }
        sinTokenAutorizado = true;
      }
    }
  }
  return transicionar(req, res, {
    estadosPermitidos: ADMISIBLES,
    nuevoEstado: "arribo",
    accion: "admitir",
    timestampField: "admitidoEn",
    // Trazabilidad: queda registrado quién recepcionó. Si fue sin token
    // validado (autorizado por supervisor), el turno queda marcado en
    // naranja hasta que gerencia lo descolorée; si el token fue por
    // Klinicos, queda en amarillo clarito.
    updateExtra: (user) => ({
      admitidoPor: user.nombre || user.email,
      ...(sinTokenValidado
        ? { marcaColor: "naranja" }
        : tokenPorKlinicos
          ? { marcaColor: "amarillo" }
          : {}),
    }),
    detalleExtra: async (turno) => {
      const [docs, [turnera]] = await Promise.all([
        db
          .select({
            tipo: documentacionRecepcionTable.tipo,
            estado: documentacionRecepcionTable.estado,
          })
          .from(documentacionRecepcionTable)
          .where(eq(documentacionRecepcionTable.pacienteId, turno.pacienteId)),
        db
          .select({ sedeId: turnerasTable.sedeId })
          .from(turnerasTable)
          .where(eq(turnerasTable.id, turno.turneraId))
          .limit(1),
      ]);
      const observaciones =
        typeof req.body === "object" && req.body !== null && typeof req.body.observaciones === "string"
          ? req.body.observaciones
          : null;
      return {
        sedeId: turnera?.sedeId ?? null,
        documentacionValidada: docs,
        observaciones,
        ...(sinTokenAutorizado ? { sinTokenAutorizadoPorSupervisor: true } : {}),
        ...(sinTokenValidado ? { sinTokenValidado: true } : {}),
        ...(tokenPorKlinicos ? { tokenPorKlinicos: true } : {}),
      };
    },
  });
});

// ── POST /turnos/:id/descolorear ─────────────────────────────────────────
// Solo gerencia (admin) puede quitar la marca de color de un turno (ej: el
// naranja de una recepción sin token validado).
router.post("/turnos/:id/descolorear", async (req, res) => {
  const user = await getUser(req);
  if (!user) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }
  if (user.rol !== "admin") {
    res.status(403).json({ error: "Solo gerencia puede descolorear un paciente" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "ID inválido" });
    return;
  }
  const [turno] = await db.select().from(turnosTable).where(eq(turnosTable.id, id)).limit(1);
  if (!turno) {
    res.status(404).json({ error: "Turno no encontrado" });
    return;
  }
  if (!turno.marcaColor) {
    res.status(422).json({ error: "El turno no tiene marca de color" });
    return;
  }
  const updated = await db.transaction(async (tx) => {
    const [u] = await tx
      .update(turnosTable)
      .set({ marcaColor: null })
      .where(eq(turnosTable.id, id))
      .returning();
    await registrarAuditoria(user, "descolorear", id, turno.pacienteId, { marcaAnterior: turno.marcaColor }, tx);
    return u;
  });
  req.log.info({ turnoId: id, usuario: user.email }, "sala-espera: descolorear");
  res.json(updated);
});

// ── Ingreso ambulatorio estilo Klinicos (consultas) ──────────────────────
// Datos que exige Klinicos al recepcionar una consulta: sector (fijo
// CONSULTORIO), especialidad, profesional y motivo. Después de guardar,
// recepción carga el token que valida la orden.
async function cargarIngresoConsulta(turnoId: number) {
  const [row] = await db
    .select({
      turno: turnosTable,
      especialidadNombre: especialidadesTable.nombre,
      turneraNombre: turnerasTable.nombre,
      turneraKlinicosSector: turnerasTable.klinicosSector,
      turneraKlinicosEspecialidad: turnerasTable.klinicosEspecialidad,
      turneraKlinicosProfesional: turnerasTable.klinicosProfesional,
      turneraKlinicosMotivo: turnerasTable.klinicosMotivo,
      profesional: profesionalesTable,
      practicaNombre: klinicosPracticas.nombre,
      practicaCodigos: klinicosPracticas.codigos,
      nroBono: consultasTokenTable.authorizationNumber,
      tokenEstado: consultasTokenTable.tokenStatus,
    })
    .from(turnosTable)
    .innerJoin(turnerasTable, eq(turnosTable.turneraId, turnerasTable.id))
    .leftJoin(especialidadesTable, eq(turnerasTable.especialidadId, especialidadesTable.id))
    .leftJoin(profesionalesTable, eq(turnerasTable.profesionalId, profesionalesTable.id))
    .leftJoin(klinicosPracticas, eq(turnosTable.klinicosPracticaId, klinicosPracticas.id))
    .leftJoin(consultasTokenTable, eq(consultasTokenTable.consultationId, turnosTable.id))
    .where(eq(turnosTable.id, turnoId))
    .limit(1);
  if (!row) return null;

  const especialidadDefault =
    row.turneraKlinicosEspecialidad ?? row.especialidadNombre ?? row.turneraNombre;
  const sector =
    row.turneraKlinicosSector ?? (await resolverSectorServicio(especialidadDefault));
  const profesionalDefault =
    row.turneraKlinicosProfesional ??
    row.profesional?.klinicosUsuario ??
    (row.profesional
      ? [row.profesional.apellido, row.profesional.nombre].filter(Boolean).join(" ")
      : null);

  return {
    turnoId,
    sector,
    esConsulta: esSectorConsultorio(sector),
    especialidad: row.turno.klinicosEspecialidad ?? especialidadDefault,
    profesional: row.turno.klinicosProfesional ?? profesionalDefault,
    motivo: row.turno.motivoConsulta ?? row.turneraKlinicosMotivo ?? null,
    token: row.turno.klinicosToken ?? null,
    nroBono: row.nroBono ?? null,
    // Única fuente de verdad para el cartel del frontend: el estado
    // PERSISTIDO de la validación. "Token guardado" NO implica autorizado.
    tokenEstado: row.tokenEstado ?? null,
    guardado: row.turno.motivoConsulta != null && row.turno.motivoConsulta.trim() !== "",
    practicaId: row.turno.klinicosPracticaId ?? null,
    practicaNombre: row.practicaNombre ?? null,
    practicaCodigos: row.practicaCodigos ?? null,
    // Todos los estudios del turno (turno_practicas), no solo el principal
    practicas: await practicasDeTurno(turnoId),
  };
}

router.get("/turnos/:id/ingreso-consulta", async (req, res) => {
  const user = await getUser(req);
  if (!user) return void res.status(401).json({ error: "No autenticado" });
  if (!ROLES_LECTURA.includes(user.rol))
    return void res.status(403).json({ error: "Sin permisos" });
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0)
    return void res.status(400).json({ error: "ID inválido" });

  const ingreso = await cargarIngresoConsulta(id);
  if (!ingreso) return void res.status(404).json({ error: "Turno no encontrado" });
  res.json(ingreso);
});

router.post("/turnos/:id/ingreso-consulta", async (req, res) => {
  const user = await getUser(req);
  if (!user) return void res.status(401).json({ error: "No autenticado" });
  if (!ROLES_OPERACION.includes(user.rol))
    return void res.status(403).json({ error: "Sin permisos" });
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0)
    return void res.status(400).json({ error: "ID inválido" });

  const parsed = GuardarIngresoConsultaBody.safeParse(req.body);
  if (!parsed.success)
    return void res.status(400).json({ error: "Datos inválidos", detalles: parsed.error.issues });
  const body = parsed.data;

  // Con la validación en vivo habilitada, el token NO se guarda por acá:
  // se valida y guarda vía POST /turnos/:id/validar-token (Robot externo).
  // Con el flag apagado (etapa de preparación) se mantiene el flujo actual:
  // el token se guarda como dato, sin validar contra KLINICOS.
  if ((validacionInternaDisponible() || validacionTokenHabilitada()) && body.token !== undefined && body.token.trim() !== "")
    return void res
      .status(400)
      .json({ error: "El token se valida con el endpoint validar-token, no se guarda directo" });

  // Varios estudios: el conjunto completo reemplaza al existente en
  // turno_practicas (lista vacía = quitar todos). Tiene prioridad sobre
  // el campo singular legado practicaId.
  const pidioPracticaIds = Array.isArray(body.practicaIds);
  let practicaIdsValidas: number[] | null = null;
  let codigosElegidos: string[] | null = null;
  if (pidioPracticaIds) {
    practicaIdsValidas = await filtrarPracticasValidas(body.practicaIds as number[]);
    if ((body.practicaIds as number[]).length > 0 && practicaIdsValidas.length === 0)
      return void res
        .status(400)
        .json({ error: "Ninguno de los estudios elegidos existe en el catálogo" });
    if (practicaIdsValidas.length > 0) {
      const filasCod = await db
        .select({ id: klinicosPracticas.id, codigos: klinicosPracticas.codigos })
        .from(klinicosPracticas)
        .where(inArray(klinicosPracticas.id, practicaIdsValidas));
      const codigosPorId = new Map(filasCod.map((f) => [f.id, f.codigos ?? []]));
      codigosElegidos = practicaIdsValidas.flatMap((pid) => codigosPorId.get(pid) ?? []);
    }
  }

  // Práctica del nomenclador: validar que exista y esté activa antes de asociarla
  let practicaElegida: { codigos: string[] } | null = null;
  if (!pidioPracticaIds && body.practicaId !== undefined && body.practicaId !== null) {
    const [practica] = await db
      .select({ codigos: klinicosPracticas.codigos })
      .from(klinicosPracticas)
      .where(and(eq(klinicosPracticas.id, body.practicaId), eq(klinicosPracticas.activo, true)))
      .limit(1);
    if (!practica)
      return void res.status(400).json({ error: "Práctica no encontrada o inactiva" });
    practicaElegida = practica;
  }

  const updateData: Partial<typeof turnosTable.$inferInsert> = {};
  if (body.especialidad !== undefined) updateData.klinicosEspecialidad = body.especialidad.trim();
  if (body.profesional !== undefined) updateData.klinicosProfesional = body.profesional.trim() || null;
  if (body.motivo !== undefined) updateData.motivoConsulta = body.motivo.trim();
  if (body.token !== undefined) updateData.klinicosToken = body.token.trim() || null;
  if (pidioPracticaIds) updateData.klinicosPracticaId = practicaIdsValidas![0] ?? null;
  else if (body.practicaId !== undefined) updateData.klinicosPracticaId = body.practicaId;
  if (Object.keys(updateData).length === 0)
    return void res.status(400).json({ error: "Nada para guardar" });

  const [turno] = await db
    .update(turnosTable)
    .set(updateData)
    .where(eq(turnosTable.id, id))
    .returning();
  if (!turno) return void res.status(404).json({ error: "Turno no encontrado" });

  // Sincronizar el conjunto completo de estudios en turno_practicas
  if (pidioPracticaIds) {
    await guardarPracticasDeTurno(id, practicaIdsValidas!);
  } else if (body.practicaId !== undefined) {
    // Cambio por el campo singular legado: sincroniza el conjunto
    await guardarPracticasDeTurno(id, body.practicaId ? [body.practicaId] : []);
  }

  // Nunca guardar el token completo en la auditoría: solo enmascarado
  const auditoriaData: Record<string, unknown> = { ...updateData };
  if (typeof auditoriaData.klinicosToken === "string" && auditoriaData.klinicosToken !== "")
    auditoriaData.klinicosToken = enmascararToken(auditoriaData.klinicosToken);
  await registrarAuditoria(user, "ingreso_consulta_guardar", id, turno.pacienteId, auditoriaData);

  // Evento para el Robot Klinicos si se habilitó un token nuevo
  if (typeof updateData.klinicosToken === "string" && updateData.klinicosToken !== "")
    await registrarEventoTurnoRobot(id, "token_disponible");

  // Si el turno ya fue recepcionado, el trabajo Klinicos ya está encolado:
  // sincronizar los datos guardados sobre el trabajo mientras no se procesó
  // (pendiente o con error, mismos estados que retoma el worker).
  const trabajoUpdate: Record<string, unknown> = {};
  if (body.especialidad !== undefined) trabajoUpdate.especialidad = body.especialidad.trim();
  if (body.profesional !== undefined) trabajoUpdate.profesionalKlinicos = body.profesional.trim() || null;
  if (body.motivo !== undefined) trabajoUpdate.motivo = body.motivo.trim();
  if (body.token !== undefined) trabajoUpdate.tokenAutorizacion = body.token.trim() || null;
  if (pidioPracticaIds)
    trabajoUpdate.practicaCodigos = codigosElegidos && codigosElegidos.length > 0 ? codigosElegidos : null;
  else if (body.practicaId !== undefined)
    trabajoUpdate.practicaCodigos = practicaElegida ? practicaElegida.codigos : null;
  const sincronizados = await db
    .update(klinicosTrabajos)
    .set(trabajoUpdate)
    .where(sql`${klinicosTrabajos.turnoId} = ${id} AND ${klinicosTrabajos.estado} IN ('pendiente', 'error')`)
    .returning({ id: klinicosTrabajos.id });
  req.log.info(
    { turnoId: id, campos: Object.keys(updateData), trabajosSincronizados: sincronizados.map((t) => t.id) },
    "sala-espera: ingreso consulta guardado",
  );

  const ingreso = await cargarIngresoConsulta(id);
  res.json(ingreso);
});

// ── POST /turnos/:id/validar-token ───────────────────────────────────────
// Valida el token IOMA EN VIVO contra el Robot Klinicos externo (ROBOT_API_URL).
// Solo TOKEN_ACCEPTED guarda el token en el turno. TECHNICAL_ERROR y TIMEOUT
// no son denegaciones: el frontend ofrece reintento (mismo request_id).
const ESTADOS_TECNICOS: EstadoValidacionToken[] = ["TECHNICAL_ERROR", "TIMEOUT"];

// Código IOMA para consultas médicas de cualquier especialidad: cuando el
// turno es una consulta (sector consultorio) y no se eligió práctica, se envía
// este código al Robot para que pueda machear la prestación en Klinicos.
const CODIGO_PRACTICA_CONSULTA = "420101";

// Tope de tiempo para la autorización sincrónica tras validar el token: si
// Klinicos tarda más, el cartel sale SIN bono (nunca inventado) y la
// autorización sigue en background — el bono queda persistido en el trabajo y
// en la consulta cuando termina, y un reintento del mismo token lo devuelve.
const AUTORIZACION_TOPE_MS = 45_000;

// Circuito 100% automático disparado por el botón Validar Token (único
// disparador autorizado por el usuario, 02/08/2026): encola el trabajo, le
// copia el token, corre la simulación, la auto-aprueba (sin bandeja) y ejecuta
// la carga real — ingreso + prestación de consulta + autorización con token.
// Fail-closed: cualquier paso que no llegue al bono devuelve detalle claro.
async function cargarYAutorizarAutomatico(
  turnoId: number,
  token: string,
  log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void },
): Promise<{ nroBono: string | null; detalle: string; resultado?: "rechazado" }> {
  if (!klinicosHabilitado())
    return { nroBono: null, detalle: "El robot Klinicos no está habilitado — cargar y autorizar a mano" };
  const trabajoId = await encolarTrabajoKlinicos(turnoId, null, "manual");
  if (!trabajoId)
    return { nroBono: null, detalle: "No se pudo encolar el ingreso al robot (¿paciente sin DNI?) — cargar a mano en Klinicos" };
  await actualizarTokenTrabajosDeTurno(turnoId, token);
  log.info({ turnoId, trabajoId }, "sala-espera: circuito automático Klinicos iniciado por validación de token");

  // Simulación (si el trabajo estaba pendiente/error; si ya estaba esperando
  // aprobación de antes, procesarTrabajo no hace nada y se aprueba abajo).
  await procesarTrabajo(trabajoId);

  const leer = async () => {
    const [t] = await db.select().from(klinicosTrabajos).where(eq(klinicosTrabajos.id, trabajoId)).limit(1);
    return t;
  };
  let t = await leer();
  if (!t) return { nroBono: null, detalle: "El trabajo del robot desapareció — revisar la bandeja" };
  if (t.klinicosNroBono) return { nroBono: t.klinicosNroBono, detalle: "Autorizado en Klinicos" };

  // Reentradas: otro proceso (worker tick, otra validación) lo está cargando.
  if (t.estado === "en_proceso")
    return { nroBono: null, detalle: "El robot está cargando este turno ahora — esperá unos segundos y volvé a validar el token" };
  // Completado sin bono: si la atención quedó creada con URL, el próximo
  // Validar Token la encuentra por el camino normal; si no, es carga manual.
  if (t.estado === "completado")
    return {
      nroBono: null,
      detalle: t.klinicosAtencionUrl
        ? "El ingreso ya está en Klinicos — volvé a validar el token para autorizar la prestación"
        : "El robot terminó pero no quedó registro de la atención — revisar la bandeja o cargar a mano",
    };

  if (t.estado === "esperando_aprobacion") {
    if (klinicosDryRun())
      return { nroBono: null, detalle: "KLINICOS_DRY_RUN activo: la simulación quedó en la bandeja, sin carga real" };
    const [claim] = await db
      .update(klinicosTrabajos)
      .set({ estado: "en_proceso", aprobadoPor: "automático (validar token)", aprobadoEn: new Date() })
      .where(sql`${klinicosTrabajos.id} = ${trabajoId} AND ${klinicosTrabajos.estado} = 'esperando_aprobacion'`)
      .returning({ id: klinicosTrabajos.id });
    if (claim) {
      await ejecutarTrabajoAprobado(trabajoId);
      t = await leer();
    }
  }

  if (t?.klinicosNroBono) return { nroBono: t.klinicosNroBono, detalle: "Cargado y autorizado en Klinicos automáticamente" };
  return {
    nroBono: null,
    // Rechazo explícito del financiador detectado por el worker: se propaga
    // para que la consulta quede DENIED (nunca "aceptada sin bono").
    resultado: t?.autorizacionResultado === "rechazado" ? ("rechazado" as const) : undefined,
    detalle:
      t?.ultimoError ??
      "El robot cargó pero no llegó al bono todavía — esperá unos segundos y volvé a validar el token",
  };
}

// Bono REAL encontrado en Klinicos → la consulta queda ACEPTADA en la fuente
// de verdad (regla única del cartel: verde SOLO con ACCEPTED + bono). Corrige
// también estados engañosos previos (DENIED/MANUAL_REVIEW) cuando la
// prestación ya estaba autorizada en Klinicos (caso Frontini, ago 2026).
async function persistirBonoAceptado(turnoId: number, nroBono: string): Promise<void> {
  await db
    .update(consultasTokenTable)
    .set({
      authorizationNumber: nroBono,
      tokenStatus: "ACCEPTED",
      tokenValidatedAt: new Date(),
      tokenFailureCode: null,
      tokenFailureMessage: null,
    })
    .where(eq(consultasTokenTable.consultationId, turnoId));
}

async function autorizarConTope(
  turnoId: number,
  token: string,
  log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void },
): Promise<{ nroBono: string | null; resultado?: "aceptado" | "rechazado" | "incierto" | null; autorizacionDetalle: string | null }> {
  const tarea = autorizarConsultaConToken(turnoId, token).then(async (aut) => {
    // Pedido del usuario (02/08/2026): el robot NO se encola al reservar
    // (llave global apagada); se encola SOLO cuando recepción valida el token
    // y todavía no hay atención en Klinicos para el paciente.
    if (!aut.nroBono && aut.detalle === "Sin atención creada por el robot para este turno") {
      // Circuito 100% automático (pedido del usuario 02/08/2026): encolar,
      // simular, auto-aprobar y ejecutar la carga real (ingreso + prestación
      // + autorización con el token) en una sola pasada, sin bandeja.
      const auto = await cargarYAutorizarAutomatico(turnoId, token, log);
      if (auto.nroBono) {
        await persistirBonoAceptado(turnoId, auto.nroBono);
      } else if (auto.resultado === "rechazado") {
        // Rechazo explícito del financiador: la consulta queda DENIED en la
        // fuente de verdad — el frontend nunca puede mostrar verde sin bono.
        await db
          .update(consultasTokenTable)
          .set({ tokenStatus: "DENIED", tokenFailureCode: "DENIED", tokenFailureMessage: auto.detalle })
          .where(eq(consultasTokenTable.consultationId, turnoId));
      }
      return { ...aut, nroBono: auto.nroBono, detalle: auto.detalle, resultado: auto.resultado ?? aut.resultado };
    }
    if (aut.nroBono) {
      await persistirBonoAceptado(turnoId, aut.nroBono);
    } else if (aut.resultado === "rechazado") {
      await db
        .update(consultasTokenTable)
        .set({ tokenStatus: "DENIED", tokenFailureCode: "DENIED", tokenFailureMessage: aut.detalle })
        .where(eq(consultasTokenTable.consultationId, turnoId));
    }
    log.info(
      { turnoId, nroBono: aut.nroBono, resultado: aut.resultado, detalle: aut.detalle },
      "sala-espera: autorización de prestación tras token validado",
    );
    return aut;
  });
  tarea.catch((err) => log.warn({ turnoId, err: String(err) }, "sala-espera: autorización tras token falló"));
  const timeout = new Promise<{ nroBono: null; detalle: string }>((resolve) =>
    setTimeout(
      () =>
        resolve({
          nroBono: null,
          detalle:
            "Klinicos está tardando: la autorización sigue en proceso. Verificá en unos minutos que el bono haya quedado registrado.",
        }),
      AUTORIZACION_TOPE_MS,
    ).unref?.(),
  );
  try {
    const r = await Promise.race([tarea, timeout]);
    // Sin bono = la prestación NO quedó autorizada en Klinicos todavía: el
    // detalle SIEMPRE viaja al frontend para que recepción no dé por hecho
    // que se cargó (regla de la clínica, ago 2026).
    return {
      nroBono: r.nroBono,
      resultado: "resultado" in r ? (r.resultado ?? null) : null,
      autorizacionDetalle: r.nroBono ? null : (r.detalle ?? "La autorización en Klinicos no se completó"),
    };
  } catch (err) {
    return {
      nroBono: null,
      resultado: null,
      autorizacionDetalle: `La autorización en Klinicos falló: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
// Reintentables con el MISMO request_id: errores técnicos + corrección de datos.
const ESTADOS_REINTENTABLES: EstadoValidacionToken[] = [...ESTADOS_TECNICOS, "DATA_REQUIRED"];

router.post("/turnos/:id/validar-token", async (req, res) => {
  const user = await getUser(req);
  if (!user) return void res.status(401).json({ error: "No autenticado" });
  if (!ROLES_OPERACION.includes(user.rol))
    return void res.status(403).json({ error: "Sin permisos" });
  return ejecutarValidacionTokenTurno(req, res, user);
});

// Cuerpo compartido de la validación de token de un turno (sin auth): lo usa
// la ruta staff de arriba y el endpoint público de check in de la app del
// paciente (api_publica.ts), que hace sus propias guardas antes de llamar.
export async function ejecutarValidacionTokenTurno(req: Request, res: Response, actor: ActorToken): Promise<void> {
  // Decisión 01/08/2026: la validación la resolvemos NOSOTROS con el
  // automatizador interno (credenciales KLINICOS_USUARIO/PASSWORD). El Robot
  // externo queda solo como respaldo mientras exista el feature flag viejo.
  if (!validacionInternaDisponible() && !validacionTokenHabilitada())
    return void res.status(503).json({
      error:
        "La validación de token no está habilitada: faltan las credenciales de KLINICOS (y el Robot externo está apagado)",
    });
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0)
    return void res.status(400).json({ error: "ID inválido" });

  const parsed = ValidarTokenTurnoBody.safeParse(req.body);
  if (!parsed.success || parsed.data.token.trim() === "")
    return void res.status(400).json({ error: "Token requerido" });
  // Guía del Robot: el token va SIN espacios (ni internos ni en los bordes).
  const token = parsed.data.token.replace(/\s+/g, "");
  const ultimos4 = token.slice(-4);

  const [fila] = await db
    .select({
      turno: turnosTable,
      paciente: pacientesTable,
      especialidadNombre: especialidadesTable.nombre,
      turneraNombre: turnerasTable.nombre,
      turneraKlinicosEspecialidad: turnerasTable.klinicosEspecialidad,
      turneraKlinicosProfesional: turnerasTable.klinicosProfesional,
      turneraKlinicosSector: turnerasTable.klinicosSector,
      sedeNombre: sedesTable.nombre,
      profesional: profesionalesTable,
    })
    .from(turnosTable)
    .innerJoin(pacientesTable, eq(turnosTable.pacienteId, pacientesTable.id))
    .innerJoin(turnerasTable, eq(turnosTable.turneraId, turnerasTable.id))
    .leftJoin(sedesTable, eq(turnerasTable.sedeId, sedesTable.id))
    .leftJoin(especialidadesTable, eq(turnerasTable.especialidadId, especialidadesTable.id))
    .leftJoin(profesionalesTable, eq(turnerasTable.profesionalId, profesionalesTable.id))
    .where(eq(turnosTable.id, id))
    .limit(1);
  if (!fila) return void res.status(404).json({ error: "Turno no encontrado" });
  if (!fila.paciente.dni)
    return void res.status(400).json({ error: "El paciente no tiene DNI cargado" });

  // Regla general (Federico 02/08/2026): solo validan token en Klinicos las
  // obras sociales habilitadas (hoy: IOMA). Particulares, PAMI y otras
  // coberturas no llevan token.
  const coberturaTurno = fila.turno.cobertura ?? fila.paciente.cobertura ?? null;
  if (!coberturaValidaEnKlinicos(coberturaTurno))
    return void res.status(409).json({
      error: `La cobertura del paciente (${coberturaTurno ?? "sin cobertura"}) no valida token en Klinicos. Por ahora solo IOMA lleva token.`,
    });

  // Guía del Robot: el token vale SOLO para el día de la atención. No enviar
  // tokens de otros días — se frena acá para evitar el rebote de IOMA.
  const hoy = hoyArgentina();
  if (fila.turno.fecha && fila.turno.fecha !== hoy)
    return void res.status(409).json({
      error: `El token vale solo para el día de la atención. Este turno es del ${fila.turno.fecha} y hoy es ${hoy}: pedile al afiliado un token del día de la atención real.`,
    });

  // No volver a enviar un token que ya fue aceptado para este turno
  if (fila.turno.klinicosToken && fila.turno.klinicosToken === token) {
    // Bono ya registrado (trazabilidad): se devuelve el guardado, jamás uno
    // inventado. Si el token quedó aceptado SIN bono (p. ej. la prestación
    // todavía no existía), este reintento vuelve a intentar la autorización.
    const [ct] = await db
      .select({
        authorizationNumber: consultasTokenTable.authorizationNumber,
        tokenStatus: consultasTokenTable.tokenStatus,
      })
      .from(consultasTokenTable)
      .where(eq(consultasTokenTable.consultationId, id))
      .limit(1);
    let bonoGuardado = ct?.authorizationNumber ?? null;
    let autorizacionDetalle: string | null = null;
    // Reparación de estado engañoso: bono REAL persistido pero estado ≠
    // ACCEPTED (p. ej. quedó DENIED de un intento previo) → se corrige acá,
    // así el cartel verde responde a la regla única ACCEPTED + bono.
    if (bonoGuardado && ct?.tokenStatus !== "ACCEPTED") {
      await persistirBonoAceptado(id, bonoGuardado);
    }
    // Rechazo EXPLÍCITO ya persistido para ESTE token: no se reenvía jamás
    // (la guarda liberada es para tokens NUEVOS). Pero un DENIED engañoso
    // (caso Frontini ago 2026: la prestación quedó FACTURABLE con bono por
    // una autorización externa) se rescata con una relectura SOLO LECTURA
    // que nunca envía el token; sin atención conocida no toca la red.
    if (!bonoGuardado && ct?.tokenStatus === "DENIED") {
      const bonoRelectura = await releerBonoConsulta(id);
      if (bonoRelectura) {
        bonoGuardado = bonoRelectura;
        await persistirBonoAceptado(id, bonoGuardado);
      }
    } else if (!bonoGuardado) {
      const reintento = await autorizarConTope(id, token, req.log);
      autorizacionDetalle = reintento.autorizacionDetalle;
      if (reintento.nroBono) {
        bonoGuardado = reintento.nroBono;
        await persistirBonoAceptado(id, bonoGuardado);
      }
    }
    // Regla única de verdad (incidente 2-ago-2026): NUNCA responder
    // "aceptado/habilitada" sin bono. Sin bono, el resultado sale del estado
    // persistido real: DENIED → rechazo; cualquier otro → no confirmado.
    if (bonoGuardado) {
      return void res.json({
        estado: "TOKEN_ACCEPTED",
        mensaje: "Token aceptado. Consulta habilitada.",
        requestId: null,
        referenciaKlinicos: null,
        latenciaMs: null,
        reintentable: false,
        nroBono: bonoGuardado,
        autorizacionDetalle,
      });
    }
    const [ctFinal] = await db
      .select({ tokenStatus: consultasTokenTable.tokenStatus })
      .from(consultasTokenTable)
      .where(eq(consultasTokenTable.consultationId, id))
      .limit(1);
    if ((ctFinal?.tokenStatus ?? ct?.tokenStatus) === "DENIED") {
      return void res.json({
        estado: "TOKEN_DENIED",
        mensaje: "IOMA no autorizó la prestación.",
        requestId: null,
        referenciaKlinicos: null,
        latenciaMs: null,
        reintentable: false,
        nroBono: null,
        autorizacionDetalle,
      });
    }
    return void res.json({
      estado: "TECHNICAL_ERROR",
      mensaje:
        "Validación no confirmada: el token está registrado pero la prestación todavía no tiene bono. La consulta NO está habilitada.",
      requestId: null,
      referenciaKlinicos: null,
      latenciaMs: null,
      reintentable: true,
      nroBono: null,
      autorizacionDetalle,
    });
  }

  // Idempotencia (spec): reutilizar el request_id del último intento con el
  // mismo token cuando fue error técnico O contingencia de carga manual —
  // el reintento tras cargar la prestación es la MISMA solicitud lógica.
  const ESTADOS_REUSO_REQUEST_ID = [
    ...ESTADOS_TECNICOS,
    "MANUAL_PRESTATION_REQUIRED",
    // Estados asíncronos / de corrección del contrato preliminar: la solicitud
    // sigue siendo la MISMA (mismo request_id) hasta su resolución final.
    "PROCESSING",
    "DATA_REQUIRED",
    "MAPPING_REQUIRED",
  ];
  const [previa] = await db
    .select()
    .from(klinicosTokenValidaciones)
    .where(
      and(
        eq(klinicosTokenValidaciones.turnoId, id),
        eq(klinicosTokenValidaciones.tokenUltimos4, ultimos4),
        inArray(klinicosTokenValidaciones.estado, ESTADOS_REUSO_REQUEST_ID),
      ),
    )
    .orderBy(sql`${klinicosTokenValidaciones.creadoEn} DESC`)
    .limit(1);
  const requestId = previa?.requestId ?? randomUUID();

  const especialidad =
    fila.turno.klinicosEspecialidad ?? fila.turneraKlinicosEspecialidad ?? fila.especialidadNombre;
  const profesional =
    fila.turno.klinicosProfesional ??
    fila.turneraKlinicosProfesional ??
    (fila.profesional
      ? [fila.profesional.apellido, fila.profesional.nombre].filter(Boolean).join(" ")
      : null);

  // CIE-10 del turno para diagnosis_code (campo opcional de la planilla
  // Conectar que acelera la validación): primero el último trabajo Klinicos
  // del turno; si no hay, la consulta (encounter) que el médico registró para
  // este turno, vinculada vía la auditoría de creación del encounter (los
  // encounters no guardan turnoId propio). Sin diagnóstico, el campo no viaja.
  const [trabajoCie] = await db
    .select({ cie10Codigo: klinicosTrabajos.cie10Codigo })
    .from(klinicosTrabajos)
    .where(eq(klinicosTrabajos.turnoId, id))
    .orderBy(sql`${klinicosTrabajos.id} DESC`)
    .limit(1);
  let cie10Diagnostico = normalizarCie10(trabajoCie?.cie10Codigo);
  if (!cie10Diagnostico) {
    const [encCie] = await db
      .select({ cie10: encountersTable.cie10 })
      .from(auditLogTable)
      .innerJoin(encountersTable, eq(encountersTable.id, auditLogTable.entidadId))
      .where(
        and(
          eq(auditLogTable.entidad, "encounter"),
          sql`(${auditLogTable.detalle} ->> 'turnoId')::int = ${id}`,
        ),
      )
      .orderBy(sql`${auditLogTable.id} DESC`)
      .limit(1);
    cie10Diagnostico = normalizarCie10(encCie?.cie10);
  }

  // Práctica del nomenclador IOMA elegida por recepción: le da al Robot los
  // códigos de práctica para que pueda cargar/machear la prestación en Klinicos.
  let [practicaTurno] = fila.turno.klinicosPracticaId
    ? await db
        .select({
          nombre: klinicosPracticas.nombre,
          codigos: klinicosPracticas.codigos,
          codigoEnvio: klinicosPracticas.codigoEnvio,
          codigoFacturacion: klinicosPracticas.codigoFacturacion,
        })
        .from(klinicosPracticas)
        .where(eq(klinicosPracticas.id, fila.turno.klinicosPracticaId))
        .limit(1)
    : [];

  // Fallback para consultas: si el turno es una consulta (sector consultorio)
  // y recepción no eligió práctica, toda consulta de cualquier especialidad
  // corresponde al código 420101 del nomenclador IOMA.
  if (!practicaTurno) {
    const sectorTurno =
      fila.turneraKlinicosSector ??
      (especialidad ? await resolverSectorServicio(especialidad) : "CONSULTORIO");
    if (esSectorConsultorio(sectorTurno))
      practicaTurno = {
        nombre: "CONSULTA MEDICA",
        codigos: [CODIGO_PRACTICA_CONSULTA],
        codigoEnvio: CODIGO_PRACTICA_CONSULTA,
        codigoFacturacion: null,
      };
  }

  // Planilla Conectar: el practice_code es el string EXACTO acordado (código
  // de envío, con separadores + / - y sufijos /A /B). Se resuelve por
  // codigoEnvio → codigoFacturacion (override legado) → planilla embebida →
  // código único. NUNCA se inventa un código uniendo la lista de facturación:
  // una práctica sin código resoluble queda marcada para revisión manual sin
  // llamar al Robot, para no frenar el caso del lado de Conectar.
  const codigoEnvio = practicaTurno ? codigoFacturacionPractica(practicaTurno) : null;
  if (practicaTurno && !codigoEnvio) {
    const mensajeSinCodigo = `La práctica "${practicaTurno.nombre}" no tiene código de envío acordado con Conectar: el caso queda para revisión manual. Cargá el código de la planilla en Configuración → KLINICOS → Prácticas o enviá el token a revisión.`;
    await db.insert(klinicosTokenValidaciones).values({
      turnoId: id,
      requestId,
      tokenUltimos4: ultimos4,
      estado: "MANUAL_REVIEW",
      motivo: mensajeSinCodigo,
      referenciaKlinicos: null,
      latenciaMs: 0,
    });
    const camposSinCodigo = {
      coverageType: "IOMA",
      affiliateNumber: fila.paciente.nroAfiliado ?? null,
      tokenStatus: mapearEstadoToken("MANUAL_REVIEW"),
      tokenMasked: enmascararToken(token),
      tokenCompleto: token,
      tokenValidatedAt: null,
      tokenValidationRequestId: requestId,
      klinicosReference: null,
      authorizationNumber: null,
      tokenFailureCode: "MANUAL_REVIEW" as const,
      tokenFailureMessage: mensajeSinCodigo,
      robotSyncStatus: mapearRobotSyncStatus("MANUAL_REVIEW"),
    };
    await db
      .insert(consultasTokenTable)
      .values({ consultationId: id, ...camposSinCodigo })
      .onConflictDoUpdate({ target: consultasTokenTable.consultationId, set: camposSinCodigo });
    req.log.warn(
      { turnoId: id, practica: practicaTurno.nombre },
      "sala-espera: práctica sin código de envío Conectar — validación a revisión manual",
    );
    return void res.json({
      estado: "MANUAL_REVIEW",
      mensaje: mensajeSinCodigo,
      requestId,
      referenciaKlinicos: null,
      latenciaMs: 0,
      reintentable: false,
      camposFaltantes: ["practice_code"],
      posicionCola: null,
      esperaEstimadaSegundos: null,
    });
  }

  // Nro. de afiliado (Conectar, jul 2026): ya NO bloquea. El Robot sincroniza
  // el padrón de IOMA a diario y completa el número por DNI, así que la
  // validación se envía igual con el campo vacío si falta.
  const nroAfiliado = fila.paciente.nroAfiliado?.trim() || null;
  if (!nroAfiliado) {
    req.log.info(
      { turnoId: id, pacienteId: fila.paciente.id },
      "sala-espera: paciente sin nro. de afiliado — se envía igual, el Robot lo completa por padrón",
    );
  }

  // Nombre profesional en formato "Apellido, Nombre" (contrato del Robot)
  const professionalName = fila.profesional
    ? [fila.profesional.apellido, fila.profesional.nombre].filter(Boolean).join(", ")
    : (profesional ?? undefined);

  // HALLAZGO 2-ago-2026 (confirmado con bono 18409970): la "validación
  // previa" de Klinicos (/ordenPrestacion/validarDatosObraSocialPaciente con
  // OSToken) NO es solo-lectura — IOMA consume el token ahí, y la
  // autorización posterior rebota con "ya fue utilizado". Con el
  // automatizador interno el token viaja UNA sola vez, directo a la
  // autorización: su resultado ES la validación (bono → aceptado; rechazo
  // explícito de IOMA → denegado; sin confirmación → error técnico
  // reintentable, nunca verde).
  let resultado: {
    estado: EstadoValidacionToken;
    mensaje: string | null;
    referenciaKlinicos: string | null;
    latenciaMs: number | null;
    camposFaltantes?: string[] | null;
    posicionCola?: number | null;
    esperaEstimadaSegundos?: number | null;
  };
  let nroBono: string | null = null;
  let autorizacionDetalle: string | null = null;
  if (validacionInternaDisponible()) {
    const inicio = Date.now();
    // El token queda disponible ANTES de autorizar: si la atención todavía no
    // existe, el circuito automático la crea y usa este token una única vez.
    await db.update(turnosTable).set({ klinicosToken: token }).where(eq(turnosTable.id, id));
    await registrarEventoTurnoRobot(id, "token_disponible");
    await db
      .update(klinicosTrabajos)
      .set({ tokenAutorizacion: token })
      .where(
        sql`${klinicosTrabajos.turnoId} = ${id} AND ${klinicosTrabajos.estado} IN ('pendiente', 'error')`,
      );
    const aut = await autorizarConTope(id, token, req.log);
    nroBono = aut.nroBono;
    autorizacionDetalle = aut.autorizacionDetalle;
    resultado = {
      estado: aut.nroBono ? "TOKEN_ACCEPTED" : aut.resultado === "rechazado" ? "TOKEN_DENIED" : "TECHNICAL_ERROR",
      mensaje: aut.nroBono
        ? `Autorizado en Klinicos — N° de Bono ${aut.nroBono}`
        : (aut.autorizacionDetalle ?? "La autorización en Klinicos no se confirmó — reintentá en unos segundos"),
      referenciaKlinicos: aut.nroBono,
      latenciaMs: Date.now() - inicio,
    };
  } else {
  // Respaldo: Robot externo (flujo viejo — valida primero y autoriza después).
  resultado = await robotTokenValidationProvider.validateToken({
    request_id: requestId,
    consultation_id: String(id),
    token,
    professional_id: fila.profesional ? String(fila.profesional.id) : undefined,
    professional_name: professionalName || undefined,
    specialty_code: especialidad ?? undefined,
    institution_id: fila.sedeNombre ?? undefined,
    diagnosis_code: cie10Diagnostico,
    // practice_code EXACTO según la planilla Conectar (combos como un solo
    // código con sus separadores; nunca joins inventados con coma).
    practice_code: codigoEnvio ?? undefined,
    // Guía del Robot: fecha de atención DD/MM/AAAA (el día del token).
    attention_date: fila.turno.fecha ? fila.turno.fecha.split("-").reverse().join("/") : undefined,
    patient: {
      document_type: "DNI",
      document_number: fila.paciente.dni.replace(/\D/g, ""),
      patient_id: String(fila.paciente.id),
      affiliate_number: nroAfiliado ?? undefined,
      // Guía del Robot: nombre y apellido tal como figuran en IOMA.
      first_name: fila.paciente.nombre ?? undefined,
      last_name: fila.paciente.apellido ?? undefined,
    },
  });
  }

  await db.insert(klinicosTokenValidaciones).values({
    turnoId: id,
    requestId,
    tokenUltimos4: ultimos4,
    estado: resultado.estado,
    motivo: resultado.mensaje,
    referenciaKlinicos: resultado.referenciaKlinicos,
    latenciaMs: resultado.latenciaMs,
  });

  // Campos reservados del token en el modelo de consulta (incluye el token
  // completo desde jul 2026, pedido de la clínica para facturación)
  const estadoToken = mapearEstadoToken(resultado.estado);
  const esAceptado = estadoToken === "ACCEPTED";
  const camposToken = {
    coverageType: "IOMA",
    affiliateNumber: fila.paciente.nroAfiliado ?? null,
    tokenStatus: estadoToken,
    tokenMasked: enmascararToken(token),
    tokenCompleto: token,
    tokenValidatedAt: esAceptado ? new Date() : null,
    tokenValidationRequestId: requestId,
    klinicosReference: resultado.referenciaKlinicos,
    // Circuito directo: ACCEPTED solo existe con bono real (nroBono); el
    // flujo externo viejo persistía su referencia de validación.
    authorizationNumber: esAceptado ? (nroBono ?? resultado.referenciaKlinicos) : null,
    tokenFailureCode: esAceptado ? null : resultado.estado,
    tokenFailureMessage: esAceptado ? null : resultado.mensaje,
    robotSyncStatus: mapearRobotSyncStatus(resultado.estado),
  };
  await db
    .insert(consultasTokenTable)
    .values({ consultationId: id, ...camposToken })
    .onConflictDoUpdate({ target: consultasTokenTable.consultationId, set: camposToken });

  req.log.info(
    {
      turnoId: id,
      requestId,
      token: enmascararToken(token),
      estado: resultado.estado,
      latenciaMs: resultado.latenciaMs,
      referenciaKlinicos: resultado.referenciaKlinicos,
    },
    "sala-espera: validación de token vía Robot Klinicos",
  );

  let recepcionadoAutomatico = false;
  if (resultado.estado === "TOKEN_ACCEPTED") {
    if (!validacionInternaDisponible()) {
      // Flujo externo viejo: recién acá se guarda el token y se autoriza.
      await db.update(turnosTable).set({ klinicosToken: token }).where(eq(turnosTable.id, id));
      await registrarEventoTurnoRobot(id, "token_disponible");
      await db
        .update(klinicosTrabajos)
        .set({ tokenAutorizacion: token })
        .where(
          sql`${klinicosTrabajos.turnoId} = ${id} AND ${klinicosTrabajos.estado} IN ('pendiente', 'error')`,
        );
      // Autorización sincrónica (con tope de tiempo). Regla de la clínica
      // (ago 2026): el bono nunca se inventa — solo el que Klinicos devuelve.
      const autorizacion = await autorizarConTope(id, token, req.log);
      nroBono = autorizacion.nroBono;
      autorizacionDetalle = autorizacion.autorizacionDetalle;
    }
    await registrarAuditoria(actor, "token_validado", id, fila.turno.pacienteId, {
      requestId,
      token: enmascararToken(token),
      referenciaKlinicos: resultado.referenciaKlinicos,
      latenciaMs: resultado.latenciaMs,
      nroBono,
    });
    // Token validado ⇒ recepción automática del paciente (turnos de hoy).
    recepcionadoAutomatico = await recepcionarTrasTokenValidado(actor, id, req.log);
  }

  // Contingencia de carga manual: el Robot no encontró una prestación válida
  // en KLINICOS. El recepcionista debe cargarla a mano y reintentar.
  let contexto: Record<string, unknown> | undefined;
  if (resultado.estado === "MANUAL_PRESTATION_REQUIRED") {
    const [trabajo] = await db
      .select({
        cie10Codigo: klinicosTrabajos.cie10Codigo,
        cie10Descripcion: klinicosTrabajos.cie10Descripcion,
      })
      .from(klinicosTrabajos)
      .where(eq(klinicosTrabajos.turnoId, id))
      .orderBy(sql`${klinicosTrabajos.id} DESC`)
      .limit(1);
    contexto = {
      paciente: [fila.paciente.apellido, fila.paciente.nombre].filter(Boolean).join(", "),
      dni: fila.paciente.dni,
      afiliado: fila.paciente.nroAfiliado ?? null,
      fecha: [fila.turno.fecha, fila.turno.horaInicio].filter(Boolean).join(" "),
      // Solo el código: es lo que recepción carga tal cual en KLINICOS.
      practica:
        codigoEnvio ??
        (practicaTurno?.codigos?.length
          ? practicaTurno.codigos.join(", ")
          : (fila.turneraNombre ?? null)),
      profesional: profesional ?? null,
      especialidad: especialidad ?? null,
      sede: fila.sedeNombre ?? null,
      cie10: trabajo?.cie10Codigo
        ? [trabajo.cie10Codigo, trabajo.cie10Descripcion].filter(Boolean).join(" — ")
        : null,
      motivo: fila.turno.motivoConsulta ?? null,
      detalle: resultado.mensaje,
    };
  }

  res.json({
    estado: resultado.estado,
    mensaje: resultado.mensaje,
    requestId,
    referenciaKlinicos: resultado.referenciaKlinicos,
    latenciaMs: resultado.latenciaMs,
    reintentable: ESTADOS_REINTENTABLES.includes(resultado.estado),
    camposFaltantes: resultado.camposFaltantes ?? [],
    posicionCola: resultado.posicionCola ?? null,
    esperaEstimadaSegundos: resultado.esperaEstimadaSegundos ?? null,
    recepcionadoAutomatico,
    nroBono,
    autorizacionDetalle,
    pacienteApellido: fila.paciente.apellido ?? null,
    pacienteNombre: fila.paciente.nombre ?? null,
    ...(contexto ? { contexto } : {}),
  });
}

// ── Contingencia de carga manual en KLINICOS ─────────────────────────────
// Reglas: "Prestación cargada" SOLO registra la declaración del usuario (el
// Robot debe verificar de nuevo; nada marca TOKEN_ACCEPTED manualmente).
// "Enviar a revisión" pasa el token a MANUAL_REVIEW. Ambas acciones quedan
// auditadas con el usuario que las ejecutó.
async function cargarEstadoTokenConsulta(turnoId: number) {
  const [fila] = await db
    .select({ ct: consultasTokenTable, pacienteId: turnosTable.pacienteId })
    .from(consultasTokenTable)
    .innerJoin(turnosTable, eq(consultasTokenTable.consultationId, turnosTable.id))
    .where(eq(consultasTokenTable.consultationId, turnoId))
    .limit(1);
  return fila ?? null;
}

router.post("/turnos/:id/token-prestacion-cargada", async (req, res) => {
  const user = await getUser(req);
  if (!user) return void res.status(401).json({ error: "No autenticado" });
  if (!ROLES_OPERACION.includes(user.rol))
    return void res.status(403).json({ error: "Sin permisos" });
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0)
    return void res.status(400).json({ error: "ID inválido" });

  const fila = await cargarEstadoTokenConsulta(id);
  if (
    !fila ||
    (fila.ct.robotSyncStatus !== "MANUAL_PRESTATION_REQUIRED" &&
      fila.ct.robotSyncStatus !== "READY_TO_RETRY")
  )
    return void res.status(409).json({
      error: "El turno no está en contingencia de carga manual (MANUAL_PRESTATION_REQUIRED)",
    });

  // Solo registra la declaración: NO marca el token como aceptado ni habilita
  // la consulta. Pasa robot_sync_status a READY_TO_RETRY (spec) para habilitar
  // el reintento; el Robot debe verificar la existencia al reintentar.
  await db
    .update(consultasTokenTable)
    .set({ robotSyncStatus: "READY_TO_RETRY" })
    .where(eq(consultasTokenTable.consultationId, id));
  await registrarAuditoria(user, "token_prestacion_cargada_declarada", id, fila.pacienteId, {
    tokenStatus: fila.ct.tokenStatus,
    robotSyncStatus: "READY_TO_RETRY",
    requestId: fila.ct.tokenValidationRequestId,
  });
  req.log.info(
    { turnoId: id, usuario: user.email },
    "sala-espera: recepcionista declaró prestación cargada en KLINICOS",
  );
  res.json({ ok: true, tokenStatus: fila.ct.tokenStatus, robotSyncStatus: "READY_TO_RETRY" });
});

router.post("/turnos/:id/token-enviar-revision", async (req, res) => {
  const user = await getUser(req);
  if (!user) return void res.status(401).json({ error: "No autenticado" });
  if (!ROLES_OPERACION.includes(user.rol))
    return void res.status(403).json({ error: "Sin permisos" });
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0)
    return void res.status(400).json({ error: "ID inválido" });

  const fila = await cargarEstadoTokenConsulta(id);
  if (!fila || fila.ct.tokenStatus === "ACCEPTED" || fila.ct.tokenStatus === "NOT_REQUESTED")
    return void res.status(409).json({
      error: "El turno no tiene una validación de token pendiente para enviar a revisión",
    });

  await db
    .update(consultasTokenTable)
    .set({ tokenStatus: "MANUAL_REVIEW" })
    .where(eq(consultasTokenTable.consultationId, id));
  await registrarAuditoria(user, "token_enviado_revision", id, fila.pacienteId, {
    estadoAnterior: fila.ct.tokenStatus,
    robotSyncStatus: fila.ct.robotSyncStatus,
    requestId: fila.ct.tokenValidationRequestId,
  });
  req.log.info(
    { turnoId: id, usuario: user.email, estadoAnterior: fila.ct.tokenStatus },
    "sala-espera: token enviado a revisión manual",
  );
  res.json({ ok: true, tokenStatus: "MANUAL_REVIEW", robotSyncStatus: fila.ct.robotSyncStatus });
});

// ── GET /turnos/:id/token-auditoria ──────────────────────────────────────
// Historial de la validación IOMA del turno: intentos contra el Robot y
// acciones de contingencia (declaración de carga manual, envío a revisión).
const ACCIONES_TOKEN = [
  "token_validado",
  "token_prestacion_cargada_declarada",
  "token_enviado_revision",
];

router.get("/turnos/:id/token-auditoria", async (req, res) => {
  const user = await getUser(req);
  if (!user) return void res.status(401).json({ error: "No autenticado" });
  if (!ROLES_LECTURA.includes(user.rol))
    return void res.status(403).json({ error: "Sin permisos" });
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0)
    return void res.status(400).json({ error: "ID inválido" });

  const intentos = await db
    .select()
    .from(klinicosTokenValidaciones)
    .where(eq(klinicosTokenValidaciones.turnoId, id))
    .orderBy(sql`${klinicosTokenValidaciones.creadoEn} DESC`)
    .limit(50);
  const acciones = await db
    .select()
    .from(auditLogTable)
    .where(
      and(
        eq(auditLogTable.entidad, "turno"),
        eq(auditLogTable.entidadId, id),
        inArray(auditLogTable.accion, ACCIONES_TOKEN),
      ),
    )
    .orderBy(sql`${auditLogTable.createdAt} DESC`)
    .limit(50);

  const entradas = [
    ...intentos.map((v) => ({
      fecha: v.creadoEn?.toISOString() ?? null,
      tipo: "validacion" as const,
      descripcion: `Validación → ${v.estado}${v.motivo ? `: ${v.motivo}` : ""}`,
      usuario: null as string | null,
      estado: v.estado,
      requestId: v.requestId,
      referenciaKlinicos: v.referenciaKlinicos,
      latenciaMs: v.latenciaMs,
    })),
    ...acciones.map((a) => ({
      fecha: a.createdAt?.toISOString() ?? null,
      tipo: "accion" as const,
      descripcion: a.accion,
      usuario: a.usuarioEmail,
      estado: null as string | null,
      requestId: null as string | null,
      referenciaKlinicos: null as string | null,
      latenciaMs: null as number | null,
    })),
  ].sort((x, y) => (y.fecha ?? "").localeCompare(x.fecha ?? ""));

  res.json({ entradas });
});

// ── POST /robot-klinicos/prueba ──────────────────────────────────────────
// Prueba controlada de la validación de token contra El Robot (solo admins).
// NO toca turnos ni consultas: es la "prueba sólo para administradores" que
// exige la spec antes de habilitar la recepción productiva. Llama al Robot
// aunque KLINICOS_TOKEN_VALIDATION_ENABLED esté en false (ese flag protege
// solo el circuito productivo de recepción).
// Documentación completa: docs/robot-klinicos.md

// Rate limiting simple en memoria para la prueba admin: 1 solicitud en vuelo
// por usuario (evita doble clic / reintentos simultáneos) y máx. 5 por minuto.
const pruebaEnVuelo = new Set<number>();
const pruebaHistorial = new Map<number, number[]>();
const PRUEBA_MAX_POR_MINUTO = 5;

function pruebaRateLimitOk(userId: number): { ok: boolean; motivo?: string } {
  if (pruebaEnVuelo.has(userId))
    return { ok: false, motivo: "Ya hay una validación en curso. Esperá a que termine." };
  const ahora = Date.now();
  const hist = (pruebaHistorial.get(userId) ?? []).filter((t) => ahora - t < 60_000);
  if (hist.length >= PRUEBA_MAX_POR_MINUTO)
    return { ok: false, motivo: "Demasiadas pruebas en un minuto. Esperá un momento." };
  hist.push(ahora);
  pruebaHistorial.set(userId, hist);
  return { ok: true };
}

// CIE-10: estructura válida (letra + 2 dígitos + subcategoría opcional) y,
// si el catálogo institucional (reglas CIE-10 de KLINICOS) tiene entradas,
// el código debe existir allí. Nunca se inventa un diagnóstico.
const CIE10_ESTRUCTURA = /^[A-Z]\d{2}(\.\d{1,2})?$/;
async function validarCie10Catalogo(codigo: string): Promise<string | null> {
  if (!CIE10_ESTRUCTURA.test(codigo))
    return `El código CIE-10 "${codigo}" no tiene un formato válido (ej: J06.9)`;
  const enCatalogo = await db
    .select({ codigo: klinicosReglasCie10.cie10Codigo })
    .from(klinicosReglasCie10)
    .where(eq(klinicosReglasCie10.cie10Codigo, codigo))
    .limit(1);
  if (enCatalogo.length > 0) return null;
  const [{ total }] = (await db
    .select({ total: sql<number>`count(*)::int` })
    .from(klinicosReglasCie10)) as [{ total: number }];
  if (total === 0) return null; // catálogo vacío: solo validación estructural
  return `El código CIE-10 "${codigo}" no está en el catálogo institucional (Configuración → KLINICOS → Reglas CIE-10)`;
}

router.post("/robot-klinicos/prueba", async (req, res) => {
  const user = await getUser(req);
  if (!user) return void res.status(401).json({ error: "No autenticado" });
  if (user.rol !== "admin")
    return void res.status(403).json({ error: "Solo administradores pueden ejecutar la prueba" });

  const parsed = ProbarRobotKlinicosBody.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: "Datos inválidos" });
  const token = parsed.data.token.trim();
  const dni = parsed.data.dni.trim();
  if (token === "") return void res.status(400).json({ error: "Token requerido" });
  if (!/^\d+$/.test(dni))
    return void res.status(400).json({ error: "El DNI debe contener solo dígitos" });

  const cie10 = normalizarCie10(parsed.data.diagnosisCode);
  if (parsed.data.diagnosisCode?.trim() && cie10) {
    const errorCie10 = await validarCie10Catalogo(cie10);
    if (errorCie10) return void res.status(400).json({ error: errorCie10 });
  }

  const limite = pruebaRateLimitOk(user.id);
  if (!limite.ok) return void res.status(429).json({ error: limite.motivo });

  const requestId = parsed.data.requestId?.trim() || randomUUID();
  pruebaEnVuelo.add(user.id);
  let resultado;
  try {
    resultado = await validarTokenConRobot({
      request_id: requestId,
      consultation_id:
        parsed.data.consultationId?.trim() || `prueba-admin-${requestId.slice(0, 8)}`,
      token,
      practice_code: parsed.data.practiceCode ?? undefined,
      professional_id: parsed.data.professionalId ?? undefined,
      professional_name: parsed.data.professionalName ?? undefined,
      specialty_code: parsed.data.specialtyCode ?? undefined,
      institution_id: parsed.data.institutionId ?? undefined,
      diagnosis_code: cie10,
      patient: {
        document_type: parsed.data.documentType?.trim() || "DNI",
        document_number: dni,
        patient_id: parsed.data.patientId ?? undefined,
        affiliate_number: parsed.data.affiliateNumber ?? undefined,
      },
    });
  } finally {
    pruebaEnVuelo.delete(user.id);
  }

  if (resultado.noAutenticado) {
    // Error de configuración (clave inválida): registrado a nivel error para
    // que los administradores lo vean; nunca se registra la clave.
    req.log.error(
      { requestId, admin: user.email },
      "robot-klinicos: el Robot rechazó la clave de API (HTTP 401) — revisar ROBOT_API_KEY",
    );
  }

  req.log.info(
    {
      requestId,
      token: enmascararToken(token),
      estado: resultado.estado,
      latenciaMs: resultado.latenciaMs,
      admin: user.email,
    },
    "robot-klinicos: prueba de validación de token (solo admin)",
  );

  res.json({
    estado: resultado.estado,
    mensaje: resultado.mensaje,
    requestId,
    referenciaKlinicos: resultado.referenciaKlinicos,
    latenciaMs: resultado.latenciaMs,
    codigo: resultado.codigo ?? null,
    camposFaltantes: resultado.camposFaltantes ?? [],
    numeroAutorizacion: resultado.numeroAutorizacion ?? null,
    noAutenticado: resultado.noAutenticado ?? false,
    posicionCola: resultado.posicionCola ?? null,
    esperaEstimadaSegundos: resultado.esperaEstimadaSegundos ?? null,
  });
});

// ── GET /robot-klinicos/prueba/:requestId ────────────────────────────────
// Polling del estado de una solicitud asíncrona (PROCESSING). Conserva el
// MISMO request_id de la validación original: nunca re-valida el token.
// PROVISIONAL: consulta GET /token/requests/{id} del Robot, que todavía no
// está publicado (hoy 404 → TECHNICAL_ERROR "no disponible"). No conectar
// definitivamente hasta el OpenAPI final del Robot.
router.get("/robot-klinicos/prueba/:requestId", async (req, res) => {
  const user = await getUser(req);
  if (!user) return void res.status(401).json({ error: "No autenticado" });
  if (user.rol !== "admin")
    return void res.status(403).json({ error: "Solo administradores pueden usar la prueba" });

  const requestId = req.params.requestId?.trim();
  if (!requestId) return void res.status(400).json({ error: "requestId requerido" });

  const resultado = await consultarSolicitudToken(requestId);
  req.log.info(
    { requestId, estado: resultado.estado, latenciaMs: resultado.latenciaMs, admin: user.email },
    "robot-klinicos: polling de solicitud de validación (solo admin)",
  );
  res.json({
    estado: resultado.estado,
    mensaje: resultado.mensaje,
    requestId,
    referenciaKlinicos: resultado.referenciaKlinicos,
    latenciaMs: resultado.latenciaMs,
    codigo: resultado.codigo ?? null,
    camposFaltantes: resultado.camposFaltantes ?? [],
    numeroAutorizacion: resultado.numeroAutorizacion ?? null,
    noAutenticado: resultado.noAutenticado ?? false,
    posicionCola: resultado.posicionCola ?? null,
    esperaEstimadaSegundos: resultado.esperaEstimadaSegundos ?? null,
  });
});

// ── Catálogos exportables para el mapeo del Robot (solo admins) ──────────
// El equipo del Robot necesita el catálogo de prácticas (código+descripción)
// y el de profesionales (ID, nombre, matrícula, especialidad) para armar el
// mapeo institucional. JSON por defecto; ?formato=csv descarga un CSV.

function csvEscape(v: string | number | null | undefined): string {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function responderCsv(res: Response, nombre: string, filas: (string | number)[][]): void {
  const cuerpo = filas.map((f) => f.map(csvEscape).join(",")).join("\r\n");
  res
    .header("content-type", "text/csv; charset=utf-8")
    .header("content-disposition", `attachment; filename="${nombre}"`)
    .send("\uFEFF" + cuerpo + "\r\n");
}

router.get("/robot-klinicos/catalogo/practicas", async (req, res) => {
  const user = await getUser(req);
  if (!user) return void res.status(401).json({ error: "No autenticado" });
  if (user.rol !== "admin")
    return void res.status(403).json({ error: "Solo administradores" });

  const filas = await db
    .select()
    .from(klinicosPracticas)
    .where(eq(klinicosPracticas.activo, true))
    .orderBy(klinicosPracticas.nombre);
  // Una entrada por código IOMA: el Robot mapea por código.
  const practicas = filas.flatMap((p) =>
    (p.codigos ?? []).map((codigo) => ({
      codigo,
      descripcion: p.nombre,
      categoria: p.categoria ?? null,
    })),
  );
  if (req.query.formato === "csv") {
    return void responderCsv(res, "catalogo_practicas.csv", [
      ["codigo", "descripcion", "categoria"],
      ...practicas.map((p) => [p.codigo, p.descripcion, p.categoria ?? ""]),
    ]);
  }
  res.json({ practicas });
});

router.get("/robot-klinicos/catalogo/profesionales", async (req, res) => {
  const user = await getUser(req);
  if (!user) return void res.status(401).json({ error: "No autenticado" });
  if (user.rol !== "admin")
    return void res.status(403).json({ error: "Solo administradores" });

  const filas = await db
    .select({
      id: profesionalesTable.id,
      nombre: profesionalesTable.nombre,
      apellido: profesionalesTable.apellido,
      matricula: profesionalesTable.matricula,
      matriculaEspecialista: profesionalesTable.matriculaEspecialista,
      klinicosEspecialidad: profesionalesTable.klinicosEspecialidad,
      especialidadNombre: especialidadesTable.nombre,
    })
    .from(profesionalesTable)
    .leftJoin(especialidadesTable, eq(profesionalesTable.especialidadId, especialidadesTable.id))
    .orderBy(profesionalesTable.apellido, profesionalesTable.nombre);
  const profesionales = filas.map((p) => ({
    id: p.id,
    nombre: [p.apellido, p.nombre].filter(Boolean).join(", "),
    matricula: p.matricula ?? p.matriculaEspecialista ?? null,
    especialidad: p.klinicosEspecialidad ?? p.especialidadNombre ?? null,
  }));
  if (req.query.formato === "csv") {
    return void responderCsv(res, "catalogo_profesionales.csv", [
      ["id", "nombre", "matricula", "especialidad"],
      ...profesionales.map((p) => [p.id, p.nombre, p.matricula ?? "", p.especialidad ?? ""]),
    ]);
  }
  res.json({ profesionales });
});

// ── POST /robot-klinicos/prueba/prestacion-cargada ───────────────────────
// Auditoría de la contingencia en la pantalla de prueba: recepción/admin
// cargó la prestación a mano en KLINICOS. Registra usuario + fecha/hora,
// conserva el request_id y habilita el reintento. NO marca el token aceptado.
router.post("/robot-klinicos/prueba/prestacion-cargada", async (req, res) => {
  const user = await getUser(req);
  if (!user) return void res.status(401).json({ error: "No autenticado" });
  if (user.rol !== "admin")
    return void res.status(403).json({ error: "Solo administradores pueden usar la prueba" });

  const parsed = RegistrarPrestacionCargadaPruebaBody.safeParse(req.body);
  if (!parsed.success || !parsed.data.requestId.trim())
    return void res.status(400).json({ error: "requestId requerido" });

  const fecha = new Date();
  req.log.info(
    {
      requestId: parsed.data.requestId.trim(),
      usuario: user.email,
      fecha: fecha.toISOString(),
    },
    "robot-klinicos: prestación cargada manualmente en KLINICOS (pantalla de prueba)",
  );
  res.json({ registrado: true, usuario: user.email, fecha: fecha.toISOString() });
});

// ── GET /robot-klinicos/estado ───────────────────────────────────────────
router.get("/robot-klinicos/estado", async (req, res) => {
  const user = await getUser(req);
  if (!user) return void res.status(401).json({ error: "No autenticado" });
  if (!ROLES_LECTURA.includes(user.rol))
    return void res.status(403).json({ error: "Sin permisos" });
  const interna = validacionInternaDisponible();
  const habilitada = interna || validacionTokenHabilitada();
  // ?forzar=true (solo gestión, rol admin): descarta la caché de ~5 min y
  // reprueba las credenciales de Klinicos al momento. Pensado para cuando el
  // operador corrige la clave y quiere ver el verde sin esperar.
  const forzar = String(req.query.forzar ?? "").toLowerCase() === "true";
  if (forzar) {
    if (user.rol !== "admin")
      return void res
        .status(403)
        .json({ error: "Solo roles de gestión pueden forzar la reprueba" });
    _resetSaludKlinicosCache();
    req.log.info({ usuario: user.email }, "robot-klinicos: reprueba forzada de credenciales");
  }
  // Interno primero; con todo deshabilitado no se contacta a nadie.
  const estado = interna
    ? await internoTokenValidationProvider.checkRobotHealth()
    : habilitada
      ? await robotTokenValidationProvider.checkRobotHealth()
      : { disponible: false, sesionKlinicos: "desconocida", latenciaMs: null };
  // URL institucional de KLINICOS para la contingencia de carga manual
  // (botón "Abrir KLINICOS"): solo se expone si es una URL https segura.
  const urlCruda = process.env.KLINICOS_URL_INSTITUCIONAL?.trim();
  const klinicosUrl = urlCruda && /^https:\/\//i.test(urlCruda) ? urlCruda : null;
  res.json({
    disponible: estado.disponible,
    sesionKlinicos: estado.sesionKlinicos,
    latenciaMs: estado.latenciaMs,
    motivo: ("motivo" in estado ? (estado.motivo ?? null) : null),
    validacionHabilitada: habilitada,
    consultasProcessHabilitadas: consultasProcessHabilitadas(),
    klinicosUrl,
  });
});

// ── POST /turnos/:id/llamar ──────────────────────────────────────────────
// Llamar BLOQUEA al paciente (pedido jul 2026): el turno pasa a estado
// "llamado" (la UI lo muestra como EN CONSULTA) y ningún otro médico puede
// llamarlo hasta que el médico que lo llamó apriete "Finalizar Consulta".
// El mismo médico sí puede volver a llamarlo (re-anuncio en la TV). El
// bloqueo es atómico: la condición va en el UPDATE para ganar la carrera
// entre dos médicos que llaman a la vez.
router.post("/turnos/:id/llamar", async (req, res) => {
  const turnoId = Number(req.params.id);
  const quien = await getUser(req);
  const profIdRaw = quien?.profesionalId != null ? Number(quien.profesionalId) : null;
  const profId =
    quien?.rol === "medico" && profIdRaw != null && Number.isInteger(profIdRaw) ? profIdRaw : null;

  // Aviso amable ANTES del update atómico: si ya está en consulta con otro
  // médico, 409 con el detalle. (La carrera igual la resuelve el UPDATE.)
  if (Number.isInteger(turnoId) && turnoId > 0) {
    const [actual] = await db
      .select({
        estado: turnosTable.estado,
        llamadoPor: turnosTable.llamadoPorProfesionalId,
      })
      .from(turnosTable)
      .where(eq(turnosTable.id, turnoId))
      .limit(1);
    if (
      actual &&
      actual.estado === "llamado" &&
      actual.llamadoPor != null &&
      actual.llamadoPor !== profId
    ) {
      res.status(409).json({
        error: "El paciente ya está en consulta con otro médico",
        codigo: "paciente_en_consulta",
      });
      return;
    }
  }

  return transicionar(req, res, {
    estadosPermitidos: [...LLAMABLES, "llamado"],
    nuevoEstado: "llamado",
    accion: "llamar",
    timestampField: "llamadoEn",
    permitirMedico: true,
    // Guard atómico anti-carrera: si ya está "llamado", solo puede volver a
    // llamar el mismo médico (o staff si lo había llamado staff).
    condicionExtra: sql`(${turnosTable.estado} <> 'llamado' OR ${turnosTable.llamadoPorProfesionalId} IS NOT DISTINCT FROM ${profId})`,
    // Quién llamó: si es un médico con ficha, se persiste para que la TV
    // resuelva su consultorio aunque el turno de guardia no tenga profesional
    // propio ni titular de agenda. Si llama staff, se limpia (el último
    // llamado manda).
    // llamadoPractica se limpia: un llamado interno no debe arrastrar el texto
    // de práctica que haya dejado un llamado anterior desde Pixel.
    updateExtra: () => ({ llamadoPorProfesionalId: profId, llamadoPractica: null }),
  });
});

// ── POST /turnos/:id/devolver-sala ───────────────────────────────────────
// Destrabar un paciente que quedó EN CONSULTA (pedido jul 2026): si un médico
// lo llamó por error o se olvidó de finalizar, recepción/gerencia lo devuelve
// a la sala de espera con un clic. Limpia el bloqueo (llamadoPorProfesionalId)
// y el timestamp del llamado para que salga de la pantalla TV y de la ventana
// de "llamado" de la UI. Queda auditado quién lo destrabó y qué médico lo tenía.
// También puede el propio médico (ago 2026): si llamó por error, devuelve al
// paciente sin computar atención — pero SOLO turnos que él mismo llamó.
router.post("/turnos/:id/devolver-sala", async (req, res) => {
  const quien = await getUser(req);
  const profIdRaw = quien?.profesionalId != null ? Number(quien.profesionalId) : null;
  const profId =
    quien?.rol === "medico" && profIdRaw != null && Number.isInteger(profIdRaw) ? profIdRaw : null;
  return transicionar(req, res, {
    estadosPermitidos: ["llamado"],
    nuevoEstado: "en_sala",
    accion: "devolver_sala",
    permitirMedico: true,
    // El médico solo destraba sus propios llamados; staff destraba cualquiera.
    condicionExtra:
      quien?.rol === "medico"
        ? sql`${turnosTable.llamadoPorProfesionalId} IS NOT DISTINCT FROM ${profId}`
        : undefined,
    updateExtra: () => ({ llamadoPorProfesionalId: null, llamadoEn: null }),
    detalleExtra: async (turno) => ({
      llamadoPorProfesionalId: turno.llamadoPorProfesionalId ?? null,
      motivo: "destrabar_en_consulta",
    }),
  });
});

// ── POST /turnos/:id/atender ─────────────────────────────────────────────
router.post("/turnos/:id/atender", (req, res) =>
  transicionar(req, res, {
    estadosPermitidos: ATENDIBLES,
    nuevoEstado: "en_atencion",
    accion: "atender",
    timestampField: "atendidoEn",
  }),
);

// ── POST /turnos/:id/no-presentado ───────────────────────────────────────
router.post("/turnos/:id/no-presentado", (req, res) =>
  transicionar(req, res, {
    estadosPermitidos: AUSENTABLES,
    nuevoEstado: "ausente",
    accion: "no_presentado",
  }),
);

// ── POST /turnos/:id/cancelar ────────────────────────────────────────────
// El paciente cancela su propio turno desde el portal; staff puede cancelar
// cualquiera. Solo estados previos a la atención; libera el slot (la
// disponibilidad excluye turnos cancelados) y queda auditado.
const CANCELABLES = ["pendiente", "reservado", "confirmado", "publicado", "arribo", "en_sala", "llamado"];
const ROLES_CANCELACION_STAFF = ["admin", "recepcionista"];

router.post("/turnos/:id/cancelar", async (req, res): Promise<void> => {
  const user = await getUser(req);
  if (!user) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }

  const esStaff = ROLES_CANCELACION_STAFF.includes(user.rol);
  const esPaciente = user.rol === "paciente";
  // El médico puede cancelar (ej. llamó al paciente y no vino), pero solo
  // turnos de sus propias agendas.
  const esMedico = user.rol === "medico" && user.profesionalId != null;
  if (!esStaff && !esPaciente && !esMedico) {
    res.status(403).json({ error: "Sin permisos para cancelar turnos" });
    return;
  }

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "ID inválido" });
    return;
  }

  const [turno] = await db.select().from(turnosTable).where(eq(turnosTable.id, id)).limit(1);
  if (!turno) {
    res.status(404).json({ error: "Turno no encontrado" });
    return;
  }

  if (esPaciente) {
    const pacienteId = Number(user.pacienteId);
    if (!user.pacienteId || !Number.isInteger(pacienteId) || turno.pacienteId !== pacienteId) {
      res.status(403).json({ error: "Solo podés cancelar tus propios turnos" });
      return;
    }
  }

  if (esMedico && !esStaff) {
    const ids = await turneraIdsDelProfesional(Number(user.profesionalId));
    if (turno.turneraId == null || !ids.includes(turno.turneraId)) {
      res.status(403).json({ error: "El turno no pertenece a tus agendas" });
      return;
    }
  }

  // Transición atómica: la condición de estado va en el UPDATE
  const [updated] = await db
    .update(turnosTable)
    .set({ estado: "cancelado" })
    .where(and(eq(turnosTable.id, id), inArray(turnosTable.estado, CANCELABLES)))
    .returning();

  if (!updated) {
    const [actual] = await db
      .select({ estado: turnosTable.estado })
      .from(turnosTable)
      .where(eq(turnosTable.id, id))
      .limit(1);
    res.status(422).json({
      error: `El turno ya no se puede cancelar (estado actual: ${actual?.estado ?? turno.estado})`,
      estadosPermitidos: CANCELABLES,
    });
    return;
  }

  await registrarEventoTurnoRobot(id, "cancelacion");
  // Guardia virtual: avisar la cancelación al portal (fire-and-forget).
  void notificarEventoVideollamadaPorTurno(id, "cancelada", "El turno fue cancelado");
  void avanzarFilaGuardia(id);
  // App del paciente: avisar solo cuando cancela la clínica (si lo canceló el
  // propio paciente, el portal ya lo sabe: lo originó él).
  if (!esPaciente) void encolarAvisoTurno(id, "cancelado");

  await registrarAuditoria(user, "cancelar", id, turno.pacienteId, {
    estadoAnterior: turno.estado,
    estadoNuevo: "cancelado",
    origen: esPaciente ? "portal_paciente" : "staff",
  });

  req.log.info(
    { turnoId: id, estadoAnterior: turno.estado, estadoNuevo: "cancelado", usuario: user.email },
    "sala-espera: cancelar",
  );

  res.json(updated);
});

// ── POST /turnos/:id/reprogramar ─────────────────────────────────────────
// El paciente reprograma su propio turno a otro slot de la MISMA turnera;
// staff puede reprogramar cualquiera. Cancela el turno viejo y crea el nuevo
// en UNA transacción (sin escrituras parciales), validando que el slot sea
// válido para la turnera y esté libre. Todo queda auditado.
router.post("/turnos/:id/reprogramar", async (req, res): Promise<void> => {
  const user = await getUser(req);
  if (!user) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }

  const esStaff = ROLES_CANCELACION_STAFF.includes(user.rol);
  const esPaciente = user.rol === "paciente";
  if (!esStaff && !esPaciente) {
    res.status(403).json({ error: "Sin permisos para reprogramar turnos" });
    return;
  }

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "ID inválido" });
    return;
  }

  const parsed = ReprogramarTurnoBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  // Zod codegen entrega Date para campos fecha: convertir a YYYY-MM-DD
  const nuevaFecha =
    parsed.data.fecha instanceof Date
      ? parsed.data.fecha.toISOString().split("T")[0]!
      : String(parsed.data.fecha);
  const nuevaHora = parsed.data.horaInicio.substring(0, 5);
  if (!/^\d{2}:\d{2}$/.test(nuevaHora)) {
    res.status(400).json({ error: "Hora inválida (formato HH:MM)" });
    return;
  }

  const [turno] = await db.select().from(turnosTable).where(eq(turnosTable.id, id)).limit(1);
  if (!turno) {
    res.status(404).json({ error: "Turno no encontrado" });
    return;
  }

  if (esPaciente) {
    const pacienteId = Number(user.pacienteId);
    if (!user.pacienteId || !Number.isInteger(pacienteId) || turno.pacienteId !== pacienteId) {
      res.status(403).json({ error: "Solo podés reprogramar tus propios turnos" });
      return;
    }
  }

  const [turnera] = await db
    .select()
    .from(turnerasTable)
    .where(eq(turnerasTable.id, turno.turneraId))
    .limit(1);
  if (!turnera) {
    res.status(422).json({ error: "La turnera del turno ya no existe" });
    return;
  }

  // Validar que el slot pedido sea un slot real de la turnera
  const diaSemana = new Date(`${nuevaFecha}T00:00:00`).getDay();
  const diasArray = turnera.diasAtencion ? turnera.diasAtencion.split(",").map(Number) : [];
  if (!diasArray.includes(diaSemana)) {
    res.status(422).json({ error: "La turnera no atiende ese día" });
    return;
  }

  const [hIni, mIni] = turnera.horaInicio.split(":").map(Number);
  const [hFin, mFin] = turnera.horaFin.split(":").map(Number);
  const [hSlot, mSlot] = nuevaHora.split(":").map(Number);
  const inicioMin = hIni! * 60 + mIni!;
  const finMin = hFin! * 60 + mFin!;
  const slotMin = hSlot! * 60 + mSlot!;
  const duracion = turnera.duracionMinutos;
  if (
    slotMin < inicioMin ||
    slotMin + duracion > finMin ||
    (slotMin - inicioMin) % duracion !== 0
  ) {
    res.status(422).json({ error: "El horario no corresponde a un slot válido de la turnera" });
    return;
  }

  // El nuevo turno debe ser a futuro
  const inicioNuevo = new Date(`${nuevaFecha}T${nuevaHora}:00`);
  if (inicioNuevo.getTime() <= Date.now()) {
    res.status(422).json({ error: "El nuevo horario debe ser en el futuro" });
    return;
  }

  const finTotalMin = slotMin + duracion;
  const nuevaHoraFin = `${Math.floor(finTotalMin / 60)
    .toString()
    .padStart(2, "0")}:${(finTotalMin % 60).toString().padStart(2, "0")}`;

  // Cobertura efectiva para el control de obra social/cupo: la del turno o,
  // si no tiene, la de la ficha del paciente.
  let coberturaReprogramacion: string | null = turno.cobertura ?? null;
  if (!coberturaReprogramacion && turno.pacienteId != null) {
    const [pac] = await db.select({ cobertura: pacientesTable.cobertura })
      .from(pacientesTable).where(eq(pacientesTable.id, turno.pacienteId)).limit(1);
    coberturaReprogramacion = pac?.cobertura ?? null;
  }

  // Cancelación del viejo + creación del nuevo en UNA transacción:
  // si el slot está ocupado o el turno ya no es cancelable, no queda nada a medias.
  let resultado:
    | { ok: true; turnoAnterior: typeof turno; turnoNuevo: typeof turno }
    | { ok: false; status: number; error: string };
  try {
    resultado = await db.transaction(async (tx) => {
      // Advisory lock ANTES de tocar filas: mismo orden de locks que
      // reservarConCupo (advisory → filas) para evitar deadlocks cruzados
      // con reservas concurrentes sobre la misma agenda+fecha.
      await lockCupoObraSocial(tx, turno.turneraId, nuevaFecha);

      // Transición atómica: la condición de estado va dentro del UPDATE
      const [cancelado] = await tx
        .update(turnosTable)
        .set({ estado: "cancelado" })
        .where(and(eq(turnosTable.id, id), inArray(turnosTable.estado, CANCELABLES)))
        .returning();

      if (!cancelado) {
        return {
          ok: false as const,
          status: 422,
          error: "El turno ya no se puede reprogramar (fue atendido, cancelado o está en curso)",
        };
      }

      // El slot destino debe estar libre (excluye cancelados/ausentes)
      const enElSlot = await tx
        .select({ id: turnosTable.id, estado: turnosTable.estado })
        .from(turnosTable)
        .where(
          and(
            eq(turnosTable.turneraId, turno.turneraId),
            eq(turnosTable.fecha, nuevaFecha),
            eq(turnosTable.horaInicio, nuevaHora),
          ),
        );
      const hayConflicto = enElSlot.some((t) => !["cancelado", "ausente"].includes(t.estado));
      if (hayConflicto) {
        // Rollback: el turno original queda como estaba
        throw Object.assign(new Error("SLOT_OCUPADO"), { codigo: "SLOT_OCUPADO" });
      }

      // Obras sociales de la agenda: la nueva fecha también debe respetar el
      // listado y el cupo diario (advisory lock ya tomado al inicio de la tx;
      // el turno viejo ya está cancelado en esta tx, no se cuenta a sí mismo).
      const cupo = await verificarCupoObraSocial(
        { turneraId: turno.turneraId, fecha: nuevaFecha, cobertura: coberturaReprogramacion },
        tx,
      );
      if (!cupo.ok) {
        // Rollback: el turno original queda como estaba
        throw Object.assign(new Error(cupo.error), { codigo: "CUPO_OS", status: cupo.status });
      }

      const [nuevo] = await tx
        .insert(turnosTable)
        .values({
          turneraId: turno.turneraId,
          pacienteId: turno.pacienteId,
          profesionalId: turno.profesionalId ?? undefined,
          fecha: nuevaFecha,
          horaInicio: nuevaHora,
          horaFin: nuevaHoraFin,
          estado: "pendiente",
          modalidad: turno.modalidad,
          motivoConsulta: turno.motivoConsulta ?? undefined,
          // La región anatómica se conserva al reprogramar: es obligatoria en
          // prácticas y el PACS la recibe como body_part.
          regionAnatomica: turno.regionAnatomica ?? undefined,
          observaciones: turno.observaciones ?? undefined,
          cobertura: turno.cobertura ?? undefined,
          nroAfiliado: turno.nroAfiliado ?? undefined,
          creadoPor: user.email,
        })
        .returning();

      // Auditoría dentro de la transacción: ambas entradas o ninguna
      await tx.insert(auditLogTable).values([
        {
          usuarioId: user.id,
          usuarioEmail: user.email,
          rol: user.rol,
          accion: "reprogramar_cancelacion",
          entidad: "turno",
          entidadId: id,
          pacienteId: turno.pacienteId,
          detalle: {
            estadoAnterior: turno.estado,
            estadoNuevo: "cancelado",
            motivo: "reprogramacion",
            turnoNuevoId: nuevo!.id,
            origen: esPaciente ? "portal_paciente" : "staff",
          },
        },
        {
          usuarioId: user.id,
          usuarioEmail: user.email,
          rol: user.rol,
          accion: "reprogramar",
          entidad: "turno",
          entidadId: nuevo!.id,
          pacienteId: turno.pacienteId,
          detalle: {
            turnoAnteriorId: id,
            fechaAnterior: turno.fecha,
            horaAnterior: turno.horaInicio,
            fechaNueva: nuevaFecha,
            horaNueva: nuevaHora,
            origen: esPaciente ? "portal_paciente" : "staff",
          },
        },
      ]);

      return { ok: true as const, turnoAnterior: cancelado, turnoNuevo: nuevo! };
    });
  } catch (err) {
    if ((err as { codigo?: string })?.codigo === "SLOT_OCUPADO") {
      res.status(409).json({ error: "El horario elegido ya no está disponible. Elegí otro." });
      return;
    }
    if ((err as { codigo?: string })?.codigo === "CUPO_OS") {
      const e = err as { status?: number; message: string };
      res.status(e.status ?? 409).json({ error: e.message });
      return;
    }
    throw err;
  }

  if (!resultado.ok) {
    res.status(resultado.status).json({ error: resultado.error });
    return;
  }

  // Eventos para el Robot Klinicos (fuera de la transacción, ya commiteada):
  // el turno viejo queda cancelado y el nuevo nace como alta.
  await registrarEventoTurnoRobot(id, "cancelacion");
  await registrarEventoTurnoRobot(resultado.turnoNuevo.id, "alta");

  // App del paciente: avisar la reprogramación solo cuando la hace la clínica.
  // Sale con el id del turno viejo (el que conoce el portal) y el horario nuevo.
  if (!esPaciente) {
    void encolarAvisoTurno(id, "reprogramado", {
      fecha: nuevaFecha,
      horaInicio: nuevaHora,
      fechaAnterior: turno.fecha,
      horaAnterior: turno.horaInicio,
      motivo: parsed.data.motivo?.trim() || undefined,
    });
  }

  // Aviso por WhatsApp con el nuevo horario (solo staff, opcional)
  if (esStaff && parsed.data.notificar && turno.pacienteId) {
    const [paciente] = await db
      .select({
        nombre: pacientesTable.nombre,
        apellido: pacientesTable.apellido,
        telefono: pacientesTable.telefono,
        telefonoAlternativo: pacientesTable.telefonoAlternativo,
      })
      .from(pacientesTable)
      .where(eq(pacientesTable.id, turno.pacienteId))
      .limit(1);
    const [sede] = turnera.sedeId
      ? await db.select({ nombre: sedesTable.nombre }).from(sedesTable).where(eq(sedesTable.id, turnera.sedeId)).limit(1)
      : [];
    const telefono = paciente?.telefono ?? paciente?.telefonoAlternativo ?? null;
    const motivoTexto = parsed.data.motivo?.trim() ? ` (motivo: ${parsed.data.motivo.trim()})` : "";
    const contenido = renderPlantilla(PLANTILLA_REPROGRAMACION_DEFAULT, {
      nombre: paciente?.nombre || "paciente",
      clinica: "Diagnosticar",
      turnera: turnera.nombre,
      sede: sede?.nombre ?? "la sede",
      fechaAnterior: turno.fecha,
      horaAnterior: turno.horaInicio,
      fecha: nuevaFecha,
      hora: nuevaHora,
      motivo: motivoTexto,
    });

    let estadoEntrega = "simulada";
    let errorDetalle: string | null = null;
    if (!telefono) {
      estadoEntrega = "fallida";
      errorDetalle = "El paciente no tiene teléfono registrado";
    } else {
      const r = await enviarWhatsappWhaticket(telefono, contenido, req.log);
      estadoEntrega = r.estado;
      if (r.estado === "fallida") errorDetalle = r.error;
    }

    await db.insert(notificacionesSalientesTable).values({
      patientId: turno.pacienteId,
      turnoId: resultado.turnoNuevo.id,
      canal: "whatsapp",
      evento: "turno_reprogramado",
      destinatario: telefono,
      contenido,
      estadoEntrega,
      errorDetalle,
      template: "reprogramacion_turno",
      usuarioOrigenId: user.id,
    });
  }

  req.log.info(
    {
      turnoAnteriorId: id,
      turnoNuevoId: resultado.turnoNuevo.id,
      fechaNueva: nuevaFecha,
      horaNueva: nuevaHora,
      usuario: user.email,
    },
    "sala-espera: reprogramar",
  );

  res.json({ turnoAnterior: resultado.turnoAnterior, turnoNuevo: resultado.turnoNuevo });
});

// ── GET /admision/buscar?q= ──────────────────────────────────────────────
router.get("/admision/buscar", async (req, res): Promise<void> => {
  const user = await getUser(req);
  if (!user) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }
  if (!ROLES_OPERACION.includes(user.rol)) {
    res.status(403).json({ error: "Sin permisos" });
    return;
  }

  const q = String(req.query.q ?? "").trim();
  if (q.length < 2) {
    res.json([]);
    return;
  }

  const pattern = `%${q}%`;
  const buscaSinAcentos = (col: typeof pacientesTable.nombre | typeof pacientesTable.apellido) =>
    sql`unaccent(${col}) ILIKE unaccent(${pattern})`;
  const pacientes = await db
    .select()
    .from(pacientesTable)
    .where(
      and(
        eq(pacientesTable.activo, true),
        or(
          buscaSinAcentos(pacientesTable.nombre),
          buscaSinAcentos(pacientesTable.apellido),
          ilike(pacientesTable.dni, pattern),
          ilike(pacientesTable.numeroHc, pattern),
          ilike(pacientesTable.telefono, pattern),
          ilike(pacientesTable.telefonoAlternativo, pattern),
        ),
      ),
    )
    .limit(10);

  if (pacientes.length === 0) {
    res.json([]);
    return;
  }

  const turnosHoy = await db
    .select({
      turno: turnosTable,
      turnera: turnerasTable,
      profesional: profesionalesTable,
    })
    .from(turnosTable)
    .innerJoin(turnerasTable, eq(turnosTable.turneraId, turnerasTable.id))
    .leftJoin(profesionalesTable, eq(turnosTable.profesionalId, profesionalesTable.id))
    .where(
      and(
        eq(turnosTable.fecha, hoy()),
        inArray(
          turnosTable.pacienteId,
          pacientes.map((p) => p.id),
        ),
      ),
    )
    .orderBy(turnosTable.horaInicio);

  const resultado = pacientes.map((paciente) => ({
    paciente,
    turnosHoy: turnosHoy
      .filter((t) => t.turno.pacienteId === paciente.id)
      .map((t) => ({ ...t.turno, turnera: t.turnera, profesional: t.profesional })),
  }));

  res.json(resultado);
});

// ── GET /sala-espera/cola ────────────────────────────────────────────────
const ESTADOS_COLA = ["arribo", "en_sala", "llamado", "en_atencion"];

router.get("/sala-espera/cola", async (req, res): Promise<void> => {
  const user = await getUser(req);
  if (!user) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }
  if (!ROLES_LECTURA.includes(user.rol)) {
    res.status(403).json({ error: "Sin permisos" });
    return;
  }

  // En guardia, los "confirmado" (agendados por la app, todavía sin llegar)
  // también ocupan lugar en la fila; en agendas comunes no entran a la cola.
  const conditions = [
    eq(turnosTable.fecha, hoy()),
    or(
      inArray(turnosTable.estado, ESTADOS_COLA),
      and(eq(turnosTable.estado, "confirmado"), eq(turnerasTable.esGuardia, true)),
    )!,
  ];

  const turneraId = req.query.turneraId ? Number(req.query.turneraId) : undefined;
  if (turneraId && Number.isInteger(turneraId)) {
    conditions.push(eq(turnosTable.turneraId, turneraId));
  }

  // Un médico ve en la cola: turnos asignados a él, turnos de sus turneras
  // (propias o grupales donde participa) y la bolsa de guardia (los turnos de
  // demanda espontánea entran SIN médico asignado, así que filtrar solo por
  // turnos.profesional_id dejaba la sala vacía para los médicos de guardia).
  if (user.rol === "medico") {
    const profId = Number(user.profesionalId);
    if (!user.profesionalId || !Number.isInteger(profId)) {
      res.json([]);
      return;
    }
    const [propias, guardias] = await Promise.all([
      turneraIdsDelProfesional(profId),
      // Sin filtrar por activa: hay turneras de guardia desactivadas (duplicadas)
      // que igual reciben pacientes; esos turnos deben verse en la sala.
      db
        .select({ id: turnerasTable.id })
        .from(turnerasTable)
        .where(eq(turnerasTable.esGuardia, true)),
    ]);
    const permitidas = [...new Set([...propias, ...guardias.map((g) => g.id)])];
    conditions.push(
      permitidas.length
        ? or(eq(turnosTable.profesionalId, profId), inArray(turnosTable.turneraId, permitidas))!
        : eq(turnosTable.profesionalId, profId),
    );
  }

  const rows = await db
    .select({
      turno: turnosTable,
      paciente: pacientesTable,
      turnera: turnerasTable,
      profesional: profesionalesTable,
    })
    .from(turnosTable)
    .innerJoin(pacientesTable, eq(turnosTable.pacienteId, pacientesTable.id))
    .innerJoin(turnerasTable, eq(turnosTable.turneraId, turnerasTable.id))
    .leftJoin(profesionalesTable, eq(turnosTable.profesionalId, profesionalesTable.id))
    .where(and(...conditions))
    .orderBy(turnosTable.horaInicio);

  const ahora = Date.now();

  // Todos los estudios de cada turno (turno_practicas), en una sola consulta
  const practicasPorTurno = new Map<number, string[]>();
  const turnoIdsCola = rows.map((r) => r.turno.id);
  if (turnoIdsCola.length > 0) {
    const filasPracticas = await db
      .select({
        turnoId: turnoPracticasTable.turnoId,
        filaId: turnoPracticasTable.id,
        nombre: klinicosPracticas.nombre,
      })
      .from(turnoPracticasTable)
      .innerJoin(klinicosPracticas, eq(klinicosPracticas.id, turnoPracticasTable.klinicosPracticaId))
      .where(inArray(turnoPracticasTable.turnoId, turnoIdsCola))
      .orderBy(turnoPracticasTable.id);
    for (const f of filasPracticas) {
      const lista = practicasPorTurno.get(f.turnoId) ?? [];
      lista.push(f.nombre);
      practicasPorTurno.set(f.turnoId, lista);
    }
  }

  // Espera estimada por paciente, mismo cálculo que ve el paciente en /mi-turno:
  // ritmo real del día con fallback a la duración configurada de la turnera.
  const turneraIdsCola = Array.from(new Set(rows.map((r) => r.turnera.id)));
  // Guardias/demanda espontánea suelen no tener duración configurada: piso de
  // 15 min por paciente para que la demora estimada nunca quede vacía.
  const duracionPorTurnera = new Map<number, number | null | undefined>(
    rows.map((r) => [r.turnera.id, r.turnera.duracionMinutos ?? (r.turnera.esGuardia ? 15 : null)]),
  );
  const estimador = await crearEstimadorEspera(hoy(), turneraIdsCola, duracionPorTurnera);

  // Posición en la cola por turnera (solo cuentan los que siguen en espera)
  const posicionPorTurno = new Map<number, number>();
  const contadorPorTurnera = new Map<number, number>();
  for (const { turno, turnera } of rows) {
    const agendadoGuardia = turno.estado === "confirmado" && turnera.esGuardia;
    if (!ESTADOS_EN_ESPERA.includes(turno.estado) && !agendadoGuardia) continue;
    const pos = (contadorPorTurnera.get(turno.turneraId) ?? 0) + 1;
    contadorPorTurnera.set(turno.turneraId, pos);
    posicionPorTurno.set(turno.id, pos);
  }

  const cola = rows.map(({ turno, paciente, turnera, profesional }) => ({
    turnoId: turno.id,
    horaInicio: turno.horaInicio,
    estado: turno.estado,
    pacienteId: paciente.id,
    pacienteNombre: paciente.nombre,
    pacienteApellido: paciente.apellido,
    numeroHc: paciente.numeroHc,
    turneraId: turnera.id,
    turneraNombre: turnera.nombre,
    profesionalNombre: profesional
      ? `${profesional.nombre}${profesional.apellido ? ` ${profesional.apellido}` : ""}`
      : null,
    modalidad: turno.modalidad,
    sobreturno: turno.sobreturno,
    marcaColor: turno.marcaColor ?? null,
    admitidoPor: turno.admitidoPor ?? null,
    admitidoEn: turno.admitidoEn,
    llamadoEn: turno.llamadoEn,
    llamadoPorProfesionalId: turno.llamadoPorProfesionalId ?? null,
    esperaMinutos: turno.admitidoEn
      ? Math.max(0, Math.round((ahora - turno.admitidoEn.getTime()) / 60000))
      : null,
    esperaEstimadaMinutos: posicionPorTurno.has(turno.id)
      ? estimador.estimar(turno.turneraId, posicionPorTurno.get(turno.id)!)
      : null,
    practicas: practicasPorTurno.get(turno.id) ?? [],
    videollamadaUrl: urlVideollamadaTurno(turno),
    // Check in previo: el paciente reservó su lugar desde la app (guardia
    // presencial) y todavía no llegó a la clínica. La UI muestra la pastilla
    // "Check in" en lugar de la de reservado/agendado.
    checkInPrevio:
      turno.estado === "confirmado" && turnera.esGuardia && turno.modalidad === "presencial",
  }));

  res.json(cola);
});

// ── GET /sala-espera/pantalla (para TV/kiosco, acceso público) ─────────────
// Muestra nombre y apellido completos en la pantalla, pedido del usuario.
function nombreParcial(nombre: string, apellido: string): string {
  const ape = apellido.trim();
  return ape ? `${nombre} ${ape}` : nombre;
}

router.get("/sala-espera/pantalla", async (req, res): Promise<void> => {
  const conditions = [
    eq(turnosTable.fecha, hoy()),
    inArray(turnosTable.estado, ["arribo", "en_sala", "llamado"]),
  ];

  // Filtros opcionales para pantallas por consultorio (turnera), sector (sede)
  // o sala de llamado (la sala que eligió cada médico en su perfil)
  const turneraId = req.query.turneraId ? Number(req.query.turneraId) : undefined;
  const sedeId = req.query.sedeId ? Number(req.query.sedeId) : undefined;
  const salaId = req.query.salaId ? Number(req.query.salaId) : undefined;

  let filtroNombre: string | null = null;
  if (salaId && Number.isInteger(salaId) && salaId > 0) {
    const [sala] = await db
      .select({ nombre: salasLlamadoTable.nombre })
      .from(salasLlamadoTable)
      .where(eq(salasLlamadoTable.id, salaId))
      .limit(1);
    filtroNombre = sala?.nombre ?? null;
  } else if (turneraId && Number.isInteger(turneraId) && turneraId > 0) {
    conditions.push(eq(turnosTable.turneraId, turneraId));
    const [turnera] = await db
      .select({ nombre: turnerasTable.nombre })
      .from(turnerasTable)
      .where(eq(turnerasTable.id, turneraId))
      .limit(1);
    filtroNombre = turnera?.nombre ?? null;
  } else if (sedeId && Number.isInteger(sedeId) && sedeId > 0) {
    conditions.push(eq(turnerasTable.sedeId, sedeId));
    const [sede] = await db
      .select({ nombre: sedesTable.nombre })
      .from(sedesTable)
      .where(eq(sedesTable.id, sedeId))
      .limit(1);
    filtroNombre = sede?.nombre ?? null;
  }

  let rows = await db
    .select({
      turno: turnosTable,
      paciente: pacientesTable,
      turnera: turnerasTable,
      profesional: profesionalesTable,
      consultorio: consultoriosTable,
    })
    .from(turnosTable)
    .innerJoin(pacientesTable, eq(turnosTable.pacienteId, pacientesTable.id))
    .innerJoin(turnerasTable, eq(turnosTable.turneraId, turnerasTable.id))
    // Precedencia para resolver al médico (y su consultorio): quién llamó →
    // profesional del turno → titular de la agenda. Así en guardia/demanda
    // espontánea (turno sin médico y agenda sin titular) la TV igual muestra
    // el consultorio del médico que llamó.
    .leftJoin(
      profesionalesTable,
      eq(
        profesionalesTable.id,
        sql`coalesce(${turnosTable.llamadoPorProfesionalId}, ${turnosTable.profesionalId}, ${turnerasTable.profesionalId})`,
      ),
    )
    .leftJoin(consultoriosTable, eq(profesionalesTable.consultorioId, consultoriosTable.id))
    .where(and(...conditions))
    .orderBy(turnosTable.horaInicio);

  // Pantalla por sala de llamado: la sala del médico (si eligió una) tiene
  // precedencia; si no, vale la sala asociada a la agenda. Así la TV de
  // Pediatría muestra a los pacientes en espera de las agendas de Pediatría
  // aunque el médico todavía no haya elegido su sala.
  if (salaId && Number.isInteger(salaId) && salaId > 0) {
    rows = rows.filter((r) => (r.profesional?.salaLlamadoId ?? r.turnera.salaLlamadoId) === salaId);
  }

  // Llamados recientes: llamar no cambia el estado del turno, así que se
  // detectan por el timestamp llamadoEn (últimos 15 minutos).
  const corteLlamados = Date.now() - 15 * 60 * 1000;
  const llamados = rows
    .filter((r) => r.turno.llamadoEn && r.turno.llamadoEn.getTime() >= corteLlamados)
    .sort((a, b) => (b.turno.llamadoEn?.getTime() ?? 0) - (a.turno.llamadoEn?.getTime() ?? 0))
    .slice(0, 5)
    .map(({ turno, paciente, turnera, profesional, consultorio }) => ({
      turnoId: turno.id,
      paciente: nombreParcial(paciente.nombre, paciente.apellido),
      // Si el llamado vino de Pixel con la práctica del estudio, la TV muestra
      // ese texto en lugar del nombre de la agenda (pedido de Pixel ago 2026).
      turneraNombre: turno.llamadoPractica ?? turnera.nombre,
      profesionalNombre: profesional
        ? `${profesional.nombre}${profesional.apellido ? ` ${profesional.apellido}` : ""}`
        : null,
      consultorioNombre: consultorio?.nombre ?? null,
      llamadoEn: turno.llamadoEn,
    }));

  // Los recién llamados no se listan también como "en espera" en la TV
  const filasEnEspera = rows.filter(
    (r) =>
      ["arribo", "en_sala"].includes(r.turno.estado) &&
      !(r.turno.llamadoEn && r.turno.llamadoEn.getTime() >= corteLlamados),
  );

  // Espera estimada por paciente, mismo cálculo que /mi-turno y /sala-espera/cola
  const turneraIdsPantalla = Array.from(new Set(filasEnEspera.map((r) => r.turnera.id)));
  const duracionPorTurneraPantalla = new Map<number, number | null | undefined>(
    filasEnEspera.map((r) => [r.turnera.id, r.turnera.duracionMinutos ?? (r.turnera.esGuardia ? 15 : null)]),
  );
  const estimadorPantalla = await crearEstimadorEspera(
    hoy(),
    turneraIdsPantalla,
    duracionPorTurneraPantalla,
  );

  const posicionPorTurnera = new Map<number, number>();
  // Se listan TODOS los pacientes en espera: el paciente ve que ya está
  // recepcionado y cuántos tiene adelante.
  const enEspera = filasEnEspera.map(({ turno, paciente, turnera }) => {
    const pos = (posicionPorTurnera.get(turnera.id) ?? 0) + 1;
    posicionPorTurnera.set(turnera.id, pos);
    return {
      turnoId: turno.id,
      paciente: nombreParcial(paciente.nombre, paciente.apellido),
      turneraNombre: turnera.nombre,
      horaInicio: turno.horaInicio,
      esperaEstimadaMinutos: estimadorPantalla.estimar(turnera.id, pos),
    };
  });

  res.json({ llamados, enEspera, actualizadoEn: new Date().toISOString(), filtroNombre });
});

// ── Vinculación de pantallas TV por código corto ─────────────────────────
// La TV en /tv genera un código de 6 caracteres y lo muestra en pantalla.
// Recepción lo canjea asignándole una sede/turnera, y la TV (que consulta por
// polling) se entera y pasa sola a la pantalla correcta. Los códigos viven en
// config_sistema (sin tabla nueva) y expiran a los pocos minutos.
const TV_CODIGO_PREFIJO = "tv_vinculo_";
const TV_CODIGO_TTL_MS = 5 * 60 * 1000;
// Sin caracteres ambiguos (0/O, 1/I/L) para tipear fácil con control remoto
const TV_CODIGO_ALFABETO = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

type TvVinculo = {
  estado: "pendiente" | "asignado";
  expiraEn: string;
  sedeId?: number | null;
  turneraId?: number | null;
  salaId?: number | null;
};

function generarCodigoTv(): string {
  let codigo = "";
  for (let i = 0; i < 6; i++) {
    codigo += TV_CODIGO_ALFABETO[randomInt(TV_CODIGO_ALFABETO.length)];
  }
  return codigo;
}

function normalizarCodigoTv(crudo: unknown): string | null {
  const codigo = String(crudo ?? "").trim().toUpperCase();
  return /^[A-Z0-9]{6}$/.test(codigo) ? codigo : null;
}

async function leerVinculoTv(codigo: string): Promise<TvVinculo | null> {
  const [row] = await db
    .select({ valor: configSistemaTable.valor })
    .from(configSistemaTable)
    .where(eq(configSistemaTable.clave, `${TV_CODIGO_PREFIJO}${codigo}`))
    .limit(1);
  if (!row) return null;
  try {
    return JSON.parse(row.valor) as TvVinculo;
  } catch {
    return null;
  }
}

async function borrarVinculoTv(codigo: string): Promise<void> {
  await db
    .delete(configSistemaTable)
    .where(eq(configSistemaTable.clave, `${TV_CODIGO_PREFIJO}${codigo}`));
}

// POST /sala-espera/tv/codigo — la TV pide un código nuevo (público, como la pantalla)
router.post("/sala-espera/tv/codigo", async (_req, res): Promise<void> => {
  // Limpieza perezosa de códigos viejos (expirados hace rato)
  await db
    .delete(configSistemaTable)
    .where(
      and(
        like(configSistemaTable.clave, `${TV_CODIGO_PREFIJO}%`),
        lt(configSistemaTable.actualizadoEn, new Date(Date.now() - 2 * TV_CODIGO_TTL_MS)),
      ),
    );

  const expiraEn = new Date(Date.now() + TV_CODIGO_TTL_MS).toISOString();
  const valor = JSON.stringify({ estado: "pendiente", expiraEn } satisfies TvVinculo);
  for (let intento = 0; intento < 5; intento++) {
    const codigo = generarCodigoTv();
    const insertado = await db
      .insert(configSistemaTable)
      .values({ clave: `${TV_CODIGO_PREFIJO}${codigo}`, valor })
      .onConflictDoNothing()
      .returning({ clave: configSistemaTable.clave });
    if (insertado.length > 0) {
      res.json({ codigo, expiraEn });
      return;
    }
  }
  res.status(500).json({ error: "No se pudo generar un código, reintentá" });
});

// GET /sala-espera/tv/codigo/:codigo — la TV consulta (polling) si ya la vincularon
router.get("/sala-espera/tv/codigo/:codigo", async (req, res): Promise<void> => {
  const codigo = normalizarCodigoTv(req.params.codigo);
  if (!codigo) {
    res.status(404).json({ error: "Código inválido o vencido" });
    return;
  }
  const vinculo = await leerVinculoTv(codigo);
  if (!vinculo || new Date(vinculo.expiraEn).getTime() < Date.now()) {
    if (vinculo) await borrarVinculoTv(codigo);
    res.status(404).json({ error: "Código inválido o vencido" });
    return;
  }
  if (vinculo.estado === "asignado") {
    // Consumo: la asignación se entrega una sola vez y el código se descarta
    await borrarVinculoTv(codigo);
    res.json({
      estado: "asignado",
      sedeId: vinculo.sedeId ?? null,
      turneraId: vinculo.turneraId ?? null,
      salaId: vinculo.salaId ?? null,
      expiraEn: vinculo.expiraEn,
    });
    return;
  }
  res.json({ estado: "pendiente", sedeId: null, turneraId: null, salaId: null, expiraEn: vinculo.expiraEn });
});

// POST /sala-espera/tv/codigo/:codigo/canjear — Recepción asigna la sala a la TV
router.post("/sala-espera/tv/codigo/:codigo/canjear", async (req, res): Promise<void> => {
  const user = await getUser(req);
  if (!user) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }
  if (!ROLES_OPERACION.includes(user.rol)) {
    res.status(403).json({ error: "Sin permisos para vincular pantallas" });
    return;
  }
  const codigo = normalizarCodigoTv(req.params.codigo);
  if (!codigo) {
    res.status(404).json({ error: "Código inválido o vencido" });
    return;
  }
  const parsed = CanjearCodigoTvBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Datos inválidos", detalles: parsed.error.issues });
    return;
  }
  const { sedeId, turneraId, salaId } = parsed.data;

  // Validar destino: sala de llamado activa, turnera activa o sede existente
  // (sin nada = todas las sedes)
  if (salaId != null) {
    const [sala] = await db
      .select({ id: salasLlamadoTable.id })
      .from(salasLlamadoTable)
      .where(and(eq(salasLlamadoTable.id, salaId), eq(salasLlamadoTable.activa, true)))
      .limit(1);
    if (!sala) {
      res.status(400).json({ error: "Sala no encontrada o inactiva" });
      return;
    }
  } else if (turneraId != null) {
    const [turnera] = await db
      .select({ id: turnerasTable.id })
      .from(turnerasTable)
      .where(and(eq(turnerasTable.id, turneraId), eq(turnerasTable.activa, true)))
      .limit(1);
    if (!turnera) {
      res.status(400).json({ error: "Turnera no encontrada o inactiva" });
      return;
    }
  } else if (sedeId != null) {
    const [sede] = await db
      .select({ id: sedesTable.id })
      .from(sedesTable)
      .where(eq(sedesTable.id, sedeId))
      .limit(1);
    if (!sede) {
      res.status(400).json({ error: "Sede no encontrada" });
      return;
    }
  }

  const vinculo = await leerVinculoTv(codigo);
  if (!vinculo || new Date(vinculo.expiraEn).getTime() < Date.now()) {
    if (vinculo) await borrarVinculoTv(codigo);
    res.status(404).json({ error: "Código inválido o vencido: verificá el código en la TV" });
    return;
  }
  if (vinculo.estado === "asignado") {
    res.status(409).json({ error: "Ese código ya fue vinculado" });
    return;
  }

  const nuevo: TvVinculo = {
    estado: "asignado",
    expiraEn: vinculo.expiraEn,
    sedeId: salaId != null || turneraId != null ? null : (sedeId ?? null),
    turneraId: salaId != null ? null : (turneraId ?? null),
    salaId: salaId ?? null,
  };
  await db
    .update(configSistemaTable)
    .set({ valor: JSON.stringify(nuevo), actualizadoEn: new Date() })
    .where(eq(configSistemaTable.clave, `${TV_CODIGO_PREFIJO}${codigo}`));

  req.log.info(
    { codigo, sedeId: nuevo.sedeId, turneraId: nuevo.turneraId, salaId: nuevo.salaId, usuario: user.email },
    "sala-espera: TV vinculada por código",
  );
  res.json({ ok: true });
});

// ── GET /sala-espera/mi-posicion ─────────────────────────────────────────
// El paciente logueado ve sus turnos de hoy y su posición en la cola.
const ESTADOS_EN_ESPERA = ["arribo", "en_sala"];

router.get("/sala-espera/mi-posicion", async (req, res): Promise<void> => {
  const user = await getUser(req);
  if (!user) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }
  if (user.rol !== "paciente") {
    res.status(403).json({ error: "Solo disponible para pacientes" });
    return;
  }

  const pacienteId = Number(user.pacienteId);
  if (!user.pacienteId || !Number.isInteger(pacienteId)) {
    res.json({ turnos: [] });
    return;
  }

  const misTurnos = await db
    .select({
      turno: turnosTable,
      turnera: turnerasTable,
      profesional: profesionalesTable,
    })
    .from(turnosTable)
    .innerJoin(turnerasTable, eq(turnosTable.turneraId, turnerasTable.id))
    .leftJoin(profesionalesTable, eq(turnosTable.profesionalId, profesionalesTable.id))
    .where(and(eq(turnosTable.fecha, hoy()), eq(turnosTable.pacienteId, pacienteId)))
    .orderBy(turnosTable.horaInicio);

  if (misTurnos.length === 0) {
    res.json({ turnos: [] });
    return;
  }

  // Cola de espera de las turneras involucradas, mismo orden que la vista del staff
  const turneraIds = Array.from(new Set(misTurnos.map((t) => t.turno.turneraId)));
  const duracionPorTurnera = new Map<number, number | null | undefined>(
    misTurnos.map((t) => [t.turno.turneraId, t.turnera.duracionMinutos ?? (t.turnera.esGuardia ? 15 : null)]),
  );
  const [colaRows, estimador] = await Promise.all([
    db
      .select({
        id: turnosTable.id,
        turneraId: turnosTable.turneraId,
      })
      .from(turnosTable)
      .innerJoin(turnerasTable, eq(turnosTable.turneraId, turnerasTable.id))
      .where(
        and(
          eq(turnosTable.fecha, hoy()),
          // En guardia, los "confirmado" (agendados sin llegar) ocupan lugar.
          or(
            inArray(turnosTable.estado, ESTADOS_EN_ESPERA),
            and(eq(turnosTable.estado, "confirmado"), eq(turnerasTable.esGuardia, true)),
          )!,
          inArray(turnosTable.turneraId, turneraIds),
        ),
      )
      .orderBy(turnosTable.horaInicio),
    crearEstimadorEspera(hoy(), turneraIds, duracionPorTurnera),
  ]);

  const ahora = Date.now();

  const turnos = misTurnos.map(({ turno, turnera, profesional }) => {
    const colaTurnera = colaRows.filter((c) => c.turneraId === turno.turneraId);
    const enEspera =
      ESTADOS_EN_ESPERA.includes(turno.estado) ||
      (turno.estado === "confirmado" && turnera.esGuardia);
    const idx = enEspera ? colaTurnera.findIndex((c) => c.id === turno.id) : -1;
    return {
      turnoId: turno.id,
      horaInicio: turno.horaInicio,
      estado: turno.estado,
      turneraId: turnera.id,
      turneraNombre: turnera.nombre,
      profesionalNombre: profesional
        ? `${profesional.nombre}${profesional.apellido ? ` ${profesional.apellido}` : ""}`
        : null,
      modalidad: turno.modalidad,
      posicion: idx >= 0 ? idx + 1 : null,
      enEsperaTurnera: colaTurnera.length,
      esperaEstimadaMinutos: idx >= 0 ? estimador.estimar(turno.turneraId, idx + 1) : null,
      esperaMinutos: turno.admitidoEn
        ? Math.max(0, Math.round((ahora - turno.admitidoEn.getTime()) / 60000))
        : null,
      admitidoEn: turno.admitidoEn,
      llamadoEn: turno.llamadoEn,
    };
  });

  res.json({ turnos });
});

// ═══════════════════════════════════════════════════════════════════════
// Flujo transaccional único consultations/process del Robot KLINICOS
// (contrato definitivo 19/07/2026 — docs/robot-openapi/robot-openapi.yaml).
// Pantalla de prueba admin: usa datos REALES de Conectar (paciente por DNI,
// práctica del catálogo institucional, sede real), pero NO toca turnos.
// El token NUNCA se guarda ni se loguea (solo enmascarado).
// El flag KLINICOS_CONSULTATIONS_PROCESS_ENABLED protege el circuito
// productivo; la prueba admin llama al Robot igual que la prueba de token.
// ═══════════════════════════════════════════════════════════════════════

function resultadoProcesoAJson(requestId: string, consultationId: string, r: ResultadoProceso) {
  if (r.tipo === "error") {
    return {
      requestId,
      consultationId,
      estado: "ERROR_COMUNICACION",
      mensaje: r.mensaje,
      intento: 0,
      requiereAccionManual: false,
      reintentoPermitido: r.clase === "rate_limit" || r.clase === "timeout" || r.clase === "red",
      camposFaltantes: [],
      mapeosPendientes: [],
      codigo: null,
      numeroAutorizacion: null,
      referenciaKlinicos: null,
      prestacionCreada: false,
      cola: null,
      validadoEn: null,
      latenciaMs: r.latenciaMs,
      httpStatus: r.httpStatus,
      claseError: r.clase,
    };
  }
  const d = r.data;
  return {
    requestId: d.request_id || requestId,
    consultationId: d.consultation_id || consultationId,
    estado: d.status,
    mensaje: d.reason_message ?? mensajePorEstado(d.status),
    intento: d.attempt_number,
    requiereAccionManual: d.requires_manual_action,
    reintentoPermitido: d.retry_allowed,
    camposFaltantes: d.missing_fields,
    mapeosPendientes: d.mapping_required,
    codigo: d.reason_code,
    numeroAutorizacion: d.authorization_number,
    referenciaKlinicos: d.klinicos_reference,
    prestacionCreada: d.prestation_created,
    cola: d.queue
      ? {
          operacionesPendientes: d.queue.pending_operations ?? null,
          posicionAproximada: d.queue.approx_position ?? null,
          esperaEstimadaSegundos: d.queue.estimated_wait_seconds ?? null,
          sesionKlinicosDisponible: d.queue.klinicos_session_available ?? null,
        }
      : null,
    validadoEn: d.validated_at,
    latenciaMs: r.latenciaMs,
    httpStatus: null,
    claseError: null,
  };
}

function mensajePorEstado(estado: string): string {
  switch (estado) {
    case "PROCESSING":
      return "La operación sigue en proceso. Se consulta automáticamente.";
    case "TOKEN_ACCEPTED":
      return "Token aplicado con éxito. Caso cerrado.";
    case "TOKEN_DENIED":
      return "Token denegado por IOMA. Caso cerrado.";
    case "DATA_REQUIRED":
      return "Faltan datos o son inválidos. Completar y re-enviar el mismo request_id.";
    case "MAPPING_REQUIRED":
      return "Faltan equivalencias aprobadas. Se corrigen en el panel del Robot y se reintenta el mismo request_id.";
    case "MANUAL_REVIEW":
      return "En revisión técnica del Robot. Esperar resolución.";
    case "TOKEN_REENTRY_REQUIRED":
      return "El token guardado venció (120 min). Re-enviar con el MISMO request_id y un token NUEVO.";
    case "TECHNICAL_ERROR":
      return "Error técnico. Reintentar el mismo request_id con el pedido idéntico.";
    default:
      return "Estado desconocido.";
  }
}

async function guardarProceso(
  requestId: string,
  consultationId: string,
  r: ResultadoProceso,
  extras: {
    tokenMasked?: string;
    practiceId?: string;
    practiceCode?: string;
    pacienteDni?: string;
    scheduledAt?: string;
    esPrueba?: boolean;
  } = {},
): Promise<void> {
  const base = {
    requestId,
    consultationId,
    tokenMasked: extras.tokenMasked,
    practiceId: extras.practiceId,
    practiceCode: extras.practiceCode,
    pacienteDni: extras.pacienteDni,
    scheduledAt: extras.scheduledAt,
    ...(extras.esPrueba !== undefined ? { esPrueba: extras.esPrueba } : {}),
  };
  const datos =
    r.tipo === "respuesta"
      ? {
          estado: r.data.status,
          attemptNumber: r.data.attempt_number,
          requiresManualAction: r.data.requires_manual_action,
          retryAllowed: r.data.retry_allowed,
          prestationCreated: r.data.prestation_created,
          missingFields: JSON.stringify(r.data.missing_fields),
          mappingRequired: JSON.stringify(r.data.mapping_required),
          reasonCode: r.data.reason_code,
          reasonMessage: r.data.reason_message,
          authorizationNumber: r.data.authorization_number,
          klinicosReference: r.data.klinicos_reference,
          validatedAt: r.data.validated_at ? new Date(r.data.validated_at) : null,
        }
      : {
          // Error de comunicación: conservamos el caso como PROCESSING local
          // para no perder el request_id (el Robot puede tenerlo en curso).
          reasonCode: `HTTP_${r.httpStatus}`,
          reasonMessage: r.mensaje,
        };
  await db
    .insert(klinicosConsultasProcesosTable)
    .values({ ...base, ...datos })
    .onConflictDoUpdate({
      target: klinicosConsultasProcesosTable.requestId,
      set: { ...datos, tokenMasked: extras.tokenMasked },
    });
}

router.post("/robot-klinicos/consultas/prueba", async (req, res) => {
  const user = await getUser(req);
  if (!user) return void res.status(401).json({ error: "No autenticado" });
  if (user.rol !== "admin")
    return void res.status(403).json({ error: "Solo administradores pueden ejecutar la prueba" });

  const parsed = ProcesarConsultaRobotPruebaBody.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: "Datos inválidos" });
  const b = parsed.data;
  const token = b.token.trim();
  const dni = b.dni.trim();
  if (!/^\d{6,9}$/.test(dni))
    return void res.status(400).json({ error: "El DNI debe tener 6 a 9 dígitos, sin puntos" });

  // Diagnóstico CIE-10 contra el catálogo institucional (nunca se inventa).
  const cie10 = normalizarCie10(b.diagnosisCode);
  if (!cie10) return void res.status(400).json({ error: "Código CIE-10 inválido" });
  const errorCie10 = await validarCie10Catalogo(cie10);
  if (errorCie10) return void res.status(400).json({ error: errorCie10 });

  // Paciente REAL de Conectar (regla: el Robot nunca crea pacientes).
  const [paciente] = await db
    .select()
    .from(pacientesTable)
    .where(and(eq(pacientesTable.dni, dni), eq(pacientesTable.activo, true)))
    .limit(1);
  if (!paciente)
    return void res.status(404).json({ error: `No hay paciente activo con DNI ${dni} en Conectar` });

  // Práctica REAL del catálogo institucional KLINICOS (practice.id = código
  // con equivalencia en el Robot; el mismo del catálogo CSV entregado).
  const practicaCodigo = b.practicaCodigo.trim();
  const filasPracticas = await db
    .select()
    .from(klinicosPracticas)
    .where(eq(klinicosPracticas.activo, true));
  const practica = filasPracticas.find((p) => (p.codigos ?? []).includes(practicaCodigo));
  if (!practica)
    return void res.status(404).json({
      error: `El código ${practicaCodigo} no está en el catálogo institucional de prácticas KLINICOS`,
    });

  // Sede real (site del contrato) — opcional.
  let sede: { id: number; nombre: string } | null = null;
  if (b.sedeId != null) {
    const [s] = await db
      .select({ id: sedesTable.id, nombre: sedesTable.nombre })
      .from(sedesTable)
      .where(eq(sedesTable.id, b.sedeId))
      .limit(1);
    if (!s) return void res.status(404).json({ error: "Sede no encontrada" });
    sede = s;
  }

  const limite = pruebaRateLimitOk(user.id);
  if (!limite.ok) return void res.status(429).json({ error: limite.motivo });

  // Certificación sandbox: la consola de prueba solo opera contra el Robot en
  // modo simulación. Si health no responde sandbox:true, se bloquea la prueba.
  const saludPrevia = await saludConsultasRobot();
  if (!saludPrevia.ok)
    return void res.status(503).json({
      error: `Prueba bloqueada: no se pudo verificar el modo sandbox del Robot (${saludPrevia.mensaje})`,
    });
  if (saludPrevia.data.sandbox !== true)
    return void res.status(409).json({
      error:
        "Prueba bloqueada: el Robot no está en modo sandbox (health sin sandbox:true). No se envían casos hasta confirmar simulación.",
    });

  const requestId = b.requestId?.trim() || randomUUID();
  const consultationId = b.consultationId?.trim() || `prueba-consulta-${requestId.slice(0, 8)}`;

  // Regla del contrato: un consultation_id admite UN solo request_id.
  const [previo] = await db
    .select()
    .from(klinicosConsultasProcesosTable)
    .where(eq(klinicosConsultasProcesosTable.consultationId, consultationId))
    .limit(1);
  if (previo && previo.requestId !== requestId)
    return void res.status(409).json({
      error: `El consultation_id ${consultationId} ya está asociado al request_id ${previo.requestId}. Reusar ese request_id.`,
    });

  // Atención de HOY en hora argentina, con offset -03:00 (nunca Z).
  const fechaHoy = hoyArgentina();
  const hora = b.hora?.trim() || horaArgentina();
  const scheduledAt = armarScheduledAt(fechaHoy, hora);

  const entrada: ConsultaProcesoEntrada = {
    request_id: requestId,
    consultation_id: consultationId,
    patient: {
      document_type: "DNI",
      document_number: dni,
      first_name: paciente.nombre,
      last_name: paciente.apellido,
      birth_date: paciente.fechaNacimiento?.trim() || null,
      affiliate_number: paciente.nroAfiliado?.trim() ?? "",
      affiliate_type: null,
    },
    coverage: {
      insurer: paciente.cobertura?.trim() || "IOMA",
      plan: paciente.planCobertura?.trim() || null,
    },
    practice: {
      id: practicaCodigo,
      code: practicaCodigo,
      // Klinicos solo acepta el código de prestación: nunca enviar letras.
      description: null,
      catalog: "IOMA",
      quantity: b.cantidad && b.cantidad > 0 ? b.cantidad : 1,
    },
    site: sede ? { id: String(sede.id), name: sede.nombre } : null,
    scheduled_at: scheduledAt,
    diagnosis: { code: cie10, description: b.diagnosisDescripcion?.trim() || null },
    token,
  };

  pruebaEnVuelo.add(user.id);
  let resultado: ResultadoProceso;
  try {
    resultado = await procesarConsultaConRobot(entrada);
  } finally {
    pruebaEnVuelo.delete(user.id);
  }

  await guardarProceso(requestId, consultationId, resultado, {
    tokenMasked: enmascararToken(token),
    practiceId: practicaCodigo,
    practiceCode: practicaCodigo,
    pacienteDni: dni,
    scheduledAt,
  });

  if (resultado.tipo === "error" && resultado.clase === "no_autorizado") {
    req.log.error(
      { requestId, admin: user.email },
      "robot-consultas: el Robot rechazó la clave de API (HTTP 401) — revisar ROBOT_API_KEY",
    );
  }

  // El token NUNCA se loguea: solo enmascarado.
  req.log.info(
    {
      requestId,
      consultationId,
      token: enmascararToken(token),
      estado: resultado.tipo === "respuesta" ? resultado.data.status : `ERROR:${resultado.clase}`,
      latenciaMs: resultado.latenciaMs,
      admin: user.email,
    },
    "robot-consultas: prueba admin de consultations/process",
  );

  res.json(resultadoProcesoAJson(requestId, consultationId, resultado));
});

router.get("/robot-klinicos/consultas/prueba/:requestId", async (req, res) => {
  const user = await getUser(req);
  if (!user) return void res.status(401).json({ error: "No autenticado" });
  if (user.rol !== "admin")
    return void res.status(403).json({ error: "Solo administradores pueden usar la prueba" });

  const requestId = req.params.requestId?.trim();
  if (!requestId) return void res.status(400).json({ error: "requestId requerido" });

  const [proceso] = await db
    .select()
    .from(klinicosConsultasProcesosTable)
    .where(eq(klinicosConsultasProcesosTable.requestId, requestId))
    .limit(1);
  if (!proceso) return void res.status(404).json({ error: "request_id no encontrado" });

  // Polling read-only del Robot; aislamiento de paciente: el resultado se
  // aplica SOLO a la fila de este request_id (nunca a otra ficha).
  const resultado = await consultarProcesoConsulta(requestId);
  await guardarProceso(requestId, proceso.consultationId, resultado);

  req.log.info(
    {
      requestId,
      estado: resultado.tipo === "respuesta" ? resultado.data.status : `ERROR:${resultado.clase}`,
      latenciaMs: resultado.latenciaMs,
      admin: user.email,
    },
    "robot-consultas: polling de proceso (solo admin)",
  );
  res.json(resultadoProcesoAJson(requestId, proceso.consultationId, resultado));
});

router.post("/robot-klinicos/consultas/prueba/:requestId/retry", async (req, res) => {
  const user = await getUser(req);
  if (!user) return void res.status(401).json({ error: "No autenticado" });
  if (user.rol !== "admin")
    return void res.status(403).json({ error: "Solo administradores pueden usar la prueba" });

  const requestId = req.params.requestId?.trim();
  if (!requestId) return void res.status(400).json({ error: "requestId requerido" });

  const [proceso] = await db
    .select()
    .from(klinicosConsultasProcesosTable)
    .where(eq(klinicosConsultasProcesosTable.requestId, requestId))
    .limit(1);
  if (!proceso) return void res.status(404).json({ error: "request_id no encontrado" });

  const limite = pruebaRateLimitOk(user.id);
  if (!limite.ok) return void res.status(429).json({ error: limite.motivo });

  const resultado = await reintentarProcesoConsulta(requestId);
  await guardarProceso(requestId, proceso.consultationId, resultado);

  // 409 del retry = token vencido en el Robot → TOKEN_REENTRY_REQUIRED local,
  // tanto en la DB como en la respuesta HTTP (sin ambigüedad operativa).
  let cuerpo = resultadoProcesoAJson(requestId, proceso.consultationId, resultado);
  if (resultado.tipo === "error" && resultado.clase === "conflicto") {
    await db
      .update(klinicosConsultasProcesosTable)
      .set({ estado: "TOKEN_REENTRY_REQUIRED", reasonMessage: resultado.mensaje })
      .where(eq(klinicosConsultasProcesosTable.requestId, requestId));
    cuerpo = {
      ...cuerpo,
      estado: "TOKEN_REENTRY_REQUIRED",
      mensaje: mensajePorEstado("TOKEN_REENTRY_REQUIRED"),
      requiereAccionManual: true,
    };
  }

  req.log.info(
    {
      requestId,
      estado: resultado.tipo === "respuesta" ? resultado.data.status : `ERROR:${resultado.clase}`,
      latenciaMs: resultado.latenciaMs,
      admin: user.email,
    },
    "robot-consultas: reintento de proceso (solo admin)",
  );
  res.json(cuerpo);
});

// ═══════════════════════════════════════════════════════════════════════
// PRUEBA REAL CONTROLADA — un único caso real contra el Robot en modo REAL
// (health 200 + sandbox:false). Puede crear una prestación en KLINICOS y
// consumir el token IOMA. Solo admins, con aceptación explícita.
// El flag KLINICOS_CONSULTATIONS_PROCESS_ENABLED permanece apagado: esta
// ruta es independiente del circuito de recepción general.
// ═══════════════════════════════════════════════════════════════════════

// Candado global: UNA sola prueba real simultánea en toda la instalación.
let pruebaRealEnCurso = false;

async function turnosHoyCandidatos() {
  const fechaHoy = hoyArgentina();
  const filas = await db
    .select({
      turnoId: turnosTable.id,
      hora: turnosTable.horaInicio,
      estado: turnosTable.estado,
      modalidad: turnosTable.modalidad,
      nombre: pacientesTable.nombre,
      apellido: pacientesTable.apellido,
      nroAfiliado: pacientesTable.nroAfiliado,
      cobertura: pacientesTable.cobertura,
      fechaNacimiento: pacientesTable.fechaNacimiento,
      pacienteActivo: pacientesTable.activo,
      dni: pacientesTable.dni,
      especialidad: especialidadesTable.nombre,
      sede: sedesTable.nombre,
    })
    .from(turnosTable)
    .innerJoin(turnerasTable, eq(turnerasTable.id, turnosTable.turneraId))
    .innerJoin(pacientesTable, eq(pacientesTable.id, turnosTable.pacienteId))
    .leftJoin(especialidadesTable, eq(especialidadesTable.id, turnerasTable.especialidadId))
    .leftJoin(sedesTable, eq(sedesTable.id, turnerasTable.sedeId))
    .where(eq(turnosTable.fecha, fechaHoy));
  return filas
    .filter((f) => f.pacienteActivo && f.modalidad !== "virtual")
    .map((f) => {
      // Campos requeridos por el contrato que estén incompletos (sin exponer DNI/afiliado).
      const camposIncompletos: string[] = [];
      if (!/^\d{6,9}$/.test(f.dni ?? "")) camposIncompletos.push("DNI (6 a 9 dígitos, sin puntos)");
      // Nro. de afiliado: ya no cuenta como incompleto (el Robot lo completa por padrón).
      if ((f.cobertura ?? "").trim().toUpperCase() !== "IOMA")
        camposIncompletos.push("Cobertura IOMA (afiliación IOMA obligatoria)");
      if (!f.fechaNacimiento?.trim()) camposIncompletos.push("Fecha de nacimiento");
      return {
        turnoId: f.turnoId,
        hora: f.hora,
        paciente: `${f.apellido}, ${f.nombre}`,
        especialidad: f.especialidad ?? null,
        sede: f.sede ?? null,
        cobertura: f.cobertura ?? null,
        estado: f.estado,
        afiliacionCompleta: camposIncompletos.length === 0,
        camposIncompletos,
      };
    })
    .sort((a, b) => a.hora.localeCompare(b.hora));
}

router.get("/robot-klinicos/consultas/prueba-real/preflight", async (req, res) => {
  const user = await getUser(req);
  if (!user) return void res.status(401).json({ error: "No autenticado" });
  if (user.rol !== "admin") return void res.status(403).json({ error: "Solo administradores" });

  const salud = await saludConsultasRobot();
  const robotDisponible = salud.ok;
  const sandbox = salud.ok ? salud.data.sandbox : null;
  const habilitadoEnRobot = salud.ok ? salud.data.enabled : null;
  const flag = consultasProcessHabilitadas();

  res.json({
    robotDisponible,
    sandbox,
    habilitadoEnRobot,
    flagRecepcionGeneral: flag,
    pruebaRealEnCurso,
    mensaje: salud.ok ? null : salud.mensaje,
    checks: {
      healthOk: robotDisponible,
      modoReal: robotDisponible && sandbox === false,
      flujoDisponible: habilitadoEnRobot === true,
      flagApagado: !flag,
      sinPruebaEnCurso: !pruebaRealEnCurso,
    },
    turnosHoy: await turnosHoyCandidatos(),
  });
});

router.post("/robot-klinicos/consultas/prueba-real", async (req, res) => {
  const user = await getUser(req);
  if (!user) return void res.status(401).json({ error: "No autenticado" });
  if (user.rol !== "admin")
    return void res
      .status(403)
      .json({ error: "Solo administradores pueden ejecutar la prueba real controlada" });

  const parsed = EjecutarPruebaRealRobotBody.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: "Datos inválidos" });
  const b = parsed.data;
  if (b.confirmacion !== true)
    return void res.status(400).json({
      error:
        "Falta la aceptación explícita del administrador. Esta operación es real: puede crear una prestación en KLINICOS y consumir el token IOMA.",
    });
  const token = b.token.trim();

  // Diagnóstico CIE-10 contra el catálogo institucional (nunca se inventa).
  const cie10 = normalizarCie10(b.diagnosisCode);
  if (!cie10) return void res.status(400).json({ error: "Código CIE-10 inválido" });
  const errorCie10 = await validarCie10Catalogo(cie10);
  if (errorCie10) return void res.status(400).json({ error: errorCie10 });

  // Turno REAL de HOY con paciente presente y autorizado.
  const fechaHoy = hoyArgentina();
  const [turno] = await db
    .select()
    .from(turnosTable)
    .where(and(eq(turnosTable.id, b.turnoId), eq(turnosTable.fecha, fechaHoy)))
    .limit(1);
  if (!turno)
    return void res
      .status(404)
      .json({ error: "El turno no existe o no es de HOY. La prueba real exige un paciente de hoy." });

  const [paciente] = await db
    .select()
    .from(pacientesTable)
    .where(and(eq(pacientesTable.id, turno.pacienteId), eq(pacientesTable.activo, true)))
    .limit(1);
  if (!paciente)
    return void res.status(404).json({ error: "El paciente del turno no está activo en Conectar" });

  // Afiliación IOMA completa (obligatoria para la prueba real).
  if (!/^\d{6,9}$/.test(paciente.dni ?? ""))
    return void res
      .status(400)
      .json({ error: "El paciente no tiene DNI válido (6 a 9 dígitos, sin puntos)" });
  // Nro. de afiliado ya NO es obligatorio: el Robot lo completa por padrón (DNI).
  if ((paciente.cobertura ?? "").trim().toUpperCase() !== "IOMA")
    return void res.status(400).json({
      error: `La cobertura del paciente es "${paciente.cobertura ?? "sin cobertura"}", no IOMA. La prueba real exige afiliación IOMA completa.`,
    });

  // Sede real desde la turnera del turno (site del contrato).
  const [turnera] = await db
    .select({ sedeId: turnerasTable.sedeId })
    .from(turnerasTable)
    .where(eq(turnerasTable.id, turno.turneraId))
    .limit(1);
  let sede: { id: number; nombre: string } | null = null;
  if (turnera?.sedeId != null) {
    const [s] = await db
      .select({ id: sedesTable.id, nombre: sedesTable.nombre })
      .from(sedesTable)
      .where(eq(sedesTable.id, turnera.sedeId))
      .limit(1);
    sede = s ?? null;
  }

  // Robot en modo REAL: health 200 y sandbox estrictamente false.
  const saludPrevia = await saludConsultasRobot();
  if (!saludPrevia.ok)
    return void res.status(503).json({
      error: `Prueba real bloqueada: no se pudo verificar el health del Robot (${saludPrevia.mensaje})`,
    });
  if (saludPrevia.data.sandbox !== false)
    return void res.status(409).json({
      error:
        "Prueba real bloqueada: el Robot NO está en modo real (health con sandbox distinto de false). No se envía nada.",
    });
  if (saludPrevia.data.enabled !== true)
    return void res.status(409).json({
      error: "Prueba real bloqueada: el flujo real del Robot no está disponible (enabled false).",
    });

  // Un consultation_id por turno; un request_id por consultation_id (contrato).
  const consultationId = `turno-${turno.id}`;
  const [previo] = await db
    .select()
    .from(klinicosConsultasProcesosTable)
    .where(eq(klinicosConsultasProcesosTable.consultationId, consultationId))
    .limit(1);
  const requestId = b.requestId?.trim() || previo?.requestId || randomUUID();
  if (previo && previo.requestId !== requestId)
    return void res.status(409).json({
      error: `Esta consulta ya está asociada al request_id ${previo.requestId}. Reusar ese request_id (nunca generar otro para la misma consulta).`,
    });

  // Candado: UNA sola prueba real simultánea (bloquea también el doble clic).
  if (pruebaRealEnCurso)
    return void res
      .status(409)
      .json({ error: "Ya hay una prueba real en curso. Esperá a que termine." });
  const limite = pruebaRateLimitOk(user.id);
  if (!limite.ok) return void res.status(429).json({ error: limite.motivo });

  const practicaId = b.practicaId.trim();
  const scheduledAt = armarScheduledAt(fechaHoy, turno.horaInicio);
  const entrada: ConsultaProcesoEntrada = {
    request_id: requestId,
    consultation_id: consultationId,
    patient: {
      document_type: "DNI",
      document_number: paciente.dni ?? "",
      first_name: paciente.nombre,
      last_name: paciente.apellido,
      birth_date: paciente.fechaNacimiento?.trim() || null,
      affiliate_number: paciente.nroAfiliado?.trim() ?? "",
      affiliate_type: null,
    },
    coverage: { insurer: "IOMA", plan: paciente.planCobertura?.trim() || null },
    // El profesional real de Conectar NO viaja: el Robot deriva
    // practice.id → CONSULTA_GENERAL → su profesional configurado.
    practice: {
      id: practicaId,
      code: b.practicaCodigo?.trim() || practicaId,
      // Klinicos solo acepta el código de prestación: nunca enviar letras.
      description: null,
      catalog: "IOMA",
      quantity: 1,
    },
    site: sede ? { id: String(sede.id), name: sede.nombre } : null,
    scheduled_at: scheduledAt,
    diagnosis: { code: cie10, description: b.diagnosisDescripcion?.trim() || null },
    token,
  };

  pruebaRealEnCurso = true;
  pruebaEnVuelo.add(user.id);
  let resultado: ResultadoProceso;
  try {
    resultado = await procesarConsultaConRobot(entrada);
  } finally {
    pruebaEnVuelo.delete(user.id);
    pruebaRealEnCurso = false;
  }

  await guardarProceso(requestId, consultationId, resultado, {
    tokenMasked: enmascararToken(token),
    practiceId: practicaId,
    practiceCode: b.practicaCodigo?.trim() || practicaId,
    pacienteDni: paciente.dni ?? undefined,
    scheduledAt,
  });

  await registrarAuditoria(user, "prueba_real_robot_klinicos", turno.id, paciente.id, {
    requestId,
    consultationId,
    practicaId,
    estado: resultado.tipo === "respuesta" ? resultado.data.status : `ERROR:${resultado.clase}`,
    tokenMasked: enmascararToken(token),
  });

  // Log SIN DNI y SIN token (solo enmascarado).
  req.log.info(
    {
      requestId,
      consultationId,
      turnoId: turno.id,
      token: enmascararToken(token),
      estado: resultado.tipo === "respuesta" ? resultado.data.status : `ERROR:${resultado.clase}`,
      latenciaMs: resultado.latenciaMs,
      admin: user.email,
    },
    "robot-consultas: PRUEBA REAL CONTROLADA ejecutada",
  );

  res.json(resultadoProcesoAJson(requestId, consultationId, resultado));
});

// ═══════════════════════════════════════════════════════════════════════
// CIRCUITO PRODUCTIVO — consola del operador (recepción) sobre el flujo
// transaccional único consultations/process. Protegido por el flag
// KLINICOS_CONSULTATIONS_PROCESS_ENABLED (503 si está apagado).
// Reglas: un request_id por consulta (consultation_id = "turno-{id}"),
// payload SIN médico/matrícula/especialidad, token NUNCA persistido ni
// logueado (solo enmascarado), el Robot NUNCA crea pacientes.
// ═══════════════════════════════════════════════════════════════════════

function filaProcesoAJson(p: typeof klinicosConsultasProcesosTable.$inferSelect) {
  let camposFaltantes: string[] = [];
  let mapeosPendientes: unknown[] = [];
  try {
    camposFaltantes = p.missingFields ? JSON.parse(p.missingFields) : [];
  } catch {
    camposFaltantes = [];
  }
  try {
    mapeosPendientes = p.mappingRequired ? JSON.parse(p.mappingRequired) : [];
  } catch {
    mapeosPendientes = [];
  }
  return {
    requestId: p.requestId,
    consultationId: p.consultationId,
    estado: p.estado,
    mensaje: p.reasonMessage ?? mensajePorEstado(p.estado),
    intento: p.attemptNumber,
    requiereAccionManual: p.requiresManualAction,
    reintentoPermitido: p.retryAllowed,
    camposFaltantes,
    mapeosPendientes,
    codigo: p.reasonCode,
    numeroAutorizacion: p.authorizationNumber,
    referenciaKlinicos: p.klinicosReference,
    prestacionCreada: p.prestationCreated,
    cola: null,
    validadoEn: p.validatedAt ? p.validatedAt.toISOString() : null,
    latenciaMs: 0,
    httpStatus: null,
    claseError: null,
  };
}

// Práctica sugerida para una consulta: reglas fijas especialidad → práctica
// del catálogo institucional (misma semántica que el worker de imágenes,
// pero sin restricción de sector), con fallback a la práctica cuyo nombre
// contenga "CONSULTA". Nunca se inventa: si no hay match, no hay sugerencia.
function normalizarTexto(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .trim();
}

async function sugerirPractica(
  especialidad: string | null,
  motivo: string | null,
): Promise<{ id: string | null; codigo: string | null; nombre: string | null } | null> {
  const especialidadNorm = normalizarTexto(especialidad);
  const texto = normalizarTexto(`${especialidad ?? ""} ${motivo ?? ""}`);
  const reglas = await db
    .select({
      patronMotivo: klinicosReglasPractica.patronMotivo,
      especialidad: klinicosReglasPractica.especialidad,
      prioridad: klinicosReglasPractica.prioridad,
      codigos: klinicosPracticas.codigos,
      nombre: klinicosPracticas.nombre,
      practicaActiva: klinicosPracticas.activo,
    })
    .from(klinicosReglasPractica)
    .innerJoin(klinicosPracticas, eq(klinicosReglasPractica.practicaId, klinicosPracticas.id))
    .where(eq(klinicosReglasPractica.activo, true));
  const regla = reglas
    .filter(
      (r) =>
        r.practicaActiva &&
        especialidadNorm.includes(normalizarTexto(r.especialidad)) &&
        (!r.patronMotivo || texto.includes(normalizarTexto(r.patronMotivo))),
    )
    .sort(
      (a, b) => b.prioridad - a.prioridad || (b.patronMotivo ? 1 : 0) - (a.patronMotivo ? 1 : 0),
    )[0];
  if (regla) {
    const codigo = regla.codigos?.[0] ?? null;
    return { id: codigo, codigo, nombre: regla.nombre };
  }
  const practicas = await db
    .select()
    .from(klinicosPracticas)
    .where(eq(klinicosPracticas.activo, true));
  const match =
    practicas.find((p) => texto && texto.includes(normalizarTexto(p.nombre))) ??
    practicas.find((p) => normalizarTexto(p.nombre).includes("CONSULTA"));
  if (!match) return null;
  const codigo = match.codigos?.[0] ?? null;
  return { id: codigo, codigo, nombre: match.nombre };
}

// CIE-10 sugerido: último trabajo Klinicos del turno con diagnóstico, o
// primera regla CIE-10 institucional que matchee la especialidad.
async function sugerirCie10(
  turnoId: number,
  especialidad: string | null,
): Promise<{ codigo: string | null; descripcion: string | null } | null> {
  const [trabajo] = await db
    .select({
      cie10Codigo: klinicosTrabajos.cie10Codigo,
      cie10Descripcion: klinicosTrabajos.cie10Descripcion,
    })
    .from(klinicosTrabajos)
    .where(
      sql`${klinicosTrabajos.turnoId} = ${turnoId} AND ${klinicosTrabajos.cie10Codigo} IS NOT NULL`,
    )
    .orderBy(sql`${klinicosTrabajos.id} DESC`)
    .limit(1);
  if (trabajo?.cie10Codigo)
    return { codigo: trabajo.cie10Codigo, descripcion: trabajo.cie10Descripcion ?? null };
  const especialidadNorm = normalizarTexto(especialidad);
  if (!especialidadNorm) return null;
  const reglas = await db
    .select()
    .from(klinicosReglasCie10)
    .where(eq(klinicosReglasCie10.activo, true));
  const regla = reglas
    .filter((r) => especialidadNorm.includes(normalizarTexto(r.patron)))
    .sort((a, b) => b.prioridad - a.prioridad)[0];
  if (!regla) return null;
  return { codigo: regla.cie10Codigo, descripcion: regla.cie10Descripcion ?? null };
}

// Contexto del turno para el circuito productivo (turno + paciente + turnera).
async function cargarContextoTurno(id: number) {
  const [fila] = await db
    .select({
      turno: turnosTable,
      paciente: pacientesTable,
      turnera: turnerasTable,
      especialidad: especialidadesTable.nombre,
    })
    .from(turnosTable)
    .innerJoin(pacientesTable, eq(pacientesTable.id, turnosTable.pacienteId))
    .innerJoin(turnerasTable, eq(turnerasTable.id, turnosTable.turneraId))
    .leftJoin(especialidadesTable, eq(especialidadesTable.id, turnerasTable.especialidadId))
    .where(eq(turnosTable.id, id))
    .limit(1);
  return fila;
}

// Efectos productivos del estado final del proceso: token del turno,
// trabajos Klinicos, campos de consulta y auditoría. El token completo solo
// se propaga a los lugares donde el circuito legacy ya lo guardaba.
async function aplicarEfectosProceso(
  user: SalaUser,
  turno: typeof turnosTable.$inferSelect,
  requestId: string,
  token: string,
  resultado: ResultadoProceso,
): Promise<void> {
  const estado = resultado.tipo === "respuesta" ? resultado.data.status : null;
  const tokenStatus: TokenEstado =
    estado === "TOKEN_ACCEPTED" ? "ACCEPTED" : estado === "TOKEN_DENIED" ? "DENIED" : "PENDING";
  const esAceptado = estado === "TOKEN_ACCEPTED";
  const referencia = resultado.tipo === "respuesta" ? resultado.data.klinicos_reference : null;
  const autorizacion = resultado.tipo === "respuesta" ? resultado.data.authorization_number : null;
  const mensaje =
    resultado.tipo === "respuesta"
      ? (resultado.data.reason_message ?? mensajePorEstado(resultado.data.status))
      : resultado.mensaje;

  const camposToken = {
    coverageType: "IOMA",
    tokenStatus,
    tokenMasked: enmascararToken(token),
    tokenCompleto: token,
    tokenValidatedAt: esAceptado ? new Date() : null,
    tokenValidationRequestId: requestId,
    klinicosReference: referencia,
    authorizationNumber: autorizacion ?? (esAceptado ? referencia : null),
    tokenFailureCode: esAceptado ? null : (estado ?? "TECHNICAL_ERROR"),
    tokenFailureMessage: esAceptado ? null : mensaje,
    robotSyncStatus: (esAceptado || estado === "TOKEN_DENIED"
      ? "COMPLETED"
      : estado === "PROCESSING"
        ? "PROCESSING"
        : "READY_TO_RETRY") satisfies RobotSyncEstado as RobotSyncEstado,
  };
  await db
    .insert(consultasTokenTable)
    .values({ consultationId: turno.id, ...camposToken })
    .onConflictDoUpdate({ target: consultasTokenTable.consultationId, set: camposToken });

  if (esAceptado) {
    await db.update(turnosTable).set({ klinicosToken: token }).where(eq(turnosTable.id, turno.id));
    await registrarEventoTurnoRobot(turno.id, "token_disponible");
    await db
      .update(klinicosTrabajos)
      .set({ tokenAutorizacion: token })
      .where(
        sql`${klinicosTrabajos.turnoId} = ${turno.id} AND ${klinicosTrabajos.estado} IN ('pendiente', 'error')`,
      );
    // Token validado ⇒ recepción automática del paciente (turnos de hoy).
    await recepcionarTrasTokenValidado(user, turno.id, {
      info: () => {},
      warn: () => {},
    });
  }

  await registrarAuditoria(user, "atencion_validada_proceso", turno.id, turno.pacienteId, {
    requestId,
    consultationId: `turno-${turno.id}`,
    estado: estado ?? `ERROR:${resultado.tipo === "error" ? resultado.clase : "desconocido"}`,
    token: enmascararToken(token),
    referenciaKlinicos: referencia,
    latenciaMs: resultado.latenciaMs,
  });
}

router.get("/turnos/:id/validacion-proceso", async (req, res) => {
  const user = await getUser(req);
  if (!user) return void res.status(401).json({ error: "No autenticado" });
  if (!ROLES_LECTURA.includes(user.rol))
    return void res.status(403).json({ error: "Sin permisos" });
  if (!consultasProcessHabilitadas())
    return void res
      .status(503)
      .json({ error: "El circuito de validación de atención no está habilitado" });

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return void res.status(400).json({ error: "ID inválido" });
  const fila = await cargarContextoTurno(id);
  if (!fila) return void res.status(404).json({ error: "Turno no encontrado" });

  const [practicaSugerida, cie10Sugerido] = await Promise.all([
    sugerirPractica(fila.especialidad, fila.turno.motivoConsulta),
    sugerirCie10(id, fila.especialidad),
  ]);

  const consultationId = `turno-${id}`;
  const [proceso] = await db
    .select()
    .from(klinicosConsultasProcesosTable)
    .where(eq(klinicosConsultasProcesosTable.consultationId, consultationId))
    .limit(1);
  if (!proceso)
    return void res.json({ existe: false, proceso: null, practicaSugerida, cie10Sugerido });

  // Solo se consulta al Robot si el caso sigue abierto (PROCESSING); los
  // estados finales o accionables se responden desde lo persistido.
  if (proceso.estado === "PROCESSING") {
    const resultado = await consultarProcesoConsulta(proceso.requestId);
    await guardarProceso(proceso.requestId, consultationId, resultado, { esPrueba: false });
    if (
      resultado.tipo === "respuesta" &&
      (resultado.data.status === "TOKEN_ACCEPTED" || resultado.data.status === "TOKEN_DENIED")
    ) {
      // Cierre detectado por polling: registrar auditoría (sin token: el
      // polling no lo conoce; los efectos con token ya se aplicaron al enviar
      // o se aplican en el próximo envío).
      await registrarAuditoria(user, "atencion_validada_proceso", id, fila.turno.pacienteId, {
        requestId: proceso.requestId,
        consultationId,
        estado: resultado.data.status,
        via: "polling",
      });
      if (resultado.data.status === "TOKEN_ACCEPTED") {
        // Token validado ⇒ recepción automática del paciente (turnos de hoy).
        await recepcionarTrasTokenValidado(user, id, req.log);
        const camposToken = {
          tokenStatus: "ACCEPTED" as TokenEstado,
          tokenValidatedAt: new Date(),
          tokenValidationRequestId: proceso.requestId,
          klinicosReference: resultado.data.klinicos_reference,
          authorizationNumber:
            resultado.data.authorization_number ?? resultado.data.klinicos_reference,
          tokenFailureCode: null,
          tokenFailureMessage: null,
          robotSyncStatus: "COMPLETED" as RobotSyncEstado,
        };
        await db
          .insert(consultasTokenTable)
          .values({ consultationId: id, coverageType: "IOMA", ...camposToken })
          .onConflictDoUpdate({ target: consultasTokenTable.consultationId, set: camposToken });
      }
    }
    return void res.json({
      existe: true,
      proceso: resultadoProcesoAJson(proceso.requestId, consultationId, resultado),
      practicaSugerida,
      cie10Sugerido,
    });
  }

  res.json({ existe: true, proceso: filaProcesoAJson(proceso), practicaSugerida, cie10Sugerido });
});

router.post("/turnos/:id/validacion-proceso", async (req, res) => {
  const user = await getUser(req);
  if (!user) return void res.status(401).json({ error: "No autenticado" });
  if (!ROLES_OPERACION.includes(user.rol))
    return void res.status(403).json({ error: "Sin permisos para validar atenciones" });
  if (!consultasProcessHabilitadas())
    return void res
      .status(503)
      .json({ error: "El circuito de validación de atención no está habilitado" });

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return void res.status(400).json({ error: "ID inválido" });

  const parsed = ValidarAtencionTurnoBody.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: "Datos inválidos" });
  const b = parsed.data;
  const token = b.token.trim();
  if (token === "") return void res.status(400).json({ error: "Token requerido" });

  const fila = await cargarContextoTurno(id);
  if (!fila) return void res.status(404).json({ error: "Turno no encontrado" });
  const { turno, paciente, turnera } = fila;

  if (!paciente.activo)
    return void res.status(400).json({ error: "El paciente del turno no está activo en Conectar" });
  if (!/^\d{6,9}$/.test(paciente.dni ?? ""))
    return void res
      .status(400)
      .json({ error: "El paciente no tiene DNI válido (6 a 9 dígitos, sin puntos)" });
  // Nro. de afiliado ya NO es obligatorio: el Robot lo completa por padrón (DNI).
  if ((paciente.cobertura ?? "").trim().toUpperCase() !== "IOMA")
    return void res.status(400).json({
      error: `La cobertura del paciente es "${paciente.cobertura ?? "sin cobertura"}", no IOMA. La validación exige afiliación IOMA.`,
    });

  // Práctica: la indicada por el operador o la sugerida por reglas.
  let practicaId = b.practicaId?.trim() || null;
  let practicaCodigo = b.practicaCodigo?.trim() || practicaId;
  let practicaDescripcion = b.practicaDescripcion?.trim() || null;
  if (!practicaId) {
    const sugerida = await sugerirPractica(fila.especialidad, turno.motivoConsulta);
    if (!sugerida?.id)
      return void res.status(400).json({
        error:
          "No hay práctica configurada para esta consulta. Elegí una práctica del catálogo institucional.",
      });
    practicaId = sugerida.id;
    practicaCodigo = sugerida.codigo ?? sugerida.id;
    practicaDescripcion = practicaDescripcion ?? sugerida.nombre;
  }

  // Diagnóstico CIE-10: el indicado o el sugerido; SIEMPRE validado contra
  // el catálogo institucional (nunca se inventa).
  let cie10 = normalizarCie10(b.diagnosisCode);
  let cie10Descripcion = b.diagnosisDescripcion?.trim() || null;
  if (!cie10) {
    const sugerido = await sugerirCie10(id, fila.especialidad);
    cie10 = normalizarCie10(sugerido?.codigo ?? undefined);
    cie10Descripcion = cie10Descripcion ?? sugerido?.descripcion ?? null;
  }
  if (!cie10)
    return void res
      .status(400)
      .json({ error: "Falta el diagnóstico CIE-10 (no hay sugerencia disponible)" });
  const errorCie10 = await validarCie10Catalogo(cie10);
  if (errorCie10) return void res.status(400).json({ error: errorCie10 });

  // Un consultation_id por turno; un request_id por consultation_id.
  const consultationId = `turno-${id}`;
  const [previo] = await db
    .select()
    .from(klinicosConsultasProcesosTable)
    .where(eq(klinicosConsultasProcesosTable.consultationId, consultationId))
    .limit(1);
  const requestId = previo?.requestId ?? randomUUID();
  if (previo && previo.estado === "TOKEN_ACCEPTED")
    return void res.status(409).json({
      error: "Esta atención ya fue validada con éxito (token aplicado). No se reenvía.",
    });

  const limite = pruebaRateLimitOk(user.id);
  if (!limite.ok) return void res.status(429).json({ error: limite.motivo });

  // Sede real desde la turnera (site del contrato).
  let sede: { id: number; nombre: string } | null = null;
  if (turnera.sedeId != null) {
    const [s] = await db
      .select({ id: sedesTable.id, nombre: sedesTable.nombre })
      .from(sedesTable)
      .where(eq(sedesTable.id, turnera.sedeId))
      .limit(1);
    sede = s ?? null;
  }

  const scheduledAt = armarScheduledAt(turno.fecha, turno.horaInicio);
  // Payload SIN médico, matrícula ni especialidad: el Robot deriva el
  // profesional desde practice.id según su configuración aprobada.
  const entrada: ConsultaProcesoEntrada = {
    request_id: requestId,
    consultation_id: consultationId,
    patient: {
      document_type: "DNI",
      document_number: paciente.dni ?? "",
      first_name: paciente.nombre,
      last_name: paciente.apellido,
      birth_date: paciente.fechaNacimiento?.trim() || null,
      affiliate_number: paciente.nroAfiliado?.trim() ?? "",
      affiliate_type: null,
    },
    coverage: { insurer: "IOMA", plan: paciente.planCobertura?.trim() || null },
    practice: {
      id: practicaId,
      code: practicaCodigo || practicaId,
      // Klinicos solo acepta el código de prestación: nunca enviar letras.
      description: null,
      catalog: "IOMA",
      quantity: 1,
    },
    site: sede ? { id: String(sede.id), name: sede.nombre } : null,
    scheduled_at: scheduledAt,
    diagnosis: { code: cie10, description: cie10Descripcion },
    token,
  };

  pruebaEnVuelo.add(user.id);
  let resultado: ResultadoProceso;
  try {
    resultado = await procesarConsultaConRobot(entrada);
  } finally {
    pruebaEnVuelo.delete(user.id);
  }

  await guardarProceso(requestId, consultationId, resultado, {
    tokenMasked: enmascararToken(token),
    practiceId: practicaId,
    practiceCode: practicaCodigo || practicaId,
    pacienteDni: paciente.dni ?? undefined,
    scheduledAt,
    esPrueba: false,
  });

  await aplicarEfectosProceso(user, turno, requestId, token, resultado);

  if (resultado.tipo === "error" && resultado.clase === "no_autorizado") {
    req.log.error(
      { requestId, operador: user.email },
      "robot-consultas: el Robot rechazó la clave de API (HTTP 401) — revisar ROBOT_API_KEY",
    );
  }

  // Log SIN DNI y SIN token (solo enmascarado).
  req.log.info(
    {
      requestId,
      consultationId,
      turnoId: id,
      token: enmascararToken(token),
      estado: resultado.tipo === "respuesta" ? resultado.data.status : `ERROR:${resultado.clase}`,
      latenciaMs: resultado.latenciaMs,
      operador: user.email,
    },
    "robot-consultas: validación de atención (circuito productivo)",
  );

  res.json(resultadoProcesoAJson(requestId, consultationId, resultado));
});

router.post("/turnos/:id/validacion-proceso/retry", async (req, res) => {
  const user = await getUser(req);
  if (!user) return void res.status(401).json({ error: "No autenticado" });
  if (!ROLES_OPERACION.includes(user.rol))
    return void res.status(403).json({ error: "Sin permisos para validar atenciones" });
  if (!consultasProcessHabilitadas())
    return void res
      .status(503)
      .json({ error: "El circuito de validación de atención no está habilitado" });

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return void res.status(400).json({ error: "ID inválido" });

  const consultationId = `turno-${id}`;
  const [proceso] = await db
    .select()
    .from(klinicosConsultasProcesosTable)
    .where(eq(klinicosConsultasProcesosTable.consultationId, consultationId))
    .limit(1);
  if (!proceso)
    return void res.status(404).json({ error: "El turno no tiene proceso de validación iniciado" });

  const limite = pruebaRateLimitOk(user.id);
  if (!limite.ok) return void res.status(429).json({ error: limite.motivo });

  const resultado = await reintentarProcesoConsulta(proceso.requestId);
  await guardarProceso(proceso.requestId, consultationId, resultado, { esPrueba: false });

  // 409 del retry = token vencido en el Robot → TOKEN_REENTRY_REQUIRED local.
  let cuerpo = resultadoProcesoAJson(proceso.requestId, consultationId, resultado);
  if (resultado.tipo === "error" && resultado.clase === "conflicto") {
    await db
      .update(klinicosConsultasProcesosTable)
      .set({ estado: "TOKEN_REENTRY_REQUIRED", reasonMessage: resultado.mensaje })
      .where(eq(klinicosConsultasProcesosTable.requestId, proceso.requestId));
    cuerpo = {
      ...cuerpo,
      estado: "TOKEN_REENTRY_REQUIRED",
      mensaje: mensajePorEstado("TOKEN_REENTRY_REQUIRED"),
      requiereAccionManual: true,
    };
  }

  req.log.info(
    {
      requestId: proceso.requestId,
      consultationId,
      turnoId: id,
      estado: resultado.tipo === "respuesta" ? resultado.data.status : `ERROR:${resultado.clase}`,
      latenciaMs: resultado.latenciaMs,
      operador: user.email,
    },
    "robot-consultas: reintento de validación de atención (circuito productivo)",
  );
  res.json(cuerpo);
});

// Bandeja administrativa: casos productivos MAPPING_REQUIRED (pendientes de
// configuración de equivalencias en el panel del Robot). Sin DNI ni afiliado.
router.get("/robot-klinicos/consultas/pendientes-configuracion", async (req, res) => {
  const user = await getUser(req);
  if (!user) return void res.status(401).json({ error: "No autenticado" });
  if (user.rol !== "admin") return void res.status(403).json({ error: "Solo administradores" });

  const filas = await db
    .select()
    .from(klinicosConsultasProcesosTable)
    .where(
      and(
        eq(klinicosConsultasProcesosTable.estado, "MAPPING_REQUIRED"),
        eq(klinicosConsultasProcesosTable.esPrueba, false),
      ),
    )
    .orderBy(sql`${klinicosConsultasProcesosTable.updatedAt} DESC`);

  const pendientes = await Promise.all(
    filas.map(async (p) => {
      let turnoId: number | null = null;
      const m = /^turno-(\d+)$/.exec(p.consultationId);
      if (m) turnoId = Number(m[1]);
      let pacienteNombre: string | null = null;
      let especialidad: string | null = null;
      if (turnoId) {
        const [t] = await db
          .select({
            nombre: pacientesTable.nombre,
            apellido: pacientesTable.apellido,
            klinicosEspecialidad: turnerasTable.klinicosEspecialidad,
            especialidadId: turnerasTable.especialidadId,
          })
          .from(turnosTable)
          .innerJoin(pacientesTable, eq(pacientesTable.id, turnosTable.pacienteId))
          .leftJoin(turnerasTable, eq(turnerasTable.id, turnosTable.turneraId))
          .where(eq(turnosTable.id, turnoId))
          .limit(1);
        if (t) {
          pacienteNombre = `${t.apellido}, ${t.nombre}`;
          especialidad = t.klinicosEspecialidad ?? null;
          if (!especialidad && t.especialidadId) {
            const [esp] = await db
              .select({ nombre: especialidadesTable.nombre })
              .from(especialidadesTable)
              .where(eq(especialidadesTable.id, t.especialidadId))
              .limit(1);
            especialidad = esp?.nombre ?? null;
          }
        }
      }
      // Descripción de la práctica: catálogo local por código IOMA.
      let practiceDescripcion: string | null = null;
      if (p.practiceCode) {
        const [cat] = await db
          .select({ nombre: klinicosPracticas.nombre, codigos: klinicosPracticas.codigos })
          .from(klinicosPracticas)
          .where(sql`${p.practiceCode} = ANY(${klinicosPracticas.codigos})`)
          .limit(1);
        practiceDescripcion = cat?.nombre ?? null;
      }
      let mapeos: unknown[] = [];
      try {
        mapeos = p.mappingRequired ? JSON.parse(p.mappingRequired) : [];
      } catch {
        mapeos = [];
      }
      return {
        requestId: p.requestId,
        consultationId: p.consultationId,
        turnoId,
        estado: p.estado,
        paciente: pacienteNombre,
        practiceId: p.practiceId,
        practiceCode: p.practiceCode,
        practiceDescripcion,
        especialidad,
        mapeosPendientes: mapeos,
        motivo: p.reasonMessage,
        actualizadoEn: p.updatedAt ? p.updatedAt.toISOString() : null,
      };
    }),
  );

  res.json({ pendientes });
});

router.get("/robot-klinicos/consultas/salud", async (req, res) => {
  const user = await getUser(req);
  if (!user) return void res.status(401).json({ error: "No autenticado" });
  if (user.rol !== "admin") return void res.status(403).json({ error: "Solo administradores" });

  const salud = await saludConsultasRobot();
  if (!salud.ok) {
    return void res.json({
      disponible: false,
      habilitadoEnRobot: null,
      sandbox: null,
      mensaje: salud.mensaje,
      cola: null,
      totalesPorEstado: {},
      timestamp: null,
    });
  }
  res.json({
    disponible: true,
    habilitadoEnRobot: salud.data.enabled,
    sandbox: salud.data.sandbox,
    mensaje: null,
    cola: salud.data.queue
      ? {
          operacionesPendientes: salud.data.queue.pending_operations ?? null,
          posicionAproximada: salud.data.queue.approx_position ?? null,
          esperaEstimadaSegundos: salud.data.queue.estimated_wait_seconds ?? null,
          sesionKlinicosDisponible: salud.data.queue.klinicos_session_available ?? null,
        }
      : null,
    totalesPorEstado: salud.data.totalsByStatus,
    timestamp: salud.data.timestamp,
  });
});

export default router;
