// ── Guardia virtual (videollamadas) — endpoints entrantes del portal ───────
// El portal Mi Diagnosticar nos llama de servidor a servidor con la clave
// compartida (la misma del push de certificados) para:
//   1. Anotar a un paciente IOMA en la cola de la guardia virtual (antesala).
//   2. Mandarnos DNI + token IOMA: con token válido se crea el turno de
//      guardia (modalidad videoconsulta) y la consulta en Klinicos.
// Regla inviolable (facturación): la consulta Klinicos NO se crea antes del
// token válido — eso lo garantiza el endpoint interno /validar-token.
// Nosotros les empujamos los avisos (en_cola / tu_turno / cancelada /
// finalizada) por la cola de app-paciente-videollamadas.
//
// Horario de la guardia virtual (Federico, ago 2026; #314 lo hará
// configurable): lunes a sábado 8-19, domingo 12-18. Solo IOMA.

import { Router, type Request, type Response, type NextFunction, type IRouter } from "express";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import {
  db,
  videollamadasColaTable,
  turnosTable,
  turnerasTable,
  especialidadesTable,
  configSistemaTable,
  usersTable,
  sesionesTable,
} from "@workspace/db";
import { hoyArgentina, horaArgentina } from "../lib/tiempo";
import { urlVideollamadaTurno } from "../lib/videollamada-turno";
import {
  encolarEnvioVideollamada,
  pushVideollamadasHabilitado,
} from "../integraciones/app-paciente-videollamadas";
import { leerConfigGuardia, dentroDeHorario } from "./guardia_virtual";

const router: IRouter = Router();

const BASE = "/integraciones/app-paciente/videollamadas";
const MINUTOS_POR_PACIENTE = 15;
const TIMEZONE = "America/Argentina/Buenos_Aires";

// ── Auth: clave compartida con el portal (patrón integracion_autologin) ─────

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
    req.log.warn("integracion-videollamadas: clave compartida inválida o faltante");
    res.status(401).json({ error: "Clave compartida inválida o faltante" });
    return;
  }
  next();
}

// ── Horario de atención ──────────────────────────────────────────────────────

function diaSemanaArgentina(): number {
  // 0=domingo ... 6=sábado
  const nombre = new Intl.DateTimeFormat("en-US", { timeZone: TIMEZONE, weekday: "short" }).format(new Date());
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(nombre);
}

// Lee la MISMA configuración que administra el staff desde "Editar turnera"
// (antes estaba hardcodeado L-S 8-19 y el portal decía "cerrada" aunque la
// guardia estuviera habilitada).
export async function horarioGuardiaVirtual(): Promise<{ abierto: boolean; horario: string; apertura: string; cierre: string }> {
  const config = await leerConfigGuardia();
  const esDomingo = diaSemanaArgentina() === 0;
  const h = config.horario;
  const [apertura, cierre] = esDomingo ? [h.dInicio, h.dFin] : [h.lsInicio, h.lsFin];
  return {
    abierto: config.activa && dentroDeHorario(h),
    horario: `Lunes a sábado de ${h.lsInicio} a ${h.lsFin} hs, domingo de ${h.dInicio} a ${h.dFin} hs`,
    apertura,
    cierre,
  };
}

function esIoma(obraSocial: string | undefined | null): boolean {
  if (!obraSocial) return false;
  // Tolerante a variantes de escritura: "IOMA", "I.O.M.A.", "i o m a", con acentos, etc.
  const limpio = obraSocial
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return limpio.includes("IOMA");
}

// ── Turnera de guardia para las videollamadas ────────────────────────────────
// Config `videollamadas_guardia_turnera_id` manda; sin config, la primera
// agenda de guardia activa de Clínica Médica.

async function turneraGuardiaVirtual(): Promise<{ id: number; especialidadId: number | null } | null> {
  // Primero la turnera elegida en la config de guardia virtual (Editar turnera).
  const configGuardia = await leerConfigGuardia();
  if (configGuardia.turneraId != null) {
    const [t] = await db
      .select({ id: turnerasTable.id, especialidadId: turnerasTable.especialidadId })
      .from(turnerasTable)
      .where(and(eq(turnerasTable.id, configGuardia.turneraId), eq(turnerasTable.activa, true)))
      .limit(1);
    if (t) return t;
  }
  const [cfg] = await db
    .select({ valor: configSistemaTable.valor })
    .from(configSistemaTable)
    .where(eq(configSistemaTable.clave, "videollamadas_guardia_turnera_id"))
    .limit(1);
  if (cfg) {
    const id = Number(cfg.valor);
    if (Number.isInteger(id) && id > 0) {
      const [t] = await db
        .select({ id: turnerasTable.id, especialidadId: turnerasTable.especialidadId })
        .from(turnerasTable)
        .where(and(eq(turnerasTable.id, id), eq(turnerasTable.activa, true)))
        .limit(1);
      if (t) return t;
    }
  }
  const filas = await db
    .select({
      id: turnerasTable.id,
      especialidadId: turnerasTable.especialidadId,
      especialidadNombre: especialidadesTable.nombre,
    })
    .from(turnerasTable)
    .leftJoin(especialidadesTable, eq(turnerasTable.especialidadId, especialidadesTable.id))
    .where(and(eq(turnerasTable.esGuardia, true), eq(turnerasTable.activa, true)));
  const clinica = filas.find((f) =>
    (f.especialidadNombre ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().includes("CLINICA"),
  );
  const elegida = clinica ?? filas[0];
  return elegida ? { id: elegida.id, especialidadId: elegida.especialidadId } : null;
}

// ── Posición y demora estimada ───────────────────────────────────────────────
// Aproximación honesta: pacientes esperando HOY en la turnera de guardia
// (arribo/en_sala) + anotados de la antesala sin turno todavía, delante de
// la fila dada (o todos, para un nuevo ingreso).

async function posicionYDemora(turneraId: number, colaIdPropia?: number): Promise<{ posicion: number; demoraMinutos: number; enAtencion: boolean }> {
  const hoy = hoyArgentina();
  const esperando = await db
    .select({ id: turnosTable.id, estado: turnosTable.estado })
    .from(turnosTable)
    .where(
      and(
        eq(turnosTable.turneraId, turneraId),
        eq(turnosTable.fecha, hoy),
        inArray(turnosTable.estado, ["arribo", "en_sala", "llamado"]),
      ),
    );
  const enEspera = esperando.filter((t) => t.estado !== "llamado").length;
  const enAtencion = esperando.some((t) => t.estado === "llamado");

  const condiciones = [eq(videollamadasColaTable.estado, "en_cola")];
  if (colaIdPropia != null) condiciones.push(lt(videollamadasColaTable.id, colaIdPropia));
  const anotadosSinTurno = await db
    .select({ id: videollamadasColaTable.id })
    .from(videollamadasColaTable)
    .where(and(...condiciones));

  const delante = enEspera + anotadosSinTurno.length;
  const posicion = delante + 1;
  return { posicion, demoraMinutos: delante * MINUTOS_POR_PACIENTE, enAtencion };
}

// ── Sesión interna de sistema para reusar los endpoints reales ──────────────
// Regla del proyecto: las integraciones NUNCA reimplementan la lógica de
// negocio — el turno de guardia se crea con POST /turnos y el token se valida
// con POST /turnos/:id/validar-token, vía una sesión efímera de un usuario
// staff activo (recepcionista o admin).

async function conSesionSistema<T>(fn: (headers: Record<string, string>) => Promise<T>): Promise<T> {
  const [staff] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(and(inArray(usersTable.rol, ["recepcionista", "admin"]), eq(usersTable.activo, "true")))
    .orderBy(usersTable.id)
    .limit(1);
  if (!staff) throw new Error("No hay usuario staff activo para la sesión de sistema");
  const token = `vcsys-${randomUUID()}${randomUUID().replace(/-/g, "")}`;
  const expiresAt = new Date(Date.now() + 10 * 60_000);
  await db.insert(sesionesTable).values({ token, usuarioId: staff.id, activa: true, expiresAt });
  try {
    return await fn({ "Content-Type": "application/json", Authorization: `Bearer ${token}` });
  } finally {
    void db.update(sesionesTable).set({ activa: false }).where(eq(sesionesTable.token, token)).catch(() => {});
  }
}

function apiInterna(path: string): string {
  return `http://localhost:${process.env.PORT ?? "8080"}/api${path}`;
}

// ── GET status (sin auth, espejo del /status del portal) ────────────────────

router.get(`${BASE}/status`, async (_req, res) => {
  const h = await horarioGuardiaVirtual();
  const turnera = await turneraGuardiaVirtual();
  res.json({
    ok: true,
    configurado: Boolean(turnera),
    pushHabilitado: pushVideollamadasHabilitado(),
    abierto: h.abierto && Boolean(turnera),
    horario: h.horario,
  });
});

// ── GET espera: cálculo en vivo de la sala grupal de guardia ────────────────
// La videoconsulta NO es con turno programado: no hay horarios para elegir.
// El portal debe mostrar la espera aproximada de la cola de la guardia médica
// ambulatoria (sala grupal), calculada en vivo: pacientes esperando hoy en la
// guardia + anotados en la antesala virtual. Sin datos personales → sin auth,
// igual que /status.

router.get(`${BASE}/espera`, async (_req, res): Promise<void> => {
  const h = await horarioGuardiaVirtual();
  const turnera = await turneraGuardiaVirtual();
  if (!turnera) {
    res.status(503).json({ error: "La guardia virtual no está configurada (sin agenda de guardia activa)" });
    return;
  }
  const { posicion, demoraMinutos, enAtencion } = await posicionYDemora(turnera.id);
  res.json({
    ok: true,
    modalidad: "cola_de_espera", // no hay turnos ni horarios: es por orden de llegada
    abierto: h.abierto,
    horario: h.horario,
    enEspera: posicion - 1,
    guardiaAtendiendo: enAtencion,
    esperaAproximadaMin: demoraMinutos,
    mensaje: h.abierto
      ? `Espera aproximada: ${demoraMinutos} minutos (${posicion - 1} en espera). La atención es por orden de llegada, sin turno.`
      : `La guardia virtual está cerrada ahora. Horario: ${h.horario}.`,
  });
});

router.use(`${BASE}/cola`, requireTokenCompartido);
router.use(`${BASE}/token`, requireTokenCompartido);

// ── POST cola: anotarse en la antesala ───────────────────────────────────────
// Body: { dni, nombre?, apellido?, telefono?, obraSocial }
// Idempotente por DNI: si ya hay una fila viva para ese DNI, se devuelve esa.

router.post(`${BASE}/cola`, async (req, res): Promise<void> => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const dni = typeof b.dni === "string" ? b.dni.replace(/\D/g, "") : "";
  if (dni.length < 6 || dni.length > 9) {
    res.status(400).json({ error: "DNI inválido" });
    return;
  }
  const obraSocial = typeof b.obraSocial === "string" ? b.obraSocial.trim() : "";
  if (!esIoma(obraSocial)) {
    res.status(422).json({
      error: "Tu obra social todavía no tiene este servicio. Por ahora la guardia virtual es solo para afiliados de IOMA.",
      codigo: "obra_social_sin_servicio",
    });
    return;
  }
  const h = await horarioGuardiaVirtual();
  if (!h.abierto) {
    res.status(409).json({
      error: `La guardia virtual está cerrada ahora. Horario: ${h.horario}.`,
      codigo: "fuera_de_horario",
      horario: h.horario,
    });
    return;
  }
  const turnera = await turneraGuardiaVirtual();
  if (!turnera) {
    res.status(503).json({ error: "La guardia virtual no está configurada (sin agenda de guardia activa)" });
    return;
  }

  const nombre = typeof b.nombre === "string" ? b.nombre.trim() || null : null;
  const apellido = typeof b.apellido === "string" ? b.apellido.trim() || null : null;
  const telefono = typeof b.telefono === "string" ? b.telefono.trim() || null : null;
  const motivo = typeof b.motivo === "string" ? b.motivo.trim().slice(0, 500) || null : null;

  // Reenvíos del portal: si el DNI ya está en la cola viva, no se duplica.
  // Advisory lock transaccional por DNI: dos requests simultáneos del mismo
  // DNI se serializan (select viva → insert atómico, sin fila duplicada).
  const { posicion, demoraMinutos, enAtencion } = await posicionYDemora(turnera.id);
  const { viva, creada } = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`gv-cola-${dni}`}))`);
    const [existente] = await tx
      .select()
      .from(videollamadasColaTable)
      .where(
        and(
          eq(videollamadasColaTable.dni, dni),
          inArray(videollamadasColaTable.estado, ["en_cola", "recepcionado", "tu_turno"]),
        ),
      )
      .limit(1);
    if (existente) return { viva: existente, creada: null };
    const [nueva] = await tx
      .insert(videollamadasColaTable)
      .values({
        dni,
        nombre,
        apellido,
        telefono,
        obraSocial,
        motivo,
        posicionInicial: posicion,
        demoraEstimadaMin: demoraMinutos,
      })
      .returning();
    return { viva: null, creada: nueva };
  });

  if (viva) {
    const pd = await posicionYDemora(turnera.id, viva.id);
    const yaCargoToken = viva.estado !== "en_cola" || viva.turnoId != null;
    res.json({
      colaId: viva.id,
      estado: viva.estado,
      posicion: pd.posicion,
      demoraMinutos: pd.demoraMinutos,
      guardiaAtendiendo: pd.enAtencion,
      repetido: true,
      siguientePaso: yaCargoToken ? "esperar_llamado" : "cargar_token",
      mensaje: yaCargoToken
        ? `Ya estabas anotado y tu lugar está reservado (posición ${pd.posicion}). No hace falta hacer nada más: te avisamos por acá cuando el médico te llame.`
        : `Ya estabas anotado (posición ${pd.posicion}). Para confirmar tu lugar, generá el token en tu app de IOMA y cargalo acá.`,
    });
    return;
  }
  if (!creada) {
    res.status(500).json({ error: "No se pudo anotar en la guardia virtual" });
    return;
  }

  void encolarEnvioVideollamada(creada.id, "en_cola", { posicion, demoraMinutos });
  req.log.info({ colaId: creada.id, posicion }, "guardia-virtual: paciente anotado en la antesala");
  res.status(201).json({
    colaId: creada.id,
    estado: "en_cola",
    posicion,
    demoraMinutos,
    guardiaAtendiendo: enAtencion,
    horario: h.horario,
    siguientePaso: "cargar_token",
    mensaje: `Listo, quedaste anotado en la guardia virtual (posición ${posicion}). Ahora generá el token en tu app de IOMA y cargalo acá para confirmar tu lugar.`,
    instrucciones: [
      "Abrí la app de IOMA y generá un token nuevo.",
      "Cargá el token acá apenas lo tengas: los tokens vencen a los pocos minutos.",
      "Con el token aceptado quedás en la fila y te avisamos cuando el médico te llame por videollamada.",
    ],
  });
});

// ── POST token: DNI + token IOMA → turno de guardia + validación ────────────
// Body: { colaId?, dni, token, nombre?, apellido?, telefono? }
// Reintentable: si el token falla, la fila queda en_cola y el portal puede
// volver a mandar otro token con el mismo colaId.

router.post(`${BASE}/token`, async (req, res): Promise<void> => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const dni = typeof b.dni === "string" ? b.dni.replace(/\D/g, "") : "";
  const tokenIoma = typeof b.token === "string" ? b.token.replace(/\s+/g, "") : "";
  if (dni.length < 6 || dni.length > 9) {
    res.status(400).json({ error: "DNI inválido" });
    return;
  }
  if (!tokenIoma) {
    res.status(400).json({ error: "Token requerido" });
    return;
  }

  const colaId = Number(b.colaId);
  const condiciones = [
    eq(videollamadasColaTable.dni, dni),
    inArray(videollamadasColaTable.estado, ["en_cola", "recepcionado"]),
  ];
  if (Number.isInteger(colaId) && colaId > 0) condiciones.push(eq(videollamadasColaTable.id, colaId));
  const [fila] = await db
    .select()
    .from(videollamadasColaTable)
    .where(and(...condiciones))
    .limit(1);
  if (!fila) {
    res.status(404).json({ error: "No hay una espera activa para ese DNI. Anotate primero en la guardia virtual." });
    return;
  }

  const turnera = await turneraGuardiaVirtual();
  if (!turnera) {
    res.status(503).json({ error: "La guardia virtual no está configurada" });
    return;
  }

  const nombre = (typeof b.nombre === "string" && b.nombre.trim()) || fila.nombre || "Paciente";
  const apellido = (typeof b.apellido === "string" && b.apellido.trim()) || fila.apellido || "Guardia virtual";
  const telefono = (typeof b.telefono === "string" && b.telefono.trim()) || fila.telefono || undefined;

  try {
    const resultado = await conSesionSistema(async (headers) => {
      // 1) Turno de guardia (una sola vez por fila; reintentos reusan el turno).
      let turnoId = fila.turnoId;
      if (turnoId == null) {
        const resp = await fetch(apiInterna("/turnos"), {
          method: "POST",
          headers,
          body: JSON.stringify({
            turneraId: turnera.id,
            pacienteDni: dni,
            pacienteNombre: nombre,
            pacienteApellido: apellido,
            ...(telefono ? { pacienteTelefono: telefono } : {}),
            cobertura: "IOMA",
            fecha: hoyArgentina(),
            horaInicio: horaArgentina(),
            modalidad: "videoconsulta",
            motivoConsulta: fila.motivo ?? "Guardia virtual (videollamada)",
            observaciones: "Origen: guardia virtual Mi Diagnosticar",
          }),
        });
        const data = (await resp.json().catch(() => ({}))) as { id?: number; pacienteId?: number; error?: string };
        if (!resp.ok || !data.id) {
          return { status: 502 as number, body: { error: data.error ?? `No se pudo crear el turno de guardia (HTTP ${resp.status})` } };
        }
        turnoId = data.id;
        // Reclamo atómico de la fila: solo gana quien la encuentra sin turno.
        // Si otro request simultáneo ya le puso turno, cancelamos el duplicado
        // recién creado y seguimos con el turno que quedó en la fila.
        const claim = await db
          .update(videollamadasColaTable)
          .set({
            turnoId,
            ...(data.pacienteId ? { pacienteId: data.pacienteId } : {}),
            actualizadoEn: new Date(),
          })
          .where(and(eq(videollamadasColaTable.id, fila.id), isNull(videollamadasColaTable.turnoId)))
          .returning();
        if (claim.length === 0) {
          await fetch(apiInterna(`/turnos/${turnoId}/cancelar`), { method: "POST", headers, body: "{}" }).catch(() => {});
          const [refrescada] = await db
            .select({ turnoId: videollamadasColaTable.turnoId })
            .from(videollamadasColaTable)
            .where(eq(videollamadasColaTable.id, fila.id))
            .limit(1);
          if (refrescada?.turnoId == null) {
            return { status: 502 as number, body: { error: "No se pudo asociar el turno de guardia. Probá de nuevo.", reintentable: true } };
          }
          turnoId = refrescada.turnoId;
        }
      }

      // 2) Validar el token (crea la consulta Klinicos SOLO si es válido).
      const respTok = await fetch(apiInterna(`/turnos/${turnoId}/validar-token`), {
        method: "POST",
        headers,
        body: JSON.stringify({ token: tokenIoma }),
      });
      const tok = (await respTok.json().catch(() => ({}))) as {
        estado?: string;
        mensaje?: string;
        error?: string;
        reintentable?: boolean;
        nroBono?: string | null;
      };
      if (!respTok.ok) {
        return {
          status: respTok.status >= 500 ? 502 : respTok.status,
          body: { error: tok.error ?? "No se pudo validar el token", reintentable: true },
        };
      }
      if (tok.estado !== "TOKEN_ACCEPTED") {
        return {
          status: 422 as number,
          body: {
            estado: tok.estado ?? "TOKEN_DENIED",
            error: tok.mensaje ?? "El token no fue aceptado. Revisá que sea el token del día y probá de nuevo.",
            reintentable: tok.reintentable ?? false,
            siguientePaso: "reintentar_token",
            mensaje:
              tok.estado === "TOKEN_DENIED"
                ? "Tranquilo: no perdiste tu lugar en la fila ni se gastó nada. Generá un token nuevo en tu app de IOMA (los tokens vencen rápido), fijate de copiarlo bien y cargalo de nuevo acá."
                : "No perdiste tu lugar en la fila y tu token no se gastó. Hubo un problema al validar con la obra social: esperá unos minutos y probá de nuevo, o comunicate con la clínica para que te ayuden.",
          },
        };
      }

      // 3) Token aceptado → recepcionado en la cola virtual.
      const { posicion, demoraMinutos } = await posicionYDemora(turnera.id, fila.id);
      await db
        .update(videollamadasColaTable)
        .set({ estado: "recepcionado", ultimaPosicionAvisada: posicion, actualizadoEn: new Date() })
        .where(eq(videollamadasColaTable.id, fila.id));
      void encolarEnvioVideollamada(fila.id, "en_cola", { posicion, demoraMinutos });
      return {
        status: 200 as number,
        body: {
          ok: true,
          estado: "recepcionado",
          colaId: fila.id,
          turnoId,
          posicion,
          demoraMinutos,
          siguientePaso: "esperar_llamado",
          mensaje: `¡Token aceptado! Tu consulta ya quedó autorizada por IOMA y tenés tu lugar en la fila (posición ${posicion}, espera aproximada ${demoraMinutos} min). No hace falta cargar otro token. Dejá la app abierta: te avisamos por acá cuando el médico te llame por videollamada.`,
          instrucciones: [
            "No cierres la app: el aviso de la videollamada llega por acá.",
            "Cuando sea tu turno, se va a abrir el enlace de la videollamada.",
            "Si se te corta, volvé a entrar: tu lugar queda guardado con tu DNI.",
          ],
        },
      };
    });
    res.status(resultado.status).json(resultado.body);
  } catch (err) {
    req.log.error({ err, colaId: fila.id }, "guardia-virtual: error procesando token");
    res.status(500).json({ error: "Error interno procesando el token", reintentable: true });
  }
});

// ── GET link de videollamada de un turno (staff, para el médico) ─────────────

router.get("/turnos/:id/videollamada", async (req, res): Promise<void> => {
  const { getUserFromRequest } = await import("./auth");
  const user = await getUserFromRequest(req);
  if (!user || user.activo !== "true" || user.rol === "paciente") {
    res.status(401).json({ error: "No autenticado" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "ID inválido" });
    return;
  }
  const [turno] = await db
    .select({ modalidad: turnosTable.modalidad, qrCodigo: turnosTable.qrCodigo, estado: turnosTable.estado })
    .from(turnosTable)
    .where(eq(turnosTable.id, id))
    .limit(1);
  if (!turno) {
    res.status(404).json({ error: "Turno no encontrado" });
    return;
  }
  const url = urlVideollamadaTurno(turno);
  if (!url) {
    res.status(404).json({ error: "El turno no tiene videollamada (no es una videoconsulta)" });
    return;
  }
  res.json({ url });
});

export default router;
