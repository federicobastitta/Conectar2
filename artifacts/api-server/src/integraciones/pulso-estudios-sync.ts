import { and, eq, sql } from "drizzle-orm";
import type { Logger } from "pino";
import {
  db,
  pacientesTable,
  pacientesExternosTable,
  pulsoEstudiosTable,
  auditLogTable,
} from "@workspace/db";
import { fetchEstudiosPage, pulsoConfigurado, type PulsoEstudio } from "./pulso-client";

const ORIGEN = "pulso";
const PAGE_SIZE = 100;
const MAX_PAGINAS = 500;
// Ventana rodante (días) para el sync incremental: re-sincroniza los estudios
// recientes para captar firmas y cambios de estado que ocurren después de crear
// el estudio (created_at no cambia, pero el informe se firma más tarde).
const DEFAULT_VENTANA_DIAS = 45;

function limpiar(valor: string | null | undefined): string | null {
  if (valor == null) return null;
  const t = String(valor).trim();
  return t.length > 0 ? t : null;
}

function nombreCompleto(
  p: { first_name?: string | null; last_name?: string | null } | null | undefined,
): string | null {
  if (!p) return null;
  const t = `${limpiar(p.first_name) ?? ""} ${limpiar(p.last_name) ?? ""}`.trim();
  return t.length > 0 ? t : null;
}

function nombreDerivante(
  p: { nombre?: string | null; apellido?: string | null } | null | undefined,
): string | null {
  if (!p) return null;
  const t = `${limpiar(p.nombre) ?? ""} ${limpiar(p.apellido) ?? ""}`.trim();
  return t.length > 0 ? t : null;
}

function fechaSoloDia(valor: string | null | undefined): string | null {
  const v = limpiar(valor);
  if (!v) return null;
  // Pulso manda fecha_estudio como YYYY-MM-DD; si viniera ISO, cortamos.
  return v.split("T")[0];
}

// Mapeo puro Pulso → columnas de pulso_estudios (testeable sin DB ni red).
export type EstudioMapeado = {
  pulsoId: string;
  pacienteDni: string | null;
  idLegible: string | null;
  modalidad: string | null;
  tipoEstudio: string | null;
  sedeNombre: string | null;
  estado: string | null;
  fechaEstudio: string | null;
  medicoAsignado: string | null;
  medicoDerivante: string | null;
  tieneInforme: boolean;
  informePulsoId: string | null;
  informeFirmado: boolean;
  informeFirmadoAt: Date | null;
  observaciones: string | null;
  createdAtPulso: Date | null;
  updatedAtPulso: Date | null;
};

export function mapPulsoEstudio(e: PulsoEstudio): EstudioMapeado {
  const firmadoAt = limpiar(e.informe?.firmado_at);
  return {
    pulsoId: e.id,
    pacienteDni: limpiar(e.paciente?.dni),
    idLegible: limpiar(e.id_legible),
    modalidad: limpiar(e.modalidad ?? e.tipo_estudio?.modalidad),
    tipoEstudio: limpiar(e.tipo_estudio?.nombre),
    sedeNombre: limpiar(e.sede?.nombre),
    estado: limpiar(e.estado),
    fechaEstudio: fechaSoloDia(e.fecha_estudio),
    medicoAsignado: nombreCompleto(e.medico_asignado),
    medicoDerivante: nombreDerivante(e.medico_derivante),
    tieneInforme: Boolean(e.tiene_informe ?? e.informe),
    informePulsoId: limpiar(e.informe?.id),
    informeFirmado: Boolean(e.informe?.firmado),
    informeFirmadoAt: firmadoAt ? new Date(firmadoAt) : null,
    observaciones: limpiar(e.observaciones),
    createdAtPulso: e.created_at ? new Date(e.created_at) : null,
    updatedAtPulso: e.updated_at ? new Date(e.updated_at) : null,
  };
}

export type EstudiosSyncStats = {
  paginas: number;
  vistos: number;
  creados: number;
  actualizados: number;
  vinculados: number;
  sinPaciente: number;
  errores: number;
};

export type EstadoEstudiosSync = {
  sincronizando: boolean;
  iniciadoEn: string | null;
  terminadoEn: string | null;
  ultimoResultado: EstudiosSyncStats | null;
  ultimoError: string | null;
  ultimoModo: "incremental" | "completo" | null;
};

const estado: EstadoEstudiosSync = {
  sincronizando: false,
  iniciadoEn: null,
  terminadoEn: null,
  ultimoResultado: null,
  ultimoError: null,
  ultimoModo: null,
};

export function getEstadoEstudiosSync(): EstadoEstudiosSync {
  return { ...estado };
}

// Resuelve el paciente de Conectar para un estudio: primero por el id externo de
// Pulso (más confiable), luego por DNI. Puede ser null (estudio de un paciente
// que aún no importamos).
async function resolverPacienteId(e: PulsoEstudio, dni: string | null): Promise<number | null> {
  const externalId = limpiar(e.paciente?.id);
  if (externalId) {
    const [mapeado] = await db
      .select({ patientId: pacientesExternosTable.patientId })
      .from(pacientesExternosTable)
      .where(
        and(
          eq(pacientesExternosTable.origen, ORIGEN),
          eq(pacientesExternosTable.externalId, externalId),
        ),
      )
      .limit(1);
    if (mapeado) return mapeado.patientId;
  }
  if (dni) {
    const [existente] = await db
      .select({ id: pacientesTable.id })
      .from(pacientesTable)
      .where(eq(pacientesTable.dni, dni))
      .limit(1);
    if (existente) return existente.id;
  }
  return null;
}

async function upsertEstudio(e: PulsoEstudio): Promise<{ modo: "creado" | "actualizado"; vinculado: boolean }> {
  const m = mapPulsoEstudio(e);
  const patientId = await resolverPacienteId(e, m.pacienteDni);

  const [existente] = await db
    .select({ id: pulsoEstudiosTable.id })
    .from(pulsoEstudiosTable)
    .where(eq(pulsoEstudiosTable.pulsoId, m.pulsoId))
    .limit(1);

  const values = {
    pulsoId: m.pulsoId,
    patientId,
    pacienteDni: m.pacienteDni,
    idLegible: m.idLegible,
    modalidad: m.modalidad,
    tipoEstudio: m.tipoEstudio,
    sedeNombre: m.sedeNombre,
    estado: m.estado,
    fechaEstudio: m.fechaEstudio,
    medicoAsignado: m.medicoAsignado,
    medicoDerivante: m.medicoDerivante,
    tieneInforme: m.tieneInforme,
    informePulsoId: m.informePulsoId,
    informeFirmado: m.informeFirmado,
    informeFirmadoAt: m.informeFirmadoAt,
    observaciones: m.observaciones,
    raw: e as unknown,
    createdAtPulso: m.createdAtPulso,
    updatedAtPulso: m.updatedAtPulso,
    syncedAt: new Date(),
  };

  await db
    .insert(pulsoEstudiosTable)
    .values(values)
    .onConflictDoUpdate({
      target: pulsoEstudiosTable.pulsoId,
      set: { ...values, updatedAt: new Date() },
    });

  return { modo: existente ? "actualizado" : "creado", vinculado: patientId != null };
}

// Vincula estudios que quedaron sin paciente (patientId null) a pacientes que
// se importaron/vincularon después, matcheando por DNI. Cierra el gap del sync
// incremental: un estudio viejo fuera de la ventana no se re-visita, pero si su
// paciente aparece más tarde igual queda vinculado. Devuelve cuántos vinculó.
async function relinkEstudiosSinPaciente(log: Logger): Promise<number> {
  const res = await db.execute(sql`
    UPDATE pulso_estudios pe
    SET patient_id = p.id, updated_at = now()
    FROM pacientes p
    WHERE pe.patient_id IS NULL
      AND pe.paciente_dni IS NOT NULL
      AND p.dni = pe.paciente_dni
  `);
  const vinculados = res.rowCount ?? 0;
  if (vinculados > 0) log.info({ vinculados }, "Pulso: estudios históricos relinkeados por DNI");
  return vinculados;
}

function fechaDesde(ventanaDias: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - ventanaDias);
  return d.toISOString().split("T")[0];
}

// Sincroniza los estudios/informes de Pulso a la tabla local.
// - incremental (default): ventana rodante por fecha_desde; upsert de todo lo
//   reciente para captar firmas y cambios de estado.
// - completo: recorre todas las páginas (backfill histórico).
export async function sincronizarEstudiosPulso(opts: {
  full?: boolean;
  ventanaDias?: number;
  actor?: { id: number | null; email: string; rol: string };
  log: Logger;
}): Promise<EstudiosSyncStats> {
  const { full = false, log } = opts;
  const ventanaDias = opts.ventanaDias ?? DEFAULT_VENTANA_DIAS;
  const actor = opts.actor ?? { id: null, email: "sistema@pulso", rol: "sistema" };

  if (estado.sincronizando) {
    throw new Error("Ya hay una sincronización de estudios de Pulso en curso");
  }
  if (!pulsoConfigurado()) {
    throw new Error("Pulso no está configurado (faltan PULSO_USERNAME/PULSO_PASSWORD)");
  }

  const stats: EstudiosSyncStats = {
    paginas: 0,
    vistos: 0,
    creados: 0,
    actualizados: 0,
    vinculados: 0,
    sinPaciente: 0,
    errores: 0,
  };
  estado.sincronizando = true;
  estado.iniciadoEn = new Date().toISOString();
  estado.terminadoEn = null;
  estado.ultimoError = null;
  estado.ultimoModo = full ? "completo" : "incremental";

  const desde = full ? undefined : fechaDesde(ventanaDias);
  log.info({ modo: estado.ultimoModo, desde }, "Pulso: sync de estudios iniciada");

  try {
    let page = 1;
    let seguir = true;
    while (seguir && page <= MAX_PAGINAS) {
      const data = await fetchEstudiosPage({ page, pageSize: PAGE_SIZE, fechaDesde: desde }, log);
      stats.paginas += 1;
      const results = data.results ?? [];
      if (results.length === 0) break;

      for (const e of results) {
        stats.vistos += 1;
        if (!e.id) {
          stats.errores += 1;
          continue;
        }
        try {
          const { modo, vinculado } = await upsertEstudio(e);
          if (modo === "creado") stats.creados += 1;
          else stats.actualizados += 1;
          if (vinculado) stats.vinculados += 1;
          else stats.sinPaciente += 1;
        } catch (err) {
          stats.errores += 1;
          log.error({ err, estudioId: e.id }, "Pulso: error al sincronizar estudio");
        }
      }

      if (!data.next) seguir = false;
      page += 1;
    }

    // Cierra el gap de vinculación: estudios sin paciente cuyo DNI ya coincide
    // con un paciente importado quedan vinculados aunque estén fuera de ventana.
    try {
      stats.vinculados += await relinkEstudiosSinPaciente(log);
    } catch (err) {
      log.error({ err }, "Pulso: relink de estudios sin paciente falló");
    }

    estado.ultimoResultado = stats;
    log.info({ stats }, "Pulso: sync de estudios terminada");

    await db.insert(auditLogTable).values({
      usuarioId: actor.id,
      usuarioEmail: actor.email,
      rol: actor.rol,
      accion: "sync_pulso_estudios",
      entidad: "pulso_estudios",
      entidadId: null,
      pacienteId: null,
      detalle: { modo: estado.ultimoModo, ...stats },
    });

    return stats;
  } catch (err) {
    estado.ultimoError = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Pulso: sync de estudios falló");
    throw err;
  } finally {
    estado.sincronizando = false;
    estado.terminadoEn = new Date().toISOString();
  }
}
