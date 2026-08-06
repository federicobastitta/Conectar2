import { randomBytes } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { db, indicacionesPacientesTable } from "@workspace/db";
import { hoyArgentina } from "./tiempo";
import { encolarEnvioIndicacionApp } from "../integraciones/app-paciente-indicaciones";
import { logger } from "./logger";

export type SeccionIndicacion = "estudios" | "medicamentos" | "otrasIndicaciones";

// Las indicaciones del paciente se van formando SOLAS a medida que el médico
// carga documentos en la consulta: cada receta suma una línea a
// "medicamentos", cada orden de estudio a "estudios" y cada interconsulta a
// "otrasIndicaciones". Hay UNA indicación por paciente+profesional+día
// (índice único sobre patient_id, professional_id, fecha) y cada
// actualización reencola el push a la app del paciente (idempotente por
// codigoVerificacion: el portal hace upsert).

const t = indicacionesPacientesTable;

/**
 * Expresión SQL que agrega `linea` al final de la columna si todavía no está
 * (comparación por línea completa), de forma atómica dentro del UPDATE.
 */
function expresionAppend(col: PgColumn, linea: string): SQL {
  const salto = "\n";
  return sql`CASE
    WHEN coalesce(${col}, '') = '' THEN ${linea}
    WHEN strpos(${salto} || ${col} || ${salto}, ${salto} || ${linea} || ${salto}) > 0 THEN ${col}
    ELSE ${col} || ${salto} || ${linea}
  END`;
}

const COLUMNA: Record<SeccionIndicacion, PgColumn> = {
  estudios: t.estudios,
  medicamentos: t.medicamentos,
  otrasIndicaciones: t.otrasIndicaciones,
};

/**
 * Suma una línea a la sección indicada de la indicación del día del paciente
 * (creándola si no existe) y reencola el envío a la app. Atómico: un solo
 * INSERT ... ON CONFLICT que nunca duplica la fila del día ni pierde líneas
 * concurrentes. Nunca lanza: el documento de origen jamás debe fallar por esto.
 */
export async function agregarLineaIndicacionDelDia(params: {
  patientId: number;
  professionalId: number;
  consultationId?: number | null;
  createdBy?: number | null;
  seccion: SeccionIndicacion;
  linea: string;
}): Promise<void> {
  try {
    const linea = params.linea.trim();
    if (!linea) return;
    const col = COLUMNA[params.seccion];

    const [fila] = await db
      .insert(t)
      .values({
        patientId: params.patientId,
        professionalId: params.professionalId,
        consultationId: params.consultationId ?? null,
        [params.seccion]: linea,
        fecha: hoyArgentina(),
        verificationCode: randomBytes(10).toString("hex"),
        createdBy: params.createdBy ?? null,
      })
      .onConflictDoUpdate({
        target: [t.patientId, t.professionalId, t.fecha],
        set: { [params.seccion]: expresionAppend(col, linea) },
      })
      .returning({ id: t.id });

    await encolarEnvioIndicacionApp(fila.id, { reenviar: true });
  } catch (err) {
    logger.error({ err, patientId: params.patientId }, "indicaciones-auto: no se pudo agregar la línea");
  }
}

/**
 * Emisión manual desde la pestaña Indicaciones: si ya existe la indicación de
 * hoy (paciente+profesional) se REEMPLAZAN las secciones provistas y se
 * conservan las omitidas (undefined = conservar, null = borrar la sección).
 * Atómico vía ON CONFLICT sobre el índice único del día.
 */
export async function upsertIndicacionManualDelDia(params: {
  patientId: number;
  professionalId: number;
  consultationId?: number | null;
  createdBy?: number | null;
  estudios?: string | null;
  medicamentos?: string | null;
  otrasIndicaciones?: string | null;
}) {
  const set: Record<string, unknown> = {};
  if (params.estudios !== undefined) set["estudios"] = params.estudios;
  if (params.medicamentos !== undefined) set["medicamentos"] = params.medicamentos;
  if (params.otrasIndicaciones !== undefined) set["otrasIndicaciones"] = params.otrasIndicaciones;
  if (params.consultationId != null) set["consultationId"] = params.consultationId;

  const [fila] = await db
    .insert(t)
    .values({
      patientId: params.patientId,
      professionalId: params.professionalId,
      consultationId: params.consultationId ?? null,
      estudios: params.estudios ?? null,
      medicamentos: params.medicamentos ?? null,
      otrasIndicaciones: params.otrasIndicaciones ?? null,
      fecha: hoyArgentina(),
      verificationCode: randomBytes(10).toString("hex"),
      createdBy: params.createdBy ?? null,
    })
    .onConflictDoUpdate({
      target: [t.patientId, t.professionalId, t.fecha],
      set,
    })
    .returning();

  // creada=true si la fila conservó el código de verificación recién sorteado
  // no: el código no cambia en el UPDATE, así que comparamos por antigüedad.
  const creada = Math.abs(fila.createdAt.getTime() - Date.now()) < 5_000 && fila.id != null;
  return { fila, creada };
}

// ── Formato de las líneas ──────────────────────────────────────────────────

export function lineaReceta(r: {
  medication: string;
  dosage?: string | null;
  frequency?: string | null;
  duration?: string | null;
  instructions?: string | null;
}): string {
  return `- ${r.medication}${r.dosage ? ` ${r.dosage}` : ""}${r.frequency ? ` — ${r.frequency}` : ""}${r.duration ? ` — durante ${r.duration}` : ""}${r.instructions ? ` (${r.instructions})` : ""}`;
}

export function lineaOrdenEstudio(o: { studyName: string; preparationRequired?: string | null }): string {
  return `- ${o.studyName}${o.preparationRequired ? ` (preparación: ${o.preparationRequired})` : ""}`;
}

export function lineaInterconsulta(d: { targetSpecialty: string; reason?: string | null }): string {
  return `- Interconsulta con ${d.targetSpecialty}${d.reason ? ` — ${d.reason}` : ""}`;
}
