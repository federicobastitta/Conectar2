import crypto from "node:crypto";
import { and, eq, like, lt, sql } from "drizzle-orm";
import { db, configSistemaTable } from "@workspace/db";

// ── Links mágicos de ingreso del paciente (autologin por WhatsApp) ─────────
// Token opaco PERMANENTE y REUTILIZABLE, atado a la ficha del paciente: una vez
// en el WhatsApp del paciente, el link es su llave personal de ingreso a la app
// (decisión del usuario: compartirlo es responsabilidad del paciente).
// En la DB se guarda SOLO el hash SHA-256 del token (nunca el valor plano),
// como fila de config_sistema con prefijo, igual que los códigos efímeros de TV.
// El valor es JSON: { estado, usuarioId, pacienteId, generadoPorId,
// generadoPorEmail, creadoEn, expiraEn?, usos?, ultimoUsoEn? }.
// Los links viejos (de un solo uso / con vencimiento) siguen respetando sus
// reglas originales; los nuevos no vencen ni se agotan. Revocarlos = borrarlos.

export const PREFIJO_AUTOLOGIN = "autologin_paciente_";
// Las filas de links viejos de un solo uso ya consumidos se conservan un tiempo
// como auditoría y luego se limpian de forma perezosa al generar nuevos links.
// Los links permanentes NUNCA se limpian por edad.
const RETENCION_MS = 30 * 24 * 60 * 60 * 1000;

type DatosAutologin = {
  estado: "pendiente" | "usado";
  // null cuando el paciente no tiene usuario en Conectar (las cuentas de los
  // pacientes viven en la app Mi Diagnosticar; alcanza con la ficha).
  usuarioId: number | null;
  pacienteId: number;
  generadoPorId: number;
  generadoPorEmail: string;
  creadoEn: string;
  // Solo los links viejos tienen vencimiento; los nuevos son permanentes.
  expiraEn?: string;
  usadoEn?: string;
  usos?: number;
  ultimoUsoEn?: string;
};

function hashToken(tokenPlano: string): string {
  return crypto.createHash("sha256").update(tokenPlano).digest("hex");
}

function claveDe(tokenPlano: string): string {
  return `${PREFIJO_AUTOLOGIN}${hashToken(tokenPlano)}`;
}

function parsearDatos(valor: string): DatosAutologin | null {
  try {
    const datos = JSON.parse(valor) as DatosAutologin;
    if (typeof datos.pacienteId !== "number") return null;
    if (typeof datos.usuarioId !== "number" && datos.usuarioId !== null) return null;
    return datos;
  } catch {
    return null;
  }
}

/** Limpieza perezosa: borra SOLO filas de links viejos ya consumidos ("usado"). */
async function limpiarViejas(): Promise<void> {
  const limite = new Date(Date.now() - RETENCION_MS);
  await db
    .delete(configSistemaTable)
    .where(
      and(
        like(configSistemaTable.clave, `${PREFIJO_AUTOLOGIN}%`),
        // Nunca tocar links vigentes: los permanentes viven en estado "pendiente".
        sql`${configSistemaTable.valor} LIKE '%"estado":"usado"%'`,
        lt(configSistemaTable.actualizadoEn, limite),
      ),
    );
}

/**
 * Genera un token de ingreso permanente y reutilizable para el paciente dado.
 * Devuelve el token PLANO (solo para armar el link; nunca se persiste).
 */
export async function generarTokenIngreso(opts: {
  usuarioId: number | null;
  pacienteId: number;
  generadoPorId: number;
  generadoPorEmail: string;
}): Promise<{ tokenPlano: string }> {
  await limpiarViejas();
  const tokenPlano = crypto.randomBytes(32).toString("base64url");
  const ahora = new Date();
  const datos: DatosAutologin = {
    estado: "pendiente",
    usuarioId: opts.usuarioId,
    pacienteId: opts.pacienteId,
    generadoPorId: opts.generadoPorId,
    generadoPorEmail: opts.generadoPorEmail,
    creadoEn: ahora.toISOString(),
  };
  await db.insert(configSistemaTable).values({
    clave: claveDe(tokenPlano),
    valor: JSON.stringify(datos),
    actualizadoEn: ahora,
  });
  return { tokenPlano };
}

export type ResultadoConsumo =
  | { ok: true; usuarioId: number | null; pacienteId: number }
  | { ok: false; motivo: "invalido" | "vencido" | "usado" };

/**
 * Valida un token de ingreso. Los links son reutilizables: NO se marcan como
 * usados; solo se registra la cantidad de usos y la fecha del último, como
 * auditoría. Los links viejos conservan sus reglas (un solo uso, vencimiento).
 */
export async function consumirTokenIngreso(tokenPlano: string): Promise<ResultadoConsumo> {
  const clave = claveDe(tokenPlano);
  const [row] = await db
    .select()
    .from(configSistemaTable)
    .where(eq(configSistemaTable.clave, clave))
    .limit(1);
  if (!row) return { ok: false, motivo: "invalido" };
  const datos = parsearDatos(row.valor);
  if (!datos) return { ok: false, motivo: "invalido" };
  if (datos.estado !== "pendiente") return { ok: false, motivo: "usado" };
  if (datos.expiraEn && new Date(datos.expiraEn).getTime() < Date.now()) {
    return { ok: false, motivo: "vencido" };
  }
  const ahora = new Date();
  await db
    .update(configSistemaTable)
    .set({
      valor: JSON.stringify({
        ...datos,
        usos: (datos.usos ?? 0) + 1,
        ultimoUsoEn: ahora.toISOString(),
      }),
      actualizadoEn: ahora,
    })
    .where(eq(configSistemaTable.clave, clave));
  return { ok: true, usuarioId: datos.usuarioId, pacienteId: datos.pacienteId };
}

export type LinkIngresoVigente = {
  creadoEn: string;
  generadoPorEmail: string;
  usos: number;
  ultimoUsoEn: string | null;
  expiraEn: string | null;
};

/**
 * Lista los links de ingreso VIGENTES (estado "pendiente" y no vencidos) de un
 * paciente, para que gestión pueda auditarlos desde la ficha. Nunca expone el
 * token (solo se guarda el hash); devuelve metadatos de auditoría.
 */
export async function listarTokensIngresoDePaciente(pacienteId: number): Promise<LinkIngresoVigente[]> {
  const filas = await db
    .select()
    .from(configSistemaTable)
    .where(like(configSistemaTable.clave, `${PREFIJO_AUTOLOGIN}%`));
  const vigentes: LinkIngresoVigente[] = [];
  for (const fila of filas) {
    const datos = parsearDatos(fila.valor);
    if (!datos || datos.pacienteId !== pacienteId || datos.estado !== "pendiente") continue;
    if (datos.expiraEn && new Date(datos.expiraEn).getTime() < Date.now()) continue;
    vigentes.push({
      creadoEn: datos.creadoEn,
      generadoPorEmail: datos.generadoPorEmail,
      usos: datos.usos ?? 0,
      ultimoUsoEn: datos.ultimoUsoEn ?? null,
      expiraEn: datos.expiraEn ?? null,
    });
  }
  vigentes.sort((a, b) => b.creadoEn.localeCompare(a.creadoEn));
  return vigentes;
}

/**
 * Anula (borra) todos los links de ingreso vigentes de un paciente. El portal
 * pasa a responder "invalido" para esos tokens. Devuelve cuántos se borraron.
 */
export async function revocarTokensIngresoDePaciente(pacienteId: number): Promise<number> {
  const filas = await db
    .select()
    .from(configSistemaTable)
    .where(like(configSistemaTable.clave, `${PREFIJO_AUTOLOGIN}%`));
  let revocados = 0;
  for (const fila of filas) {
    const datos = parsearDatos(fila.valor);
    if (!datos || datos.pacienteId !== pacienteId || datos.estado !== "pendiente") continue;
    const borradas = await db
      .delete(configSistemaTable)
      .where(
        and(
          eq(configSistemaTable.clave, fila.clave),
          // Guarda contra carreras: solo borrar si sigue pendiente.
          sql`${configSistemaTable.valor} LIKE '%"estado":"pendiente"%'`,
        ),
      )
      .returning({ clave: configSistemaTable.clave });
    revocados += borradas.length;
  }
  return revocados;
}

/**
 * Revoca todos los links de ingreso pendientes de un usuario (ej: cuando el
 * paciente cambia su clave o un admin se la resetea).
 */
export async function revocarTokensIngresoDeUsuario(usuarioId: number): Promise<number> {
  const filas = await db
    .select()
    .from(configSistemaTable)
    .where(like(configSistemaTable.clave, `${PREFIJO_AUTOLOGIN}%`));
  let revocados = 0;
  for (const fila of filas) {
    const datos = parsearDatos(fila.valor);
    if (!datos || datos.usuarioId !== usuarioId || datos.estado !== "pendiente") continue;
    const borradas = await db
      .delete(configSistemaTable)
      .where(
        and(
          eq(configSistemaTable.clave, fila.clave),
          sql`${configSistemaTable.valor} LIKE '%"estado":"pendiente"%'`,
        ),
      )
      .returning({ clave: configSistemaTable.clave });
    revocados += borradas.length;
  }
  return revocados;
}
