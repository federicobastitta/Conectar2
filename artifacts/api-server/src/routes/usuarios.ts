import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import {
  CreateUsuarioBody,
  UpdateUsuarioBody,
  UpdateUsuarioParams,
} from "@workspace/api-zod";
import { requireRol, hashPassword, revocarSesionesDeUsuario } from "./auth";
import { revocarTokensIngresoDeUsuario } from "../lib/autologin-paciente";
import { esViolacionUnique } from "../lib/pg";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// Mapa perfil funcional → rol de permisos existente
const ROL_POR_PERFIL: Record<string, string> = {
  administracion: "recepcionista",
  administrador_caja: "recepcionista",
  tecnico: "recepcionista",
  medico: "medico", // legado: ya no se ofrece al crear, pero puede existir en datos viejos
  medico_consulta: "medico",
  medico_informante: "medico",
  medico_consulta_informante: "medico",
  gerente: "admin",
  desarrollador: "admin",
};

// Perfiles médicos que pueden tener un profesional vinculado
const PERFILES_MEDICOS = new Set(["medico", "medico_consulta", "medico_informante", "medico_consulta_informante"]);

// La gestión de usuarios es exclusiva del administrador y el desarrollador.
// El gerente tiene rol admin para el resto del sistema, pero NO administra usuarios.
const soloGestionUsuarios: import("express").RequestHandler = (_req, res, next) => {
  const user = res.locals.user as typeof usersTable.$inferSelect | undefined;
  if (user?.perfil === "gerente") {
    res.status(403).json({ error: "Solo el administrador o el desarrollador pueden gestionar usuarios" });
    return;
  }
  next();
};

function usuarioPublico(u: typeof usersTable.$inferSelect) {
  return {
    id: u.id,
    email: u.email,
    nombre: u.nombre,
    rol: u.rol,
    perfil: u.perfil ?? null,
    profesionalId: u.profesionalId ? parseInt(u.profesionalId) : null,
    activo: u.activo === "true",
    createdAt: u.createdAt.toISOString(),
  };
}

router.get("/usuarios", requireRol("admin"), soloGestionUsuarios, async (_req, res): Promise<void> => {
  const usuarios = await db.select().from(usersTable).orderBy(usersTable.id);
  res.json(usuarios.map(usuarioPublico));
});

router.post("/usuarios", requireRol("admin"), soloGestionUsuarios, async (req, res): Promise<void> => {
  const parsed = CreateUsuarioBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { email, nombre, password, perfil, profesionalId } = parsed.data;
  const emailNormalizado = email.trim().toLowerCase();
  // Un solo usuario activo por profesional: evita resetear la clave de una
  // cuenta distinta a la esperada cuando hay vínculos duplicados.
  if (PERFILES_MEDICOS.has(perfil) && profesionalId != null) {
    const activos = await db
      .select({ id: usersTable.id, email: usersTable.email, activo: usersTable.activo })
      .from(usersTable)
      .where(eq(usersTable.profesionalId, String(profesionalId)));
    const activo = activos.find((u) => u.activo === "true");
    if (activo) {
      res.status(409).json({
        error: `Ese profesional ya tiene un usuario activo (${activo.email})`,
      });
      return;
    }
  }
  try {
    const [creado] = await db
      .insert(usersTable)
      .values({
        email: emailNormalizado,
        nombre,
        passwordHash: hashPassword(password),
        rol: ROL_POR_PERFIL[perfil] ?? "recepcionista",
        perfil,
        profesionalId:
          PERFILES_MEDICOS.has(perfil) && profesionalId != null ? String(profesionalId) : null,
      })
      .returning();
    req.log.info({ usuarioId: creado.id, perfil }, "Usuario creado");
    res.status(201).json(usuarioPublico(creado));
  } catch (err: unknown) {
    if (esViolacionUnique(err)) {
      // El nombre de usuario ya existe. Si es de una cuenta desactivada, la
      // reactivamos con los datos nuevos (misma regla que pacientes por DNI):
      // así un usuario dado de baja no bloquea su nombre para siempre.
      const [existente] = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.email, emailNormalizado))
        .limit(1);
      if (existente && existente.activo !== "true") {
        // Re-chequear la regla "un solo usuario activo por profesional" antes
        // de reactivar (la validación de arriba corrió antes del insert).
        if (PERFILES_MEDICOS.has(perfil) && profesionalId != null) {
          const activos = await db
            .select({ id: usersTable.id, email: usersTable.email, activo: usersTable.activo })
            .from(usersTable)
            .where(eq(usersTable.profesionalId, String(profesionalId)));
          const activo = activos.find((u) => u.activo === "true" && u.id !== existente.id);
          if (activo) {
            res.status(409).json({
              error: `Ese profesional ya tiene un usuario activo (${activo.email})`,
            });
            return;
          }
        }
        const [reactivado] = await db
          .update(usersTable)
          .set({
            nombre,
            passwordHash: hashPassword(password),
            rol: ROL_POR_PERFIL[perfil] ?? "recepcionista",
            perfil,
            profesionalId:
              PERFILES_MEDICOS.has(perfil) && profesionalId != null ? String(profesionalId) : null,
            activo: "true",
          })
          .where(eq(usersTable.id, existente.id))
          .returning();
        // Los tokens de la cuenta vieja no deben volver a servir.
        await revocarSesionesDeUsuario(existente.id);
        req.log.info({ usuarioId: reactivado.id, perfil }, "Usuario reactivado");
        res.status(201).json(usuarioPublico(reactivado));
        return;
      }
      res.status(409).json({ error: "Ese nombre de usuario ya está en uso por otra cuenta activa. Elegí otro." });
      return;
    }
    throw err;
  }
});

router.patch("/usuarios/:id", requireRol("admin"), soloGestionUsuarios, async (req, res): Promise<void> => {
  const params = UpdateUsuarioParams.safeParse({ id: Number(req.params.id) });
  const parsed = UpdateUsuarioBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: "Datos inválidos" });
    return;
  }
  const cambios: Partial<typeof usersTable.$inferInsert> = {};
  if (parsed.data.email !== undefined) cambios.email = parsed.data.email.trim().toLowerCase();
  if (parsed.data.nombre !== undefined) cambios.nombre = parsed.data.nombre;
  if (parsed.data.password !== undefined) cambios.passwordHash = hashPassword(parsed.data.password);
  if (parsed.data.perfil !== undefined) {
    cambios.perfil = parsed.data.perfil;
    cambios.rol = ROL_POR_PERFIL[parsed.data.perfil] ?? "recepcionista";
    if (!PERFILES_MEDICOS.has(parsed.data.perfil)) cambios.profesionalId = null;
  }
  if (parsed.data.profesionalId !== undefined) {
    if (parsed.data.profesionalId === null) {
      cambios.profesionalId = null;
    } else {
      let perfilFinal: string | undefined = parsed.data.perfil;
      if (perfilFinal === undefined) {
        const [existente] = await db
          .select({ perfil: usersTable.perfil })
          .from(usersTable)
          .where(eq(usersTable.id, params.data.id))
          .limit(1);
        perfilFinal = existente?.perfil ?? undefined;
      }
      cambios.profesionalId =
        perfilFinal != null && PERFILES_MEDICOS.has(perfilFinal) ? String(parsed.data.profesionalId) : null;
    }
  }
  if (parsed.data.activo !== undefined) cambios.activo = parsed.data.activo ? "true" : "false";
  if (Object.keys(cambios).length === 0) {
    res.status(400).json({ error: "Sin cambios" });
    return;
  }
  let actualizado: typeof usersTable.$inferSelect | undefined;
  try {
    [actualizado] = await db
      .update(usersTable)
      .set(cambios)
      .where(eq(usersTable.id, params.data.id))
      .returning();
  } catch (err: unknown) {
    if (esViolacionUnique(err)) {
      res.status(409).json({ error: "Ese nombre de usuario ya está en uso por otra cuenta. Elegí otro." });
      return;
    }
    throw err;
  }
  if (!actualizado) {
    res.status(404).json({ error: "Usuario no encontrado" });
    return;
  }
  // Al desactivar una cuenta, sus sesiones abiertas dejan de servir al instante.
  if (parsed.data.activo === false) await revocarSesionesDeUsuario(actualizado.id);
  // Si un admin le resetea la clave o la desactiva, los links mágicos de
  // ingreso pendientes tampoco deben volver a servir.
  if (parsed.data.password !== undefined || parsed.data.activo === false) {
    await revocarTokensIngresoDeUsuario(actualizado.id);
  }
  req.log.info({ usuarioId: actualizado.id }, "Usuario actualizado");
  res.json(usuarioPublico(actualizado));
});

// Usuarios por defecto de cada perfil (idempotente, corre al arrancar el server).
const USUARIOS_POR_DEFECTO: {
  email: string;
  nombre: string;
  perfil: string;
  password: string;
}[] = [
  { email: "administrador@diagnosticar.ar", nombre: "Administrador", perfil: "administracion", password: "Diagnosticar" },
  { email: "tecnico@diagnosticar.ar", nombre: "Técnico", perfil: "tecnico", password: "diagnosticar" },
  { email: "medico@diagnosticar.ar", nombre: "Dr. Carlos Gómez", perfil: "medico_consulta_informante", password: "diagnosticar" },
  { email: "caja@diagnosticar.ar", nombre: "Administrador Caja", perfil: "administrador_caja", password: "diagnosticar" },
  { email: "gerente@diagnosticar.ar", nombre: "Gerente", perfil: "gerente", password: "diagnosticar" },
  { email: "desarrollador@diagnosticar.ar", nombre: "Desarrollador", perfil: "desarrollador", password: "diagnosticar" },
];

export async function asegurarUsuariosPorDefecto(): Promise<void> {
  // Migración: el perfil "medico" (común) se reemplazó por "medico de consulta
  // e informante". Se corre en cada arranque (idempotente) para dev y prod.
  await db
    .update(usersTable)
    .set({ perfil: "medico_consulta_informante" })
    .where(eq(usersTable.perfil, "medico"));
  for (const def of USUARIOS_POR_DEFECTO) {
    const [existente] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, def.email))
      .limit(1);
    if (existente) {
      // Mantener perfil y rol alineados al mapa vigente; no tocar la contraseña.
      const rolEsperado = ROL_POR_PERFIL[def.perfil] ?? "recepcionista";
      if (!existente.perfil || existente.rol !== rolEsperado) {
        await db
          .update(usersTable)
          .set({ perfil: existente.perfil ?? def.perfil, rol: rolEsperado })
          .where(eq(usersTable.id, existente.id));
        logger.info({ email: def.email, perfil: def.perfil, rol: rolEsperado }, "Usuario por defecto sincronizado");
      }
      continue;
    }
    await db.insert(usersTable).values({
      email: def.email,
      nombre: def.nombre,
      passwordHash: hashPassword(def.password),
      rol: ROL_POR_PERFIL[def.perfil] ?? "recepcionista",
      perfil: def.perfil,
    });
    logger.info({ email: def.email, perfil: def.perfil }, "Usuario por defecto creado");
  }
}

export default router;
