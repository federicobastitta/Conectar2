// ── Guardia Virtual: antesala pública para videollamadas IOMA ──────────────
//
// Flujo completo:
//   1. GET  /publico/guardia-virtual/estado            → disponibilidad + demora
//   2. POST /publico/guardia-virtual/registros         → crear sesión (pre_registro)
//   3. POST /publico/guardia-virtual/registros/:t/validar-token → IOMA + turno
//   4. GET  /publico/guardia-virtual/registros/:t/estado       → polling
//   5. POST /publico/guardia-virtual/registros/:t/abandonar    → cancelar
//
// Auth: x-api-key (mismo API_PUBLICA_KEY que /publico/turnos).
// Regla inviolable: ningún turno ni trabajo Klinicos se crea antes de
// TOKEN_ACCEPTED + bono real.

import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual, randomBytes } from "node:crypto";
import { eq, and, inArray, sql } from "drizzle-orm";
import {
  db,
  guardiaVirtualSesionesTable,
  turnosTable,
  turnerasTable,
  pacientesTable,
  consultasTokenTable,
  klinicosTrabajos,
  configSistemaTable,
  videollamadasColaTable,
} from "@workspace/db";
import { hoyArgentina, horaArgentina } from "../lib/tiempo";
import { requireRol } from "./auth";
import { crearEstimadorEspera } from "../lib/espera";
import { insertarTurnoGuardia, ErrorSlotOcupado } from "../lib/insertar-turno-guardia";
import { validarTokenGuardiaVirtual } from "../lib/guardia-virtual-token";
import { registrarEventoTurnoRobot } from "../lib/robot-turnos-eventos";
import { urlVideollamadaTurno } from "../lib/videollamada-turno";
import { avanzarFilaGuardia } from "../integraciones/app-paciente-videollamadas";
import { calcularSlotsDisponibles } from "../lib/slots";

const router: IRouter = Router();

// ── Autenticación ─────────────────────────────────────────────────────────

function claveValida(provista: string | undefined): boolean {
  const esperada = process.env.API_PUBLICA_KEY;
  if (!esperada || !provista) return false;
  const a = Buffer.from(provista);
  const b = Buffer.from(esperada);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  if (!process.env.API_PUBLICA_KEY) {
    res.status(503).json({ error: "API pública no configurada" });
    return;
  }
  if (!claveValida(req.header("x-api-key"))) {
    res.status(401).json({ error: "Clave de API inválida o faltante" });
    return;
  }
  next();
}

router.use("/publico/guardia-virtual", requireApiKey);

// ── Rate limiting por IP ──────────────────────────────────────────────────
// Máximo 5 registros por IP por hora (ventana deslizante en memoria).
const registrosPorIp = new Map<string, number[]>();
const LIMITE_POR_HORA = 5;

function ipLimiteSuperado(ip: string): boolean {
  const ahora = Date.now();
  const ventana = ahora - 3_600_000; // 1 hora
  const intentos = (registrosPorIp.get(ip) ?? []).filter((t) => t > ventana);
  registrosPorIp.set(ip, intentos);
  if (intentos.length >= LIMITE_POR_HORA) return true;
  intentos.push(ahora);
  registrosPorIp.set(ip, intentos);
  return false;
}

// Limpieza periódica de la caché de rate-limit (cada 30 min)
setInterval(
  () => {
    const ventana = Date.now() - 3_600_000;
    for (const [ip, intentos] of registrosPorIp.entries()) {
      const validos = intentos.filter((t) => t > ventana);
      if (validos.length === 0) registrosPorIp.delete(ip);
      else registrosPorIp.set(ip, validos);
    }
  },
  30 * 60 * 1000,
).unref?.();

// ── Helpers de configuración ──────────────────────────────────────────────

export interface HorarioGuardia {
  lsInicio: string; // HH:MM Lunes-Sábado
  lsFin: string;
  dInicio: string; // HH:MM Domingo
  dFin: string;
}

const HORARIO_DEFAULT: HorarioGuardia = {
  lsInicio: "08:00",
  lsFin: "19:00",
  dInicio: "12:00",
  dFin: "18:00",
};

// Guardias soportadas: "clinica" (adultos, flujo original) y "pediatrica".
// Cada una tiene su propia agenda (turnera) y su propio switch de activación;
// comparten horario, obras sociales y allowlist presencial.
export type GuardiaTipo = "clinica" | "pediatrica";

export function parseGuardia(valor: unknown): GuardiaTipo | null {
  if (valor === undefined || valor === null || valor === "" || valor === "clinica") return "clinica";
  if (valor === "pediatrica") return "pediatrica";
  return null;
}

export async function leerConfigGuardia(): Promise<{
  activa: boolean;
  turneraId: number | null;
  pediatria: { activa: boolean; turneraId: number | null };
  obrasSociales: string[];
  horario: HorarioGuardia;
  presencialDnisPrueba: string[];
}> {
  const result = await db.execute(
    sql`SELECT clave, valor FROM config_sistema
        WHERE clave IN (
          'guardia_virtual_activa',
          'guardia_virtual_turnera_id',
          'guardia_virtual_pediatria_activa',
          'guardia_virtual_pediatria_turnera_id',
          'guardia_virtual_obras_sociales',
          'guardia_virtual_horario',
          'guardia_presencial_dnis_prueba'
        )`,
  );
  const filas = result.rows as Array<{ clave: string; valor: string }>;

  const cfg = Object.fromEntries(filas.map((f) => [f.clave, f.valor]));

  const activa = cfg["guardia_virtual_activa"]?.trim().toLowerCase() === "true";
  const turneraIdRaw = cfg["guardia_virtual_turnera_id"]
    ? parseInt(cfg["guardia_virtual_turnera_id"], 10)
    : null;
  const turneraId = turneraIdRaw != null && Number.isInteger(turneraIdRaw) ? turneraIdRaw : null;

  const pedActiva = cfg["guardia_virtual_pediatria_activa"]?.trim().toLowerCase() === "true";
  const pedIdRaw = cfg["guardia_virtual_pediatria_turnera_id"]
    ? parseInt(cfg["guardia_virtual_pediatria_turnera_id"], 10)
    : null;
  const pediatria = {
    activa: pedActiva,
    turneraId: pedIdRaw != null && Number.isInteger(pedIdRaw) ? pedIdRaw : null,
  };

  let obrasSociales: string[] = ["IOMA"];
  try {
    if (cfg["guardia_virtual_obras_sociales"]) {
      obrasSociales = JSON.parse(cfg["guardia_virtual_obras_sociales"]) as string[];
    }
  } catch {
    /* usa default */
  }

  let horario: HorarioGuardia = HORARIO_DEFAULT;
  try {
    if (cfg["guardia_virtual_horario"]) {
      horario = { ...HORARIO_DEFAULT, ...(JSON.parse(cfg["guardia_virtual_horario"]) as Partial<HorarioGuardia>) };
    }
  } catch {
    /* usa default */
  }

  // Guardia presencial en pruebas: solo estos DNIs pueden usarla. El valor
  // "*" (un elemento con asterisco) la abre para todos cuando salga de pruebas.
  // "*" = abierto a todos los pacientes con cobertura habilitada (IOMA).
  // Para restringir de nuevo, setear guardia_presencial_dnis_prueba con una
  // lista de DNIs en config_sistema.
  let presencialDnisPrueba: string[] = ["4849369"];
  try {
    if (cfg["guardia_presencial_dnis_prueba"]) {
      const parsed = JSON.parse(cfg["guardia_presencial_dnis_prueba"]) as string[];
      if (Array.isArray(parsed)) presencialDnisPrueba = parsed.map((d) => String(d).replace(/\D/g, "") || String(d));
    }
  } catch {
    /* usa default */
  }

  return { activa, turneraId, pediatria, obrasSociales, horario, presencialDnisPrueba };
}

type ConfigGuardia = Awaited<ReturnType<typeof leerConfigGuardia>>;

/** Activa + turnera del slot pedido ("clinica" = flujo original). */
export function slotDeGuardia(
  config: ConfigGuardia,
  guardia: GuardiaTipo,
): { activa: boolean; turneraId: number | null } {
  return guardia === "pediatrica"
    ? config.pediatria
    : { activa: config.activa, turneraId: config.turneraId };
}

/** true si la hora argentina actual está dentro del horario de guardia virtual */
export function dentroDeHorario(horario: HorarioGuardia): boolean {
  const hora = horaArgentina().substring(0, 5); // HH:MM
  const diaSemana = new Date().getUTCDay(); // 0=domingo... pero hora argentina puede cruzar día UTC
  // Usamos la fecha argentina completa para el día de semana
  const ahora = new Date();
  // Argentino = UTC-3
  const fechaAR = new Date(ahora.getTime() - 3 * 3600 * 1000);
  const dia = fechaAR.getUTCDay(); // 0=domingo

  const [ini, fin] = dia === 0 ? [horario.dInicio, horario.dFin] : [horario.lsInicio, horario.lsFin];
  return hora >= ini && hora < fin;
}

// ── Helpers de fila ───────────────────────────────────────────────────────

// "confirmado" = paciente presencial que validó el token pero todavía no llegó
// a la clínica ("agendado"): ocupa lugar en la fila igual que los recepcionados.
const ESTADOS_ACTIVOS = ["confirmado", "arribo", "recepcionado", "en_sala", "llamado"];

async function infoFila(turneraId: number): Promise<{
  turnosEnEspera: number;
  atencionHoy: number;
  esperaEstimadaMinutos: number | null;
  ofertaPosicion: 1 | 2 | 3 | null;
}> {
  const hoy = hoyArgentina();

  const turnos = await db
    .select({ estado: turnosTable.estado })
    .from(turnosTable)
    .where(
      and(
        eq(turnosTable.turneraId, turneraId),
        eq(turnosTable.fecha, hoy),
        sql`${turnosTable.estado} NOT IN ('cancelado', 'ausente', 'anulado')`,
      ),
    );

  const enEspera = turnos.filter((t) => ESTADOS_ACTIVOS.includes(t.estado)).length;
  const atencionHoy = turnos.length;

  const [turnera] = await db
    .select({ duracionMinutos: turnerasTable.duracionMinutos })
    .from(turnerasTable)
    .where(eq(turnerasTable.id, turneraId))
    .limit(1);

  const duracionMap = new Map([[turneraId, turnera?.duracionMinutos ?? 15]]);
  const estimador = await crearEstimadorEspera(hoy, [turneraId], duracionMap);
  const esperaEstimadaMinutos = estimador.estimar(turneraId, enEspera + 1);

  let ofertaPosicion: 1 | 2 | 3 | null = null;
  if (atencionHoy === 0) ofertaPosicion = 1;
  else if (atencionHoy === 1) ofertaPosicion = 2;
  else if (atencionHoy === 2) ofertaPosicion = 3;

  return { turnosEnEspera: enEspera, atencionHoy, esperaEstimadaMinutos, ofertaPosicion };
}

// ── Generador de sesionToken (80 bits, sin ambigüedad) ─────────────────────

const QR_ALFABETO = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function generarSesionToken(): string {
  const bytes = randomBytes(16);
  let out = "";
  for (let i = 0; i < 16; i++) out += QR_ALFABETO[bytes[i]! % 32];
  return out;
}

// ── Configuración desde la pantalla de administración ─────────────────────
// GET la ven admin y recepción; modificar es solo admin.

const HORA_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

router.get(
  "/guardia-virtual/config",
  requireRol("admin", "recepcionista"),
  async (_req: Request, res: Response): Promise<void> => {
    const config = await leerConfigGuardia();
    res.json({
      activa: config.activa,
      horario: config.horario,
      turneraId: config.turneraId,
      pediatria: config.pediatria,
    });
  },
);

router.put(
  "/guardia-virtual/config",
  requireRol("admin"),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as {
      activa?: unknown;
      horario?: Partial<HorarioGuardia>;
      turneraId?: unknown;
      guardia?: unknown;
      publicasExtraIds?: unknown;
    };

    // ¿Qué guardia se está configurando? Por defecto la de adultos (flujo
    // original, claves de config sin sufijo). "pediatrica" usa claves propias.
    const guardia = parseGuardia(body.guardia);
    if (guardia === null) {
      res.status(400).json({ error: "guardia inválida: usá 'clinica' o 'pediatrica'" });
      return;
    }
    const claveTurnera =
      guardia === "pediatrica" ? "guardia_virtual_pediatria_turnera_id" : "guardia_virtual_turnera_id";
    const claveActiva =
      guardia === "pediatrica" ? "guardia_virtual_pediatria_activa" : "guardia_virtual_activa";

    const cambios: Array<{ clave: string; valor: string }> = [];

    if (body.turneraId !== undefined) {
      const turneraId = Number(body.turneraId);
      if (!Number.isInteger(turneraId) || turneraId <= 0) {
        res.status(400).json({ error: "turneraId inválido" });
        return;
      }
      const [turnera] = await db
        .select({ id: turnerasTable.id, esGuardia: turnerasTable.esGuardia, activa: turnerasTable.activa })
        .from(turnerasTable)
        .where(eq(turnerasTable.id, turneraId))
        .limit(1);
      if (!turnera) {
        res.status(404).json({ error: "La agenda no existe" });
        return;
      }
      if (!turnera.esGuardia) {
        res.status(422).json({ error: "La agenda elegida no es una agenda de guardia" });
        return;
      }
      if (!turnera.activa) {
        res.status(422).json({ error: "La agenda está desactivada: activala antes de usarla para la guardia virtual" });
        return;
      }
      cambios.push({ clave: claveTurnera, valor: String(turneraId) });
    }

    if (body.activa !== undefined) {
      if (typeof body.activa !== "boolean") {
        res.status(400).json({ error: "activa debe ser true o false" });
        return;
      }
      cambios.push({ clave: claveActiva, valor: String(body.activa) });
    }

    if (body.horario !== undefined) {
      const actual = (await leerConfigGuardia()).horario;
      const horario: HorarioGuardia = { ...actual, ...body.horario };
      for (const [campo, valor] of Object.entries(horario)) {
        if (typeof valor !== "string" || !HORA_RE.test(valor)) {
          res.status(400).json({ error: `Hora inválida en ${campo}: usá formato HH:MM (00:00 a 23:59)` });
          return;
        }
      }
      if (horario.lsInicio >= horario.lsFin || horario.dInicio >= horario.dFin) {
        res.status(400).json({ error: "El horario de inicio debe ser anterior al de fin" });
        return;
      }
      cambios.push({ clave: "guardia_virtual_horario", valor: JSON.stringify(horario) });
    }

    // Agendas comunes (no guardia) que se publican como "atención sin turno"
    // en la app del paciente (Radiografías, Mamografía, Odontología, etc.).
    if (body.publicasExtraIds !== undefined) {
      if (
        !Array.isArray(body.publicasExtraIds) ||
        body.publicasExtraIds.some((n) => !Number.isInteger(n) || (n as number) <= 0)
      ) {
        res.status(400).json({ error: "publicasExtraIds debe ser una lista de IDs de agenda" });
        return;
      }
      const ids = body.publicasExtraIds as number[];
      if (ids.length > 0) {
        const existentes = await db
          .select({ id: turnerasTable.id })
          .from(turnerasTable)
          .where(and(inArray(turnerasTable.id, ids), eq(turnerasTable.activa, true)));
        const faltantes = ids.filter((id) => !existentes.some((e) => e.id === id));
        if (faltantes.length > 0) {
          res.status(422).json({ error: `Agendas inexistentes o desactivadas: ${faltantes.join(", ")}` });
          return;
        }
      }
      cambios.push({ clave: "guardias_publicas_extra_ids", valor: ids.join(",") });
    }

    if (cambios.length === 0) {
      res.status(400).json({ error: "Nada para actualizar: mandá activa, horario, turneraId y/o publicasExtraIds" });
      return;
    }

    for (const c of cambios) {
      await db.execute(sql`
        INSERT INTO config_sistema (clave, valor)
        VALUES (${c.clave}, ${c.valor})
        ON CONFLICT (clave) DO UPDATE
          SET valor = EXCLUDED.valor, actualizado_en = now()
      `);
    }

    const config = await leerConfigGuardia();
    req.log.info(
      { guardia, activa: config.activa, horario: config.horario, turneraId: config.turneraId, pediatria: config.pediatria },
      "guardia-virtual: configuración actualizada desde la pantalla de administración",
    );
    res.json({
      activa: config.activa,
      horario: config.horario,
      turneraId: config.turneraId,
      pediatria: config.pediatria,
    });
  },
);

// ── GET /publico/guardia-virtual/estado ───────────────────────────────────

router.get("/publico/guardia-virtual/estado", async (req: Request, res: Response): Promise<void> => {
  const config = await leerConfigGuardia();

  // ?guardia=pediatrica consulta la guardia pediátrica; sin parámetro, la de
  // adultos (compatibilidad con la app ya publicada).
  const guardia = parseGuardia(req.query["guardia"]);
  if (guardia === null) {
    res.status(400).json({ error: "guardia inválida: usá 'clinica' o 'pediatrica'" });
    return;
  }
  const slot = slotDeGuardia(config, guardia);

  if (!slot.activa) {
    res.json({ disponible: false, motivo: "La guardia virtual no está habilitada en este momento." });
    return;
  }
  if (slot.turneraId == null) {
    res.json({ disponible: false, motivo: "La guardia virtual no está configurada. Contactá al centro." });
    return;
  }
  if (!dentroDeHorario(config.horario)) {
    const { lsInicio, lsFin, dInicio, dFin } = config.horario;
    res.json({
      disponible: false,
      motivo: `Fuera de horario de atención (Lunes–Sábado ${lsInicio}–${lsFin}, Domingo ${dInicio}–${dFin} hs).`,
    });
    return;
  }

  // Verificar que la turnera exista y sea guardia
  const [turnera] = await db
    .select({ id: turnerasTable.id, esGuardia: turnerasTable.esGuardia, activa: turnerasTable.activa })
    .from(turnerasTable)
    .where(eq(turnerasTable.id, slot.turneraId))
    .limit(1);

  if (!turnera?.esGuardia || !turnera.activa) {
    res.json({ disponible: false, motivo: "La agenda de guardia virtual no está disponible." });
    return;
  }

  const { turnosEnEspera, atencionHoy, esperaEstimadaMinutos, ofertaPosicion } =
    await infoFila(slot.turneraId);

  res.json({
    disponible: true,
    turnosEnEspera,
    atencionHoy,
    esperaEstimadaMinutos,
    ofertaPosicion,
    obrasSociales: config.obrasSociales,
  });
});

// ── POST /publico/guardia-virtual/registros ───────────────────────────────

router.post("/publico/guardia-virtual/registros", async (req: Request, res: Response): Promise<void> => {
  const config = await leerConfigGuardia();

  // Validar body
  const body = req.body as Record<string, unknown>;

  // "clinica" (default, compatibilidad con la app publicada) o "pediatrica".
  const guardia = parseGuardia(body.guardia);
  if (guardia === null) {
    res.status(400).json({ error: "guardia inválida: usá 'clinica' o 'pediatrica'" });
    return;
  }
  const slot = slotDeGuardia(config, guardia);

  if (!slot.activa || slot.turneraId == null) {
    res.status(503).json({ error: "La guardia virtual no está habilitada en este momento." });
    return;
  }
  if (!dentroDeHorario(config.horario)) {
    res.status(409).json({ error: "La guardia virtual está fuera del horario de atención." });
    return;
  }
  // Tolerante: aceptar dni como número o con puntos ("4.849.369").
  const dni = (typeof body.dni === "string" || typeof body.dni === "number")
    ? String(body.dni).replace(/\D/g, "")
    : "";
  const nombre = typeof body.nombre === "string" ? body.nombre.trim() : "";
  const apellido = typeof body.apellido === "string" ? body.apellido.trim() : "";
  const telefono = typeof body.telefono === "string" ? body.telefono.trim() : undefined;
  const cobertura = typeof body.cobertura === "string" ? body.cobertura.trim().toUpperCase() : "";
  const modalidad = body.modalidad === "presencial" ? "presencial" : "videollamada";

  if (!/^\d{7,10}$/.test(dni)) {
    res.status(400).json({ error: "DNI inválido (debe tener entre 7 y 10 dígitos)." });
    return;
  }
  if (modalidad === "presencial") {
    const habilitado =
      config.presencialDnisPrueba.includes("*") || config.presencialDnisPrueba.includes(dni);
    if (!habilitado) {
      res.status(403).json({
        error: "La atención presencial por orden de llegada todavía está en pruebas y no está disponible para este DNI.",
      });
      return;
    }
  }
  if (!nombre || !apellido) {
    res.status(400).json({ error: "nombre y apellido son obligatorios." });
    return;
  }
  if (!config.obrasSociales.includes(cobertura)) {
    res.status(409).json({
      error: `La guardia virtual solo atiende las siguientes obras sociales: ${config.obrasSociales.join(", ")}.`,
    });
    return;
  }

  // Rate limit por IP
  const ip =
    (Array.isArray(req.headers["x-forwarded-for"])
      ? req.headers["x-forwarded-for"][0]
      : req.headers["x-forwarded-for"]) ??
    req.socket.remoteAddress ??
    "unknown";
  if (ipLimiteSuperado(ip)) {
    res.status(429).json({ error: "Demasiados registros desde este dispositivo. Esperá unos minutos." });
    return;
  }

  const hoy = hoyArgentina();

  // Deduplicación por DNI: si ya hay una sesión activa hoy, devolver su token
  // (el paciente puede cerrar y abrir la app sin perder la sesión).
  const [existente] = await db
    .select()
    .from(guardiaVirtualSesionesTable)
    .where(
      and(
        eq(guardiaVirtualSesionesTable.dni, dni),
        sql`${guardiaVirtualSesionesTable.expiraEn} > now()`,
        sql`${guardiaVirtualSesionesTable.estado} NOT IN ('token_rechazado', 'abandonado', 'atendido')`,
      ),
    )
    .limit(1);

  if (existente) {
    // La sesión existente manda: su fila es la de SU guardia (puede diferir
    // de la pedida si el mismo DNI se registró antes en la otra). Si esa
    // guardia quedó sin turnera configurada, no inventamos fila con otra.
    const slotExistente = slotDeGuardia(config, parseGuardia(existente.guardia) ?? "clinica");
    const fila =
      slotExistente.turneraId != null
        ? await infoFila(slotExistente.turneraId)
        : { turnosEnEspera: 0, esperaEstimadaMinutos: null, ofertaPosicion: null };
    res.status(200).json({
      sesionToken: existente.sesionToken,
      modalidad: existente.modalidad,
      guardia: existente.guardia,
      posicion: fila.turnosEnEspera + 1,
      esperaEstimadaMinutos: fila.esperaEstimadaMinutos,
      ofertaPosicion: fila.ofertaPosicion,
      reutilizada: true,
    });
    return;
  }

  const sesionToken = generarSesionToken();
  const expiraEn = new Date(Date.now() + 2 * 3600 * 1000); // 2 horas

  await db.insert(guardiaVirtualSesionesTable).values({
    sesionToken,
    dni,
    nombre,
    apellido,
    telefono: telefono ?? null,
    cobertura,
    modalidad,
    guardia,
    ipOrigen: ip,
    estado: "pre_registro",
    expiraEn,
  });

  const fila = await infoFila(slot.turneraId);

  res.status(201).json({
    sesionToken,
    modalidad,
    guardia,
    posicion: fila.turnosEnEspera + 1,
    esperaEstimadaMinutos: fila.esperaEstimadaMinutos,
    ofertaPosicion: fila.ofertaPosicion,
  });
});

// ── POST /publico/guardia-virtual/registros/:sesionToken/validar-token ─────
//
// Idempotencia y concurrencia:
//
//   • El claim de la sesión es atómico: un solo UPDATE condicional transiciona
//     desde estado ∈ {pre_registro, token_rechazado} → validando_token y devuelve
//     la fila en RETURNING. Si retorna 0 filas, otra request ganó el claim (o la
//     sesión ya fue procesada): se relee el estado real y se responde sin efectos.
//
//   • Estados que admiten claim (reintentan validación):
//       - pre_registro   → estado inicial + rollback de errores técnicos
//       - token_rechazado → IOMA rechazó ese token; el paciente puede reintentar
//                           con uno nuevo (ver comentario en guardia_virtual.ts schema)
//
//   • Camino TOKEN_ACCEPTED: inserta el turno fuera de la tx (insertarTurnoGuardia
//     tiene su propio loop de reintento/cupo) y envuelve TODAS las escrituras
//     de persistencia restantes (token en turno, consultas_token, trabajo link,
//     sesión → en_cola) en db.transaction(). Si la tx falla se compensan ambos
//     estados (cancelar turno + revertir sesión a pre_registro).

router.post(
  "/publico/guardia-virtual/registros/:sesionToken/validar-token",
  async (req: Request, res: Response): Promise<void> => {
    const { sesionToken } = req.params as { sesionToken: string };

    const body = req.body as Record<string, unknown>;
    const tokenIoma = typeof body.tokenIoma === "string" ? body.tokenIoma.trim() : "";
    if (!tokenIoma || tokenIoma.length < 4) {
      res.status(400).json({ error: "tokenIoma es obligatorio (mínimo 4 caracteres)." });
      return;
    }

    // ── Reserva Check in (opcional) ──────────────────────────────────────
    // fecha (YYYY-MM-DD) + horaInicio (HH:MM): en vez de entrar a la fila de
    // hoy por orden de llegada, el paciente reserva un turno "Check in" en la
    // agenda de guardia (hoy, mañana u otra fecha). El token IOMA vale solo
    // hoy, así que la consulta Klinicos SIEMPRE se valida hoy; el turno en
    // Conectar queda para la fecha elegida, ya validado (bono incluido).
    const fechaReserva = typeof body.fecha === "string" ? body.fecha.trim() : null;
    const horaReserva = typeof body.horaInicio === "string" ? body.horaInicio.trim() : null;
    if (fechaReserva != null || horaReserva != null) {
      if (!fechaReserva || !/^\d{4}-\d{2}-\d{2}$/.test(fechaReserva)) {
        res.status(400).json({ error: "fecha inválida (formato YYYY-MM-DD)." });
        return;
      }
      if (!horaReserva || !/^\d{2}:\d{2}$/.test(horaReserva)) {
        res.status(400).json({ error: "horaInicio inválida (formato HH:MM)." });
        return;
      }
      const hoy = hoyArgentina();
      if (fechaReserva < hoy) {
        res.status(400).json({ error: "La fecha elegida ya pasó." });
        return;
      }
      const limite = new Date(`${hoy}T00:00:00.000Z`);
      limite.setUTCDate(limite.getUTCDate() + 3);
      if (fechaReserva > limite.toISOString().slice(0, 10)) {
        res.status(400).json({ error: "Solo se puede reservar hasta 3 días adelante." });
        return;
      }
    }
    const esReserva = fechaReserva != null && horaReserva != null;

    const config = await leerConfigGuardia();
    if (config.turneraId == null && config.pediatria.turneraId == null) {
      res.status(503).json({ error: "La guardia virtual no está configurada." });
      return;
    }

    // ── 1. Claim atómico ──────────────────────────────────────────────────
    // UPDATE condicional: solo avanza si el estado actual permite validar.
    // Dos requests concurrentes del mismo móvil compiten por este UPDATE;
    // la base garantiza que exactamente una obtiene la fila en RETURNING.
    const claimed = await db
      .update(guardiaVirtualSesionesTable)
      .set({
        estado: "validando_token",
        tokenIomaEnmascarado: tokenIoma.slice(-4),
        tokenIomaEstado: "PENDING",
        actualizadoEn: new Date(),
      })
      .where(
        and(
          eq(guardiaVirtualSesionesTable.sesionToken, sesionToken),
          inArray(guardiaVirtualSesionesTable.estado, ["pre_registro", "token_rechazado"]),
          sql`${guardiaVirtualSesionesTable.expiraEn} > now()`,
        ),
      )
      .returning();

    const sesion = claimed[0];

    if (!sesion) {
      // Claim fallido: releer estado real y responder según corresponda.
      const [actual] = await db
        .select()
        .from(guardiaVirtualSesionesTable)
        .where(eq(guardiaVirtualSesionesTable.sesionToken, sesionToken))
        .limit(1);

      if (!actual) {
        res.status(404).json({ error: "Sesión no encontrada." });
        return;
      }
      if (new Date() > actual.expiraEn) {
        res.status(410).json({ error: "La sesión expiró. Comenzá el proceso nuevamente." });
        return;
      }
      // Idempotente: ya se procesó con éxito
      if (actual.estado === "en_cola" && actual.turnoId != null) {
        res.json({
          estado: "TOKEN_ACCEPTED",
          mensaje: "Ya tenés un lugar en la guardia.",
          nroBono: actual.nroBono,
          reintentable: false,
        });
        return;
      }
      // Otra request concurrente tiene el claim ahora mismo
      if (actual.estado === "validando_token") {
        res.status(409).json({
          error: "Validación en curso. Esperá unos segundos e intentá de nuevo.",
          reintentable: true,
        });
        return;
      }
      // Terminal
      if (actual.estado === "abandonado" || actual.estado === "atendido") {
        res.status(409).json({ error: `La sesión está en estado ${actual.estado}.` });
        return;
      }
      // Cualquier otro estado inesperado (no debería ocurrir)
      res.status(409).json({
        error: `La sesión no puede validar el token en estado ${actual.estado}.`,
      });
      return;
    }

    // A partir de acá somos la única request procesando esta sesión.

    // La guardia de la sesión define agenda y especialidad Klinicos.
    const guardiaSesion = parseGuardia(sesion.guardia) ?? "clinica";
    const slot = slotDeGuardia(config, guardiaSesion);
    if (slot.turneraId == null) {
      await db
        .update(guardiaVirtualSesionesTable)
        .set({ estado: "pre_registro", actualizadoEn: new Date() })
        .where(eq(guardiaVirtualSesionesTable.id, sesion.id));
      res.status(503).json({ error: "La guardia virtual no está configurada." });
      return;
    }

    // ── 1b. Reserva Check in: chequear el horario ANTES de gastar el token ─
    // El token IOMA es de un solo uso: si el horario no está libre, se corta
    // acá y el paciente puede elegir otro sin perder nada.
    if (esReserva) {
      if (sesion.modalidad !== "presencial") {
        await db
          .update(guardiaVirtualSesionesTable)
          .set({ estado: "pre_registro", actualizadoEn: new Date() })
          .where(eq(guardiaVirtualSesionesTable.id, sesion.id));
        res.status(400).json({ error: "La reserva de Check in es solo para la guardia presencial." });
        return;
      }
      const [turneraReserva] = await db
        .select()
        .from(turnerasTable)
        .where(eq(turnerasTable.id, slot.turneraId))
        .limit(1);
      const slotsDia = turneraReserva ? await calcularSlotsDisponibles(turneraReserva, fechaReserva) : [];
      const slotElegido = slotsDia.find((s) => s.horaInicio === horaReserva);
      if (!slotElegido || !slotElegido.disponible) {
        await db
          .update(guardiaVirtualSesionesTable)
          .set({ estado: "pre_registro", actualizadoEn: new Date() })
          .where(eq(guardiaVirtualSesionesTable.id, sesion.id));
        res.status(409).json({
          error: slotElegido
            ? "Ese horario acaba de ocuparse. Elegí otro horario (tu token no se gastó)."
            : "Ese horario no está en la agenda de la guardia para esa fecha. Elegí otro (tu token no se gastó).",
          reintentable: true,
        });
        return;
      }
    }

    // ── 2. Resolver o crear paciente por DNI ──────────────────────────────
    let pacienteId: number;
    const [pacienteExistente] = await db
      .select()
      .from(pacientesTable)
      .where(eq(pacientesTable.dni, sesion.dni))
      .limit(1);

    if (pacienteExistente) {
      pacienteId = pacienteExistente.id;
      const faltantes: Record<string, unknown> = {};
      if (sesion.telefono && !pacienteExistente.telefono) faltantes.telefono = sesion.telefono;
      if (sesion.cobertura && !pacienteExistente.cobertura) faltantes.cobertura = sesion.cobertura;
      if (!pacienteExistente.activo) faltantes.activo = true;
      if (Object.keys(faltantes).length > 0) {
        await db.update(pacientesTable).set(faltantes).where(eq(pacientesTable.id, pacienteId));
      }
    } else {
      const [nuevo] = await db
        .insert(pacientesTable)
        .values({
          dni: sesion.dni,
          nombre: sesion.nombre,
          apellido: sesion.apellido,
          telefono: sesion.telefono ?? undefined,
          cobertura: sesion.cobertura,
          numeroHc: sesion.dni,
        })
        .onConflictDoNothing()
        .returning({ id: pacientesTable.id });
      if (nuevo) {
        pacienteId = nuevo.id;
      } else {
        // Raza de inserción: releer
        const [reintentado] = await db
          .select({ id: pacientesTable.id })
          .from(pacientesTable)
          .where(eq(pacientesTable.dni, sesion.dni))
          .limit(1);
        if (!reintentado) {
          await db
            .update(guardiaVirtualSesionesTable)
            .set({ estado: "pre_registro", actualizadoEn: new Date() })
            .where(eq(guardiaVirtualSesionesTable.id, sesion.id));
          res.status(500).json({ error: "No se pudo crear el paciente. Intentá de nuevo." });
          return;
        }
        pacienteId = reintentado.id;
      }
    }

    const [paciente] = await db
      .select()
      .from(pacientesTable)
      .where(eq(pacientesTable.id, pacienteId))
      .limit(1);

    // ── 3. Validar token IOMA ─────────────────────────────────────────────
    const resultado = await validarTokenGuardiaVirtual({
      pacienteId,
      dni: sesion.dni,
      sexo: paciente?.sexo ?? null,
      celular: paciente?.telefono ?? null,
      tokenIoma,
      guardia: guardiaSesion,
    });

    if (!resultado.ok) {
      const nuevoEstado =
        resultado.estado === "DENIED" ? ("token_rechazado" as const) : ("pre_registro" as const);
      await db
        .update(guardiaVirtualSesionesTable)
        .set({
          estado: nuevoEstado,
          tokenIomaEstado: resultado.estado,
          actualizadoEn: new Date(),
          ...(resultado.reintentable ? { expiraEn: new Date(Date.now() + 2 * 3600 * 1000) } : {}),
        })
        .where(eq(guardiaVirtualSesionesTable.id, sesion.id));

      res.json({
        estado: resultado.estado,
        mensaje: resultado.mensaje,
        reintentable: resultado.reintentable,
        nroBono: null,
      });
      return;
    }

    // ── 4. TOKEN ACCEPTED: crear turno ────────────────────────────────────
    // insertarTurnoGuardia tiene su propio loop de reintento+tx interna para
    // colisiones de slot, por eso se invoca fuera de la tx principal.
    const [turnera] = await db
      .select()
      .from(turnerasTable)
      .where(eq(turnerasTable.id, slot.turneraId))
      .limit(1);

    if (!turnera?.esGuardia || !turnera.activa) {
      await db
        .update(guardiaVirtualSesionesTable)
        .set({ estado: "pre_registro", actualizadoEn: new Date() })
        .where(eq(guardiaVirtualSesionesTable.id, sesion.id));
      res.status(503).json({ error: "La agenda de guardia no está disponible." });
      return;
    }

    // Presencial: el turno nace "confirmado" (agendado, ocupa lugar en la fila
    // pero el médico NO lo puede llamar) hasta que el paciente aprieta
    // "Ya llegué" en la app, que lo pasa a "arribo" (recepcionado).
    const esPresencial = sesion.modalidad === "presencial";
    let turnoId: number;
    let turnoCreado: { fecha: string; horaInicio: string };
    try {
      const paramsBase = {
        turneraId: slot.turneraId,
        especialidadId: turnera.especialidadId,
        pacienteId,
        duracionMinutos: turnera.duracionMinutos ?? 15,
        estado: (esPresencial ? "confirmado" : "arribo") as "confirmado" | "arribo",
        ...(esPresencial ? {} : { admitidoEn: new Date(), admitidoPor: "guardia virtual" }),
        modalidad: esPresencial ? "presencial" : "videoconsulta",
        motivoConsulta: esReserva
          ? "Check in guardia (turno reservado)"
          : esPresencial
            ? "Consulta guardia (presencial, por orden de llegada)"
            : "Consulta guardia virtual (videollamada)",
        observaciones: `Origen: guardia-virtual${esReserva ? " check-in reservado" : esPresencial ? " presencial" : ""} | Obra social: ${sesion.cobertura}`,
        cobertura: sesion.cobertura,
        nroAfiliado: paciente?.nroAfiliado ?? null,
      };

      if (esReserva) {
        // Reserva exacta sobre la grilla. El token YA fue aceptado en Klinicos,
        // así que NUNCA podemos fallar por slot: si el horario elegido se
        // ocupó en la carrera (ventana chica entre el pre-check y acá), se
        // toma el siguiente horario libre de la grilla y se informa la hora
        // real. Nunca se inserta fuera de la grilla.
        let horaIntento: string = horaReserva;
        let turno: { id: number; fecha: string; horaInicio: string } | null = null;
        for (let intento = 0; intento < 10 && !turno; intento++) {
          try {
            const r = await insertarTurnoGuardia({
              ...paramsBase,
              fecha: fechaReserva,
              horaInicioBase: horaIntento,
              horaExacta: true,
            });
            turno = r.turno;
          } catch (err) {
            if (!(err instanceof ErrorSlotOcupado)) throw err;
            const slotsAhora = await calcularSlotsDisponibles(turnera, fechaReserva);
            const siguiente =
              slotsAhora.find((s) => s.disponible && s.horaInicio > horaIntento) ??
              slotsAhora.find((s) => s.disponible);
            if (!siguiente) {
              // Grilla llena: último recurso para no perder el token — entra
              // a la fila de ese día detrás del último (comportamiento clásico).
              const r = await insertarTurnoGuardia({
                ...paramsBase,
                fecha: fechaReserva,
                horaInicioBase: horaIntento,
              });
              turno = r.turno;
              break;
            }
            horaIntento = siguiente.horaInicio;
          }
        }
        if (!turno) throw new Error("No se pudo asignar un horario en la agenda de guardia.");
        turnoId = turno.id;
        turnoCreado = { fecha: turno.fecha, horaInicio: turno.horaInicio };
      } else {
        const { turno } = await insertarTurnoGuardia({
          ...paramsBase,
          fecha: hoyArgentina(),
          horaInicioBase: horaArgentina().substring(0, 5),
        });
        turnoId = turno.id;
        turnoCreado = { fecha: turno.fecha, horaInicio: turno.horaInicio };
      }
    } catch (err) {
      const mensaje = err instanceof Error ? err.message : String(err);
      await db
        .update(guardiaVirtualSesionesTable)
        .set({ estado: "pre_registro", tokenIomaEstado: "TECHNICAL_ERROR", actualizadoEn: new Date() })
        .where(eq(guardiaVirtualSesionesTable.id, sesion.id));
      res.status(503).json({
        error: `No se pudo reservar el lugar en la guardia: ${mensaje}`,
        reintentable: true,
      });
      return;
    }

    // ── 5. Persistir escrituras relacionadas en transacción única ─────────
    // Todas o ninguna: token en turno, consultas_token, trabajo link, sesión→en_cola.
    // Si la tx falla se compensa: turno cancelado + sesión vuelve a pre_registro.
    const camposToken = {
      coverageType: sesion.cobertura,
      affiliateNumber: paciente?.nroAfiliado ?? null,
      tokenStatus: "ACCEPTED" as const,
      tokenMasked: tokenIoma.slice(-4),
      tokenCompleto: tokenIoma.replace(/\s+/g, ""),
      tokenValidatedAt: new Date(),
      tokenValidationRequestId: `gv-${sesionToken}`,
      authorizationNumber: resultado.nroBono,
      tokenFailureCode: null,
      tokenFailureMessage: null,
      robotSyncStatus: "COMPLETED" as const,
    };

    try {
      await db.transaction(async (tx) => {
        await tx
          .update(turnosTable)
          .set({ klinicosToken: tokenIoma.replace(/\s+/g, "") })
          .where(eq(turnosTable.id, turnoId));

        await tx
          .insert(consultasTokenTable)
          .values({ consultationId: turnoId, ...camposToken })
          .onConflictDoUpdate({ target: consultasTokenTable.consultationId, set: camposToken });

        await tx
          .update(klinicosTrabajos)
          .set({ turnoId })
          .where(eq(klinicosTrabajos.id, resultado.trabajoId));

        await tx
          .update(guardiaVirtualSesionesTable)
          .set({
            estado: "en_cola",
            tokenIomaEstado: "ACCEPTED",
            nroBono: resultado.nroBono,
            turnoId,
            klinicosTrabajoId: resultado.trabajoId,
            actualizadoEn: new Date(),
          })
          .where(eq(guardiaVirtualSesionesTable.id, sesion.id));

        // Fila de avisos al portal (avances de fila y, en videollamada, el
        // "tu turno" con link). En la misma tx: o queda todo o no queda nada.
        // Idempotente por turnoId (nunca dos filas para el mismo turno).
        const [colaExistente] = await tx
          .select({ id: videollamadasColaTable.id })
          .from(videollamadasColaTable)
          .where(eq(videollamadasColaTable.turnoId, turnoId))
          .limit(1);
        if (!colaExistente) {
          await tx.insert(videollamadasColaTable).values({
            dni: sesion.dni,
            nombre: sesion.nombre,
            apellido: sesion.apellido,
            telefono: sesion.telefono,
            obraSocial: sesion.cobertura,
            pacienteId,
            turnoId,
            estado: "recepcionado",
            motivo: esPresencial ? "Guardia presencial (check in previo)" : "Guardia virtual",
          });
        }
      });
    } catch (txErr) {
      // Compensación: cancelar el turno recién creado y revertir la sesión
      // para que el paciente pueda reintentar.
      try {
        await db
          .update(turnosTable)
          .set({ estado: "cancelado" })
          .where(
            sql`${turnosTable.id} = ${turnoId}
                AND ${turnosTable.estado} NOT IN ('cancelado','ausente','anulado','atendido')`,
          );
        await db
          .update(guardiaVirtualSesionesTable)
          .set({ estado: "pre_registro", tokenIomaEstado: "TECHNICAL_ERROR", actualizadoEn: new Date() })
          .where(eq(guardiaVirtualSesionesTable.id, sesion.id));
      } catch {
        /* compensación best-effort; el turno huérfano se limpia por el job nightly */
      }
      const msg = txErr instanceof Error ? txErr.message : String(txErr);
      res.status(503).json({ error: `Error al persistir el turno: ${msg}`, reintentable: true });
      return;
    }

    // Registrar evento para el Robot (best-effort, fuera de la tx principal)
    try {
      await registrarEventoTurnoRobot(turnoId, "alta");
    } catch {
      /* no bloquear la respuesta */
    }

    // Primer aviso de posición al portal (fire-and-forget). Solo si el turno
    // es para hoy: los Check in reservados a futuro no están en la fila de hoy.
    const turnoEsHoy = !esReserva || fechaReserva === hoyArgentina();
    if (turnoEsHoy) void avanzarFilaGuardia(turnoId);

    res.json({
      estado: "TOKEN_ACCEPTED",
      mensaje: esReserva
        ? `Token aceptado. Tu turno Check in quedó reservado para el ${turnoCreado.fecha} a las ${turnoCreado.horaInicio.slice(0, 5)}. Número de bono: ${resultado.nroBono}. Ese día, cuando llegues a la clínica, apretá "Ya llegué".`
        : `Token aceptado. Tenés un lugar en la guardia. Número de bono: ${resultado.nroBono}.`,
      nroBono: resultado.nroBono,
      reintentable: false,
      turnoFecha: turnoCreado.fecha,
      turnoHora: esReserva ? turnoCreado.horaInicio.slice(0, 5) : null,
    });
  },
);

// ── GET /publico/guardia-virtual/checkin/disponibilidad ─────────────────────
// Horarios libres de la agenda de guardia para reservar un turno Check in
// (query: guardia=clinica|pediatrica, fecha=YYYY-MM-DD). La app ofrece hoy,
// mañana y "otras fechas" con este endpoint.

router.get(
  "/publico/guardia-virtual/checkin/disponibilidad",
  async (req: Request, res: Response): Promise<void> => {
    const guardia = parseGuardia(req.query.guardia);
    if (guardia == null) {
      res.status(400).json({ error: "guardia inválida (clinica | pediatrica)." });
      return;
    }
    const fecha = typeof req.query.fecha === "string" ? req.query.fecha.trim() : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
      res.status(400).json({ error: "fecha es obligatoria (formato YYYY-MM-DD)." });
      return;
    }
    const hoy = hoyArgentina();
    if (fecha < hoy) {
      res.status(400).json({ error: "La fecha ya pasó." });
      return;
    }
    const limite = new Date(`${hoy}T00:00:00.000Z`);
    limite.setUTCDate(limite.getUTCDate() + 3);
    if (fecha > limite.toISOString().slice(0, 10)) {
      res.status(400).json({ error: "Solo se puede reservar hasta 3 días adelante." });
      return;
    }

    const config = await leerConfigGuardia();
    const slot = slotDeGuardia(config, guardia);
    if (!slot.activa || slot.turneraId == null) {
      res.status(503).json({ error: "La guardia no está disponible para reservas." });
      return;
    }
    const [turnera] = await db
      .select()
      .from(turnerasTable)
      .where(eq(turnerasTable.id, slot.turneraId))
      .limit(1);
    if (!turnera?.activa || !turnera.esGuardia) {
      res.status(503).json({ error: "La agenda de guardia no está disponible." });
      return;
    }

    const slots = await calcularSlotsDisponibles(turnera, fecha);
    res.json({
      guardia,
      fecha,
      horarios: slots
        .filter((s) => s.disponible)
        .map((s) => ({ horaInicio: s.horaInicio, horaFin: s.horaFin })),
    });
  },
);

// ── GET /publico/guardia-virtual/registros/:sesionToken/estado ─────────────

router.get(
  "/publico/guardia-virtual/registros/:sesionToken/estado",
  async (req: Request, res: Response): Promise<void> => {
    const { sesionToken } = req.params as { sesionToken: string };
    const config = await leerConfigGuardia();

    const [sesion] = await db
      .select()
      .from(guardiaVirtualSesionesTable)
      .where(eq(guardiaVirtualSesionesTable.sesionToken, sesionToken))
      .limit(1);

    if (!sesion) {
      res.status(404).json({ error: "Sesión no encontrada." });
      return;
    }
    if (new Date() > sesion.expiraEn && sesion.estado === "pre_registro") {
      res.status(410).json({ error: "La sesión expiró. Comenzá el proceso nuevamente." });
      return;
    }

    // Sincronizar estado con el turno si ya fue creado
    let jitsiUrl: string | null = null;
    let posicion: number | null = null;
    let esperaEstimadaMinutos: number | null = null;
    let estadoReal = sesion.estado;
    let turnoInfo: { fecha: string; horaInicio: string } | null = null;

    if (sesion.turnoId != null) {
      const [turno] = await db
        .select()
        .from(turnosTable)
        .where(eq(turnosTable.id, sesion.turnoId))
        .limit(1);

      if (turno) {
        turnoInfo = { fecha: turno.fecha, horaInicio: turno.horaInicio };
        // Mapear estado del turno al estado de la sesión
        if (turno.estado === "llamado") {
          estadoReal = "llamado";
          // Entregar el link Jitsi SOLO cuando el médico llamó (y solo en
          // videollamada: al presencial lo llaman por la pantalla de la sala).
          if (sesion.modalidad !== "presencial") jitsiUrl = urlVideollamadaTurno(turno);
        } else if (["atendido", "finalizado"].includes(turno.estado)) {
          estadoReal = "atendido";
        } else if (["cancelado", "ausente", "anulado"].includes(turno.estado)) {
          estadoReal = "abandonado";
        } else {
          estadoReal = "en_cola";
        }

        // Actualizar estado de la sesión si cambió
        if (estadoReal !== sesion.estado) {
          await db
            .update(guardiaVirtualSesionesTable)
            .set({ estado: estadoReal as typeof sesion.estado, actualizadoEn: new Date() })
            .where(eq(guardiaVirtualSesionesTable.id, sesion.id));
        }

        // Calcular posición en fila: SIEMPRE contra la turnera del turno real
        // (cada guardia tiene la suya) y SOLO si el turno es de hoy (los
        // Check in reservados a futuro no están en la fila todavía).
        if (estadoReal === "en_cola" && turno.turneraId != null && turno.fecha === hoyArgentina()) {
          const turneraFila = turno.turneraId;
          const hoy = hoyArgentina();
          const filaAntes = await db
            .select({ horaInicio: turnosTable.horaInicio })
            .from(turnosTable)
            .where(
              and(
                eq(turnosTable.turneraId, turneraFila),
                eq(turnosTable.fecha, hoy),
                inArray(turnosTable.estado, ESTADOS_ACTIVOS),
                sql`${turnosTable.horaInicio} <= ${turno.horaInicio}`,
              ),
            );
          posicion = filaAntes.length; // 1=próximo

          const [turnera] = await db
            .select({ duracionMinutos: turnerasTable.duracionMinutos })
            .from(turnerasTable)
            .where(eq(turnerasTable.id, turneraFila))
            .limit(1);
          const durMap = new Map([[turneraFila, turnera?.duracionMinutos ?? 15]]);
          const estimador = await crearEstimadorEspera(hoy, [turneraFila], durMap);
          esperaEstimadaMinutos = estimador.estimar(turneraFila, posicion);
        }
      }
    }

    // Presencial: la app muestra el botón "Ya llegué" mientras el turno siga
    // "confirmado" (agendado). llegoALaClinica pasa a true después del botón.
    let llegoALaClinica: boolean | null = null;
    if (sesion.modalidad === "presencial" && sesion.turnoId != null) {
      const [t] = await db
        .select({ estado: turnosTable.estado })
        .from(turnosTable)
        .where(eq(turnosTable.id, sesion.turnoId))
        .limit(1);
      llegoALaClinica = t ? t.estado !== "confirmado" : null;
    }

    res.json({
      estado: estadoReal,
      modalidad: sesion.modalidad,
      llegoALaClinica,
      posicion,
      esperaEstimadaMinutos,
      jitsiUrl,
      nroBono: sesion.nroBono,
      turnoFecha: turnoInfo?.fecha ?? null,
      turnoHora: turnoInfo?.horaInicio ?? null,
    });
  },
);

// ── POST /publico/guardia-virtual/registros/:sesionToken/llegue ────────────
// Botón grande "Ya llegué a la clínica" (solo modalidad presencial): pasa el
// turno de "confirmado" (agendado) a "arribo" (recepcionado) de forma atómica,
// para que el médico pueda llamarlo. Idempotente: si ya está recepcionado o
// más adelante, responde ok.

router.post(
  "/publico/guardia-virtual/registros/:sesionToken/llegue",
  async (req: Request, res: Response): Promise<void> => {
    const { sesionToken } = req.params as { sesionToken: string };

    const [sesion] = await db
      .select()
      .from(guardiaVirtualSesionesTable)
      .where(eq(guardiaVirtualSesionesTable.sesionToken, sesionToken))
      .limit(1);

    if (!sesion) {
      res.status(404).json({ error: "Sesión no encontrada." });
      return;
    }
    if (sesion.modalidad !== "presencial") {
      res.status(409).json({ error: "Esta sesión es de videollamada: no hace falta avisar que llegaste." });
      return;
    }
    if (sesion.turnoId == null) {
      res.status(409).json({ error: "Primero validá el token para tener tu lugar en la guardia." });
      return;
    }

    const actualizados = await db
      .update(turnosTable)
      .set({ estado: "arribo", admitidoEn: new Date(), admitidoPor: "app paciente (ya llegué)" })
      .where(
        and(
          eq(turnosTable.id, sesion.turnoId),
          eq(turnosTable.estado, "confirmado"),
          // Check in reservado: solo se puede avisar la llegada el día del turno.
          sql`${turnosTable.fecha} <= ${hoyArgentina()}`,
        ),
      )
      .returning({ id: turnosTable.id });

    if (actualizados.length === 0) {
      const [turno] = await db
        .select({ estado: turnosTable.estado, fecha: turnosTable.fecha, horaInicio: turnosTable.horaInicio })
        .from(turnosTable)
        .where(eq(turnosTable.id, sesion.turnoId))
        .limit(1);
      if (turno && ["cancelado", "ausente", "anulado"].includes(turno.estado)) {
        res.status(409).json({ error: "El turno ya no está vigente. Acercate a recepción." });
        return;
      }
      if (turno && turno.estado === "confirmado" && turno.fecha > hoyArgentina()) {
        res.status(409).json({
          error: `Tu turno Check in es el ${turno.fecha} a las ${turno.horaInicio.slice(0, 5)}. Avisá que llegaste ese día.`,
        });
        return;
      }
      // Ya estaba recepcionado (o más adelante): idempotente
      res.json({ ok: true, yaEstaba: true });
      return;
    }

    req.log.info(
      { turnoId: sesion.turnoId, sesionId: sesion.id },
      "guardia-presencial: paciente avisó que llegó (confirmado → arribo)",
    );
    res.json({ ok: true });
  },
);

// ── POST /publico/guardia-virtual/registros/:sesionToken/abandonar ─────────

router.post(
  "/publico/guardia-virtual/registros/:sesionToken/abandonar",
  async (req: Request, res: Response): Promise<void> => {
    const { sesionToken } = req.params as { sesionToken: string };

    const [sesion] = await db
      .select()
      .from(guardiaVirtualSesionesTable)
      .where(eq(guardiaVirtualSesionesTable.sesionToken, sesionToken))
      .limit(1);

    if (!sesion) {
      res.status(404).json({ error: "Sesión no encontrada." });
      return;
    }
    if (["abandonado", "atendido"].includes(sesion.estado)) {
      res.json({ ok: true });
      return;
    }

    // Cancelar el turno si existe
    if (sesion.turnoId != null) {
      await db
        .update(turnosTable)
        .set({ estado: "cancelado" })
        .where(
          sql`${turnosTable.id} = ${sesion.turnoId}
              AND ${turnosTable.estado} NOT IN ('cancelado', 'ausente', 'anulado', 'atendido')`,
        );
    }

    await db
      .update(guardiaVirtualSesionesTable)
      .set({ estado: "abandonado", actualizadoEn: new Date() })
      .where(eq(guardiaVirtualSesionesTable.id, sesion.id));

    res.json({ ok: true });
  },
);

export default router;
