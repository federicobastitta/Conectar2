import { Router, type IRouter } from "express";
import { eq, and, gt, sql } from "drizzle-orm";
import { db, usersTable, sesionesTable, pedidosRecuperacionTable, pacientesTable } from "@workspace/db";
import { LoginBody } from "@workspace/api-zod";
import { logger } from "../lib/logger";
import crypto from "crypto";
import { consumirTokenIngreso, revocarTokensIngresoDeUsuario } from "../lib/autologin-paciente";

const router: IRouter = Router();

function hashPassword(password: string): string {
  return crypto.createHash("sha256").update(password + "mi-diagnosticar-salt").digest("hex");
}

function generateToken(userId: number): string {
  return Buffer.from(`${userId}:${Date.now()}:${crypto.randomBytes(16).toString("hex")}`).toString("base64");
}

// Write-through in-memory cache: rápido en la mayoría de las llamadas,
// pero el token de verdad vive en la DB → sobrevive reinicios del servidor.
export const tokenStore = new Map<string, number>();

async function getUserIdFromToken(token: string): Promise<number | null> {
  // 1. Caché en memoria
  const cached = tokenStore.get(token);
  if (cached != null) return cached;

  // 2. Fallback a DB (ej: tras un reinicio del servidor)
  const [sesion] = await db
    .select()
    .from(sesionesTable)
    .where(
      and(
        eq(sesionesTable.token, token),
        eq(sesionesTable.activa, true),
        gt(sesionesTable.expiresAt, new Date()),
      ),
    )
    .limit(1);

  if (!sesion) return null;

  // Repoblar caché
  tokenStore.set(token, sesion.usuarioId);
  return sesion.usuarioId;
}

const SESSION_TTL_DAYS = 30;

router.post("/auth/login", async (req, res): Promise<void> => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { email, password } = parsed.data;
  const hash = hashPassword(password);
  const identificador = email.trim().toLowerCase();
  let [user] = await db
    .select()
    .from(usersTable)
    .where(sql`lower(${usersTable.email}) = ${identificador}`)
    .limit(1);
  if (!user && !identificador.includes("@")) {
    // Permitir ingresar solo con el usuario (parte antes del @), si es inequívoco.
    const candidatos = await db
      .select()
      .from(usersTable)
      .where(sql`split_part(lower(${usersTable.email}), '@', 1) = ${identificador}`)
      .limit(2);
    if (candidatos.length === 1) user = candidatos[0];
  }
  if (!user || user.passwordHash !== hash) {
    res.status(401).json({ error: "Credenciales inválidas" });
    return;
  }
  if (user.activo !== "true") {
    res.status(401).json({ error: "Usuario deshabilitado" });
    return;
  }

  const token = generateToken(user.id);
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  // Persistir en DB
  await db.insert(sesionesTable).values({
    token,
    usuarioId: user.id,
    activa: true,
    expiresAt,
  });

  // Escribir en caché
  tokenStore.set(token, user.id);

  req.log.info({ userId: user.id }, "User logged in");
  res.json({
    user: {
      id: user.id,
      email: user.email,
      nombre: user.nombre,
      rol: user.rol,
      perfil: user.perfil ?? null,
      profesionalId: user.profesionalId ? parseInt(user.profesionalId) : null,
      pacienteId: user.pacienteId ? parseInt(user.pacienteId) : null,
    },
    token,
  });
});

router.post("/auth/logout", async (req, res): Promise<void> => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (token) {
    tokenStore.delete(token);
    vistaRolStore.delete(token);
    await db
      .update(sesionesTable)
      .set({ activa: false })
      .where(eq(sesionesTable.token, token));
  }
  res.json({ ok: true });
});

// Cambiar la propia contraseña (cualquier usuario logueado; aplica al usuario
// real de la sesión, nunca al rol simulado por vista-rol).
router.post("/auth/cambiar-clave", async (req, res): Promise<void> => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }
  const userId = await getUserIdFromToken(token);
  if (userId == null) {
    res.status(401).json({ error: "Token inválido o expirado" });
    return;
  }
  const { claveActual, claveNueva } = (req.body ?? {}) as {
    claveActual?: unknown;
    claveNueva?: unknown;
  };
  if (typeof claveActual !== "string" || typeof claveNueva !== "string") {
    res.status(400).json({ error: "Datos inválidos" });
    return;
  }
  if (claveNueva.length < 4) {
    res.status(400).json({ error: "La nueva contraseña debe tener al menos 4 caracteres" });
    return;
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user || user.activo !== "true") {
    res.status(401).json({ error: "Usuario deshabilitado" });
    return;
  }
  if (user.passwordHash !== hashPassword(claveActual)) {
    res.status(401).json({ error: "La contraseña actual no es correcta" });
    return;
  }
  await db
    .update(usersTable)
    .set({ passwordHash: hashPassword(claveNueva) })
    .where(eq(usersTable.id, userId));
  // Revocar las demás sesiones del usuario (contención si la cuenta estaba
  // comprometida); se conserva solo la sesión actual.
  const revocadas = await db
    .update(sesionesTable)
    .set({ activa: false })
    .where(
      and(
        eq(sesionesTable.usuarioId, userId),
        eq(sesionesTable.activa, true),
        sql`${sesionesTable.token} <> ${token}`,
      ),
    )
    .returning({ token: sesionesTable.token });
  for (const s of revocadas) {
    tokenStore.delete(s.token);
    vistaRolStore.delete(s.token);
  }
  // Los links mágicos de ingreso pendientes dejan de servir al cambiar la clave.
  await revocarTokensIngresoDeUsuario(userId);
  req.log.info({ userId, sesionesRevocadas: revocadas.length }, "Usuario cambió su contraseña");
  res.json({ ok: true });
});

// ── Ingreso por link mágico (autologin del paciente vía WhatsApp) ──────────
// Público: el paciente llega con un token opaco de un solo uso. Rate limit
// simple por IP, igual criterio que "olvidé mi clave".
const ingresoMagicoIntentos = new Map<string, { count: number; resetAt: number }>();
const INGRESO_MAGICO_MAX_POR_HORA = 10;

router.post("/auth/ingreso-magico", async (req, res): Promise<void> => {
  const ip = req.ip ?? "desconocida";
  const ahora = Date.now();
  const reg = ingresoMagicoIntentos.get(ip);
  if (!reg || reg.resetAt < ahora) {
    ingresoMagicoIntentos.set(ip, { count: 1, resetAt: ahora + 60 * 60 * 1000 });
  } else if (reg.count >= INGRESO_MAGICO_MAX_POR_HORA) {
    res.status(429).json({ error: "Demasiados intentos; probá de nuevo más tarde" });
    return;
  } else {
    reg.count += 1;
  }
  if (ingresoMagicoIntentos.size > 10_000) {
    for (const [k, v] of ingresoMagicoIntentos) if (v.resetAt < ahora) ingresoMagicoIntentos.delete(k);
  }
  const { token: tokenIngreso } = (req.body ?? {}) as { token?: unknown };
  if (typeof tokenIngreso !== "string" || tokenIngreso.length < 20 || tokenIngreso.length > 200) {
    res.status(400).json({ error: "Link de ingreso inválido" });
    return;
  }
  const resultado = await consumirTokenIngreso(tokenIngreso);
  if (!resultado.ok) {
    const mensaje =
      resultado.motivo === "vencido"
        ? "El link de ingreso venció. Pedí uno nuevo o ingresá con tu usuario y clave."
        : resultado.motivo === "usado"
          ? "Este link de ingreso ya fue usado. Ingresá con tu usuario y clave."
          : "El link de ingreso no es válido.";
    res.status(410).json({ error: mensaje });
    return;
  }
  // Links nuevos: van atados solo a la ficha del paciente. Para que el link
  // deje al paciente ADENTRO de la app (autologin real, pensado para gente
  // mayor), si la ficha no tiene cuenta se crea una automáticamente con una
  // clave aleatoria inutilizable (solo se entra por link).
  let user: typeof usersTable.$inferSelect | undefined;
  if (resultado.usuarioId === null) {
    const [paciente] = await db
      .select({ id: pacientesTable.id, nombre: pacientesTable.nombre, apellido: pacientesTable.apellido, activo: pacientesTable.activo })
      .from(pacientesTable)
      .where(eq(pacientesTable.id, resultado.pacienteId))
      .limit(1);
    if (!paciente || !paciente.activo) {
      res.status(410).json({ error: "El link de ingreso no es válido." });
      return;
    }
    const [existente] = await db
      .select()
      .from(usersTable)
      .where(and(eq(usersTable.pacienteId, String(paciente.id)), eq(usersTable.rol, "paciente")))
      .limit(1);
    if (existente) {
      user = existente;
    } else {
      const emailAuto = `paciente-${paciente.id}@mi.diagnosticar.ar`;
      const claveInutilizable = crypto.randomBytes(32).toString("hex");
      try {
        const [creado] = await db
          .insert(usersTable)
          .values({
            email: emailAuto,
            passwordHash: hashPassword(claveInutilizable),
            nombre: `${paciente.nombre} ${paciente.apellido}`.trim(),
            rol: "paciente",
            pacienteId: String(paciente.id),
            activo: "true",
          })
          .returning();
        user = creado;
      } catch {
        // Carrera: otro request creó la cuenta al mismo tiempo; reutilizarla.
        const [reintento] = await db
          .select()
          .from(usersTable)
          .where(and(eq(usersTable.pacienteId, String(paciente.id)), eq(usersTable.rol, "paciente")))
          .limit(1);
        user = reintento;
      }
    }
  } else {
    const [porId] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, resultado.usuarioId))
      .limit(1);
    user = porId;
  }
  if (!user || user.activo !== "true" || user.rol !== "paciente") {
    res.status(410).json({ error: "El link de ingreso no es válido." });
    return;
  }

  const token = generateToken(user.id);
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  await db.insert(sesionesTable).values({ token, usuarioId: user.id, activa: true, expiresAt });
  tokenStore.set(token, user.id);
  req.log.info({ userId: user.id }, "Paciente ingresó por link mágico");
  res.json({
    user: {
      id: user.id,
      email: user.email,
      nombre: user.nombre,
      rol: user.rol,
      perfil: user.perfil ?? null,
      profesionalId: user.profesionalId ? parseInt(user.profesionalId) : null,
      pacienteId: user.pacienteId ? parseInt(user.pacienteId) : null,
    },
    token,
  });
});

// Revoca TODAS las sesiones activas de un usuario (se usa al desactivar o
// reactivar una cuenta desde la gestión de usuarios: los tokens viejos no
// deben volver a servir).
export async function revocarSesionesDeUsuario(userId: number): Promise<number> {
  const revocadas = await db
    .update(sesionesTable)
    .set({ activa: false })
    .where(and(eq(sesionesTable.usuarioId, userId), eq(sesionesTable.activa, true)))
    .returning({ token: sesionesTable.token });
  for (const s of revocadas) {
    tokenStore.delete(s.token);
    vistaRolStore.delete(s.token);
  }
  return revocadas.length;
}

// Busca un usuario con el mismo criterio que el login: email exacto, o si el
// identificador no tiene "@", la parte antes del @ cuando es inequívoca.
async function buscarUsuarioPorIdentificador(identificador: string) {
  const [exacto] = await db
    .select()
    .from(usersTable)
    .where(sql`lower(${usersTable.email}) = ${identificador}`)
    .limit(1);
  if (exacto) return exacto;
  if (identificador.includes("@")) return null;
  const candidatos = await db
    .select()
    .from(usersTable)
    .where(sql`split_part(lower(${usersTable.email}), '@', 1) = ${identificador}`)
    .limit(2);
  return candidatos.length === 1 ? candidatos[0] : null;
}

// Rate limit simple en memoria para el endpoint público de recuperación:
// pocos intentos por IP por hora; suficiente para frenar abuso automatizado.
const olvideClaveIntentos = new Map<string, { count: number; resetAt: number }>();
const OLVIDE_MAX_POR_HORA = 5;
const MAX_PEDIDOS_PENDIENTES = 50;

// "Olvidé mi contraseña": público (desde el login, sin sesión). Deja un pedido
// que el administrador ve dentro de la app. Siempre responde ok para no
// revelar qué usuarios existen.
router.post("/auth/olvide-clave", async (req, res): Promise<void> => {
  const ip = req.ip ?? "desconocida";
  const ahora = Date.now();
  const reg = olvideClaveIntentos.get(ip);
  if (!reg || reg.resetAt < ahora) {
    olvideClaveIntentos.set(ip, { count: 1, resetAt: ahora + 60 * 60 * 1000 });
  } else if (reg.count >= OLVIDE_MAX_POR_HORA) {
    res.status(429).json({ error: "Demasiados intentos; probá de nuevo más tarde" });
    return;
  } else {
    reg.count += 1;
  }
  if (olvideClaveIntentos.size > 10_000) {
    for (const [k, v] of olvideClaveIntentos) if (v.resetAt < ahora) olvideClaveIntentos.delete(k);
  }
  const { usuario } = (req.body ?? {}) as { usuario?: unknown };
  if (typeof usuario !== "string" || usuario.trim().length < 3 || usuario.length > 120) {
    res.status(400).json({ error: "Ingresá tu email o usuario" });
    return;
  }
  const identificador = usuario.trim().toLowerCase();
  // Tope global de pendientes: acota el ruido operativo ante abuso.
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(pedidosRecuperacionTable)
    .where(eq(pedidosRecuperacionTable.estado, "pendiente"));
  if (total >= MAX_PEDIDOS_PENDIENTES) {
    // Responder ok igual: no revelar estado interno a un posible atacante.
    req.log.warn("Pedido de recuperación descartado: tope de pendientes alcanzado");
    res.json({ ok: true });
    return;
  }
  const pendientes = await db
    .select({ id: pedidosRecuperacionTable.id })
    .from(pedidosRecuperacionTable)
    .where(
      and(
        eq(pedidosRecuperacionTable.identificador, identificador),
        eq(pedidosRecuperacionTable.estado, "pendiente"),
      ),
    )
    .limit(1);
  if (pendientes.length === 0) {
    await db.insert(pedidosRecuperacionTable).values({ identificador });
    req.log.info("Pedido de recuperación de clave registrado");
  }
  res.json({ ok: true });
});

// Pedidos pendientes (solo admin), con el usuario vinculado si existe.
router.get("/auth/pedidos-recuperacion", requireRol("admin"), async (_req, res): Promise<void> => {
  const pedidos = await db
    .select()
    .from(pedidosRecuperacionTable)
    .where(eq(pedidosRecuperacionTable.estado, "pendiente"))
    .orderBy(pedidosRecuperacionTable.createdAt);
  const resultado = [];
  for (const p of pedidos) {
    const user = await buscarUsuarioPorIdentificador(p.identificador);
    resultado.push({
      id: p.id,
      identificador: p.identificador,
      createdAt: p.createdAt.toISOString(),
      usuario: user ? { id: user.id, email: user.email, nombre: user.nombre } : null,
    });
  }
  res.json(resultado);
});

// Resolver un pedido (solo admin): opcionalmente asigna clave nueva al usuario.
router.post("/auth/pedidos-recuperacion/:id/resolver", requireRol("admin"), async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const { nuevaClave } = (req.body ?? {}) as { nuevaClave?: unknown };
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Pedido inválido" });
    return;
  }
  const [pedido] = await db
    .select()
    .from(pedidosRecuperacionTable)
    .where(eq(pedidosRecuperacionTable.id, id))
    .limit(1);
  if (!pedido || pedido.estado !== "pendiente") {
    res.status(404).json({ error: "Pedido no encontrado" });
    return;
  }
  if (nuevaClave !== undefined) {
    if (typeof nuevaClave !== "string" || nuevaClave.length < 4) {
      res.status(400).json({ error: "La nueva contraseña debe tener al menos 4 caracteres" });
      return;
    }
    const user = await buscarUsuarioPorIdentificador(pedido.identificador);
    if (!user) {
      res.status(404).json({ error: "No hay un usuario con ese email/usuario; resolvelo sin asignar clave" });
      return;
    }
    await db
      .update(usersTable)
      .set({ passwordHash: hashPassword(nuevaClave) })
      .where(eq(usersTable.id, user.id));
    // Revocar sesiones existentes de ese usuario
    const revocadas = await db
      .update(sesionesTable)
      .set({ activa: false })
      .where(and(eq(sesionesTable.usuarioId, user.id), eq(sesionesTable.activa, true)))
      .returning({ token: sesionesTable.token });
    for (const s of revocadas) {
      tokenStore.delete(s.token);
      vistaRolStore.delete(s.token);
    }
    // También los links mágicos pendientes: la clave cambió.
    await revocarTokensIngresoDeUsuario(user.id);
  }
  await db
    .update(pedidosRecuperacionTable)
    .set({ estado: "resuelto", resueltoAt: new Date() })
    .where(eq(pedidosRecuperacionTable.id, id));
  req.log.info({ pedidoId: id, conClave: nuevaClave !== undefined }, "Pedido de recuperación resuelto");
  res.json({ ok: true });
});

router.get("/auth/me", async (req, res): Promise<void> => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }
  const resuelto = await resolverUsuarioEfectivo(token);
  if (!resuelto) {
    res.status(401).json({ error: "Token inválido o expirado" });
    return;
  }
  const { user, real, vistaRol } = resuelto;
  res.json({
    id: user.id,
    email: user.email,
    nombre: user.nombre,
    rol: user.rol,
    perfil: user.perfil ?? null,
    profesionalId: user.profesionalId ? parseInt(user.profesionalId) : null,
    pacienteId: user.pacienteId ? parseInt(user.pacienteId) : null,
    vistaRol,
    puedeCambiarVista: real.rol === "admin",
  });
});

// Cambiar la vista de rol simulada (solo admins; rol=null vuelve al perfil real)
router.post("/auth/vista-rol", async (req, res): Promise<void> => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }
  const userId = await getUserIdFromToken(token);
  if (!userId) {
    res.status(401).json({ error: "Token inválido o expirado" });
    return;
  }
  const [real] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!real || real.rol !== "admin") {
    res.status(403).json({ error: "Solo admins pueden cambiar la vista" });
    return;
  }
  const rol = req.body?.rol ?? null;
  if (rol !== null && !(ROLES_VISTA as readonly string[]).includes(rol)) {
    res.status(400).json({ error: "Rol de vista inválido" });
    return;
  }

  await db.update(sesionesTable).set({ vistaRol: rol }).where(eq(sesionesTable.token, token));
  vistaRolStore.set(token, rol);
  req.log.info({ userId, vistaRol: rol }, "Vista de rol cambiada");

  const resuelto = await resolverUsuarioEfectivo(token);
  const user = resuelto?.user ?? real;
  res.json({
    id: user.id,
    email: user.email,
    nombre: user.nombre,
    rol: user.rol,
    perfil: user.perfil ?? null,
    profesionalId: user.profesionalId ? parseInt(user.profesionalId) : null,
    pacienteId: user.pacienteId ? parseInt(user.pacienteId) : null,
    vistaRol: resuelto?.vistaRol ?? null,
    puedeCambiarVista: true,
  });
});

// ── Modo "ver como" (solo admins) ─────────────────────────────────────────────
// El admin puede simular otro rol sin cerrar sesión: la sesión guarda vista_rol
// y todas las requests se resuelven como el usuario demo de ese rol.
const ROLES_VISTA_BASE = ["recepcionista", "medico", "paciente"] as const;
// Perfiles funcionales que también se pueden simular (usuarios con users.perfil)
const PERFILES_VISTA = ["administracion", "administrador_caja", "tecnico", "medico_consulta", "medico_informante", "medico_consulta_informante", "gerente", "desarrollador"] as const;
const ROLES_VISTA = [...ROLES_VISTA_BASE, ...PERFILES_VISTA] as const;

// Caché en memoria del override por token (write-through, igual que tokenStore)
const vistaRolStore = new Map<string, string | null>();

async function getVistaRol(token: string): Promise<string | null> {
  if (vistaRolStore.has(token)) return vistaRolStore.get(token) ?? null;
  const [sesion] = await db
    .select({ vistaRol: sesionesTable.vistaRol })
    .from(sesionesTable)
    .where(eq(sesionesTable.token, token))
    .limit(1);
  const vista = sesion?.vistaRol ?? null;
  vistaRolStore.set(token, vista);
  return vista;
}

async function usuarioRepresentativoDeRol(
  rol: string,
): Promise<typeof usersTable.$inferSelect | null> {
  const [user] = await db
    .select()
    .from(usersTable)
    .where(and(eq(usersTable.rol, rol), eq(usersTable.activo, "true")))
    .orderBy(usersTable.id)
    .limit(1);
  return user ?? null;
}

// Para perfiles funcionales buscamos el primer usuario activo con ese perfil.
async function usuarioRepresentativoDePerfil(
  perfil: string,
): Promise<typeof usersTable.$inferSelect | null> {
  const [user] = await db
    .select()
    .from(usersTable)
    .where(and(eq(usersTable.perfil, perfil), eq(usersTable.activo, "true")))
    .orderBy(usersTable.id)
    .limit(1);
  return user ?? null;
}

/**
 * Resuelve el usuario "efectivo" de la request: si el usuario real es admin
 * y su sesión tiene una vista de rol activa, devuelve el usuario demo de ese
 * rol. Además informa el usuario real para poder mostrar el switcher.
 */
async function resolverUsuarioEfectivo(token: string): Promise<{
  user: typeof usersTable.$inferSelect;
  real: typeof usersTable.$inferSelect;
  vistaRol: string | null;
} | null> {
  const userId = await getUserIdFromToken(token);
  if (!userId) return null;
  const [real] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!real) return null;

  if (real.rol === "admin") {
    const vista = await getVistaRol(token);
    if (vista && (ROLES_VISTA as readonly string[]).includes(vista)) {
      const simulado = (PERFILES_VISTA as readonly string[]).includes(vista)
        ? await usuarioRepresentativoDePerfil(vista)
        : await usuarioRepresentativoDeRol(vista);
      if (simulado) return { user: simulado, real, vistaRol: vista };
    }
  }
  return { user: real, real, vistaRol: null };
}

export async function getUserFromRequest(
  req: import("express").Request,
): Promise<typeof usersTable.$inferSelect | null> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  const resuelto = await resolverUsuarioEfectivo(token);
  return resuelto?.user ?? null;
}

export type UsuarioAutenticado = typeof usersTable.$inferSelect;

/**
 * Middleware de autorización por rol. Adjunta el usuario en res.locals.user.
 * Uso: router.get("/ruta", requireRol("admin", "recepcionista"), handler)
 */
export function requireRol(
  ...roles: string[]
): import("express").RequestHandler {
  return async (req, res, next) => {
    const user = await getUserFromRequest(req);
    if (!user) {
      res.status(401).json({ error: "No autenticado" });
      return;
    }
    if (user.activo !== "true") {
      res.status(401).json({ error: "Usuario deshabilitado" });
      return;
    }
    if (roles.length > 0 && !roles.includes(user.rol)) {
      res.status(403).json({ error: "No autorizado" });
      return;
    }
    res.locals.user = user;
    next();
  };
}

export { hashPassword, getUserIdFromToken };
export default router;
