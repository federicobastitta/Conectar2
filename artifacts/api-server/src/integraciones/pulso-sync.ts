import { and, eq, inArray } from "drizzle-orm";
import type { Logger } from "pino";
import {
  db,
  pacientesTable,
  pacientesExternosTable,
  auditLogTable,
} from "@workspace/db";
import { fetchPacientesPage, pulsoConfigurado, type PulsoPaciente } from "./pulso-client";

const ORIGEN = "pulso";
const PAGE_SIZE = 100;
// Tope de seguridad para no barrer infinito si la API cambia la paginación.
const MAX_PAGINAS = 500;

// HC = DNI del paciente; el formato legacy HC000123 queda solo para sin-DNI.
function generarNumeroHc(id: number, dni?: string | null): string {
  const dniLimpio = (dni ?? "").trim();
  if (dniLimpio) return dniLimpio;
  return "HC" + String(id).padStart(6, "0");
}

function limpiar(valor: string | null | undefined): string | null {
  if (valor == null) return null;
  const t = String(valor).trim();
  return t.length > 0 ? t : null;
}

// Campos de un paciente de Pulso mapeados a las columnas de Conectar.
// Solo se incluyen valores presentes: NO pisamos datos locales con nulls.
export type PacienteMapeado = {
  nombre: string;
  apellido: string;
  dni: string | null;
  campos: {
    fechaNacimiento?: string;
    sexo?: string;
    telefono?: string;
    telefonoAlternativo?: string;
    email?: string;
    cobertura?: string;
    nroAfiliado?: string;
  };
};

// Mapeo puro Pulso → Conectar (testeable sin DB ni red).
export function mapPulsoPaciente(p: PulsoPaciente): PacienteMapeado {
  const campos: PacienteMapeado["campos"] = {};
  const fechaNacimiento = limpiar(p.fecha_nacimiento);
  const sexo = limpiar(p.sexo);
  const telefono = limpiar(p.telefono);
  const whatsapp = limpiar(p.whatsapp);
  const email = limpiar(p.email);
  const cobertura = limpiar(p.obra_social?.nombre ?? null);
  const nroAfiliado = limpiar(p.numero_afiliado);

  if (fechaNacimiento) campos.fechaNacimiento = fechaNacimiento;
  if (sexo) campos.sexo = sexo;
  // El teléfono principal es el móvil (whatsapp); el fijo se descarta.
  if (whatsapp) {
    campos.telefono = whatsapp;
  } else if (telefono) {
    campos.telefono = telefono;
  }
  if (email) campos.email = email;
  if (cobertura) campos.cobertura = cobertura;
  if (nroAfiliado) campos.nroAfiliado = nroAfiliado;

  return {
    nombre: limpiar(p.nombre) ?? "Sin nombre",
    apellido: limpiar(p.apellido) ?? "Sin apellido",
    dni: limpiar(p.dni),
    campos,
  };
}

export type SyncStats = {
  paginas: number;
  vistos: number;
  creados: number;
  actualizados: number;
  sinDni: number;
  errores: number;
};

export type EstadoSync = {
  sincronizando: boolean;
  iniciadoEn: string | null;
  terminadoEn: string | null;
  ultimoResultado: SyncStats | null;
  ultimoError: string | null;
  ultimoModo: "incremental" | "completo" | null;
};

const estado: EstadoSync = {
  sincronizando: false,
  iniciadoEn: null,
  terminadoEn: null,
  ultimoResultado: null,
  ultimoError: null,
  ultimoModo: null,
};

export function getEstadoSync(): EstadoSync {
  return { ...estado };
}

// Upsert de un paciente de Pulso. Deduplica por el id de Pulso
// (pacientes_externos) y, en su defecto, por DNI. Devuelve "creado" | "actualizado".
async function upsertPaciente(
  actor: { id: number | null; email: string; rol: string },
  externo: PulsoPaciente,
  log: Logger,
): Promise<"creado" | "actualizado"> {
  const mapeado = mapPulsoPaciente(externo);
  const externalCreatedAt = externo.created_at ? new Date(externo.created_at) : null;
  const externalUpdatedAt = externo.updated_at ? new Date(externo.updated_at) : null;

  // 1) ¿Ya lo importamos antes? (id de Pulso)
  const [yaMapeado] = await db
    .select()
    .from(pacientesExternosTable)
    .where(
      and(
        eq(pacientesExternosTable.origen, ORIGEN),
        eq(pacientesExternosTable.externalId, externo.id),
      ),
    )
    .limit(1);

  // 2) Si no, ¿existe un paciente con ese DNI?
  let pacienteId = yaMapeado?.patientId ?? null;
  if (pacienteId == null && mapeado.dni) {
    const [existente] = await db
      .select({ id: pacientesTable.id })
      .from(pacientesTable)
      .where(eq(pacientesTable.dni, mapeado.dni))
      .limit(1);
    if (existente) pacienteId = existente.id;
  }

  let modo: "creado" | "actualizado";

  if (pacienteId == null) {
    // Crear paciente nuevo
    const [inserted] = await db
      .insert(pacientesTable)
      .values({
        nombre: mapeado.nombre,
        apellido: mapeado.apellido,
        dni: mapeado.dni,
        ...mapeado.campos,
        activo: true,
        creadoPor: actor.id,
        observacionesAdmin: "Importado de Pulso",
      })
      .returning({ id: pacientesTable.id });
    pacienteId = inserted.id;
    await db
      .update(pacientesTable)
      .set({ numeroHc: generarNumeroHc(pacienteId, mapeado.dni) })
      .where(eq(pacientesTable.id, pacienteId));
    modo = "creado";
  } else {
    // Actualizar solo los campos que Pulso trae (sin pisar con nulls)
    await db
      .update(pacientesTable)
      .set({
        ...mapeado.campos,
        modificadoPor: actor.id,
        modificadoEn: new Date(),
      })
      .where(eq(pacientesTable.id, pacienteId));
    modo = "actualizado";
  }

  // 3) Registrar/actualizar el mapeo externo
  await db
    .insert(pacientesExternosTable)
    .values({
      origen: ORIGEN,
      externalId: externo.id,
      patientId: pacienteId,
      externalCreatedAt,
      externalUpdatedAt,
      lastSyncedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [pacientesExternosTable.origen, pacientesExternosTable.externalId],
      set: {
        patientId: pacienteId,
        externalCreatedAt,
        externalUpdatedAt,
        lastSyncedAt: new Date(),
        updatedAt: new Date(),
      },
    });

  log.debug({ externalId: externo.id, modo }, "Pulso: paciente sincronizado");
  return modo;
}

// Corre una sincronización de pacientes de Pulso.
// - incremental (default): recorre de más nuevo a más viejo y frena al toparse
//   con un id de Pulso ya conocido (todo lo anterior ya está importado).
// - completo: recorre todas las páginas (capta ediciones de pacientes viejos).
export async function sincronizarPacientesPulso(
  opts: {
    full?: boolean;
    actor?: { id: number | null; email: string; rol: string };
    log: Logger;
  },
): Promise<SyncStats> {
  const { full = false, log } = opts;
  const actor = opts.actor ?? { id: null, email: "sistema@pulso", rol: "sistema" };

  if (estado.sincronizando) {
    throw new Error("Ya hay una sincronización de Pulso en curso");
  }
  if (!pulsoConfigurado()) {
    throw new Error("Pulso no está configurado (faltan PULSO_USERNAME/PULSO_PASSWORD)");
  }

  const stats: SyncStats = { paginas: 0, vistos: 0, creados: 0, actualizados: 0, sinDni: 0, errores: 0 };
  estado.sincronizando = true;
  estado.iniciadoEn = new Date().toISOString();
  estado.terminadoEn = null;
  estado.ultimoError = null;
  estado.ultimoModo = full ? "completo" : "incremental";

  log.info({ modo: estado.ultimoModo }, "Pulso: sync iniciada");

  try {
    let page = 1;
    let seguir = true;
    while (seguir && page <= MAX_PAGINAS) {
      const data = await fetchPacientesPage(page, PAGE_SIZE, log);
      stats.paginas += 1;
      const results = data.results ?? [];
      if (results.length === 0) break;

      // Incremental: averiguar ANTES de upsertear cuáles ids ya conocíamos.
      // (upsertPaciente inserta el mapeo, así que hay que medir antes.)
      let todosConocidos = false;
      if (!full) {
        const idsPagina = results.map((r) => r.id).filter(Boolean);
        const conocidos =
          idsPagina.length > 0
            ? await db
                .select({ externalId: pacientesExternosTable.externalId })
                .from(pacientesExternosTable)
                .where(
                  and(
                    eq(pacientesExternosTable.origen, ORIGEN),
                    inArray(pacientesExternosTable.externalId, idsPagina),
                  ),
                )
            : [];
        todosConocidos = idsPagina.length > 0 && conocidos.length >= idsPagina.length;
      }

      for (const externo of results) {
        stats.vistos += 1;
        if (!externo.id) {
          stats.errores += 1;
          continue;
        }
        try {
          const mapeado = mapPulsoPaciente(externo);
          if (!mapeado.dni) stats.sinDni += 1;
          const modo = await upsertPaciente(actor, externo, log);
          if (modo === "creado") stats.creados += 1;
          else stats.actualizados += 1;
        } catch (err) {
          stats.errores += 1;
          log.error({ err, externalId: externo.id }, "Pulso: error al sincronizar paciente");
        }
      }

      // Incremental: si toda la página ya estaba importada (ordenada de más
      // nueva a más vieja), el resto ya está en Conectar → frenamos.
      if (!full && todosConocidos) seguir = false;

      if (!data.next) seguir = false;
      page += 1;
    }

    estado.ultimoResultado = stats;
    log.info({ stats }, "Pulso: sync terminada");

    await db.insert(auditLogTable).values({
      usuarioId: actor.id,
      usuarioEmail: actor.email,
      rol: actor.rol,
      accion: "sync_pulso",
      entidad: "pacientes_externos",
      entidadId: null,
      pacienteId: null,
      detalle: { modo: estado.ultimoModo, ...stats },
    });

    return stats;
  } catch (err) {
    estado.ultimoError = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Pulso: sync falló");
    throw err;
  } finally {
    estado.sincronizando = false;
    estado.terminadoEn = new Date().toISOString();
  }
}
