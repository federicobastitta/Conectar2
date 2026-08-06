import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { klinicosReglasCie10 } from "@workspace/db";
import { logger } from "./logger";

/**
 * Seed idempotente de arranque: los 20 diagnósticos/motivos más usados por la
 * clínica (extraídos de la planilla real de Alephoo "Turnos con Diagnósticos",
 * attached_assets/turnos_segun_diagnostico_xls_(1)_1783566637146.xls, ~7.000
 * turnos), aprobados por Federico el 02/08/2026.
 *
 * El robot Klinicos usa estas reglas para el ingreso ambulatorio: si el motivo
 * del turno (normalizado) contiene el patrón, usa este diagnóstico y la
 * redacción de "Consulta por" — y NO llama a la IA.
 *
 * Reglas:
 *  - Solo inserta si la tabla está VACÍA (nunca pisa ajustes hechos a mano).
 *  - Necesario porque la base de producción (AWS) es distinta y el publish no
 *    copia datos.
 */

// [patron (normalizado), cie10, descripción, consulta_por]
export const REGLAS_CIE10_INICIALES: ReadonlyArray<readonly [string, string, string, string]> = [
  ["CONTROL GINECOLOGICO", "Z01.4", "Examen ginecológico (general) (de rutina)", "Control ginecológico"],
  ["CONTROL", "Z00.0", "Examen médico general", "Consulta de control"],
  ["CCV", "Z13.6", "Examen de pesquisa especial para trastornos cardiovasculares", "Control cardiovascular"],
  ["RECETA", "Z76.0", "Emisión de prescripción de repetición", "Renovación de receta"],
  ["PRESBICIA", "H52.4", "Presbicia", "Consulta por presbicia"],
  ["CERVICALGIA", "M54.2", "Cervicalgia", "Consulta por cervicalgia"],
  ["APTO FISICO", "Z02.5", "Examen para participación en deportes", "Certificado de apto físico"],
  ["SME GRIPAL", "J11", "Influenza, virus no identificado", "Consulta por síndrome gripal"],
  ["CUADRO GRIPAL", "J11", "Influenza, virus no identificado", "Consulta por cuadro gripal"],
  ["GRIPE", "J11", "Influenza, virus no identificado", "Consulta por cuadro gripal"],
  ["CLIMATERIO", "N95.1", "Estados menopáusicos y climatéricos femeninos", "Consulta por climaterio"],
  ["GONALGIA", "M25.5", "Dolor en articulación", "Consulta por gonalgia"],
  ["FARINGITIS", "J02.9", "Faringitis aguda, no especificada", "Consulta por faringitis"],
  ["DOLOR ABDOMINAL", "R10.4", "Otros dolores abdominales y los no especificados", "Consulta por dolor abdominal"],
  ["DOLOR AGUDO", "R52.0", "Dolor agudo", "Consulta por dolor agudo"],
  ["DOLOR", "R52", "Dolor, no clasificado en otra parte", "Consulta por dolor"],
  ["LUMBAGO", "M54.5", "Lumbago no especificado", "Consulta por lumbalgia"],
  ["LUMBALGIA", "M54.5", "Lumbago no especificado", "Consulta por lumbalgia"],
  ["BRONQUITIS", "J40", "Bronquitis, no especificada como aguda o crónica", "Consulta por bronquitis"],
  ["HTA", "I10", "Hipertensión esencial (primaria)", "Control de hipertensión arterial"],
  ["POLIARTRALGIA", "M25.5", "Dolor en articulación", "Consulta por poliartralgia"],
];

export async function seedReglasCie10(): Promise<void> {
  try {
    const [fila] = await db.select({ n: sql<number>`count(*)::int` }).from(klinicosReglasCie10);
    if ((fila?.n ?? 0) > 0) return; // ya hay reglas (cargadas o ajustadas a mano): no tocar
    // Prioridad: patrones más específicos primero (índice más bajo = evaluado antes)
    await db.insert(klinicosReglasCie10).values(
      REGLAS_CIE10_INICIALES.map(([patron, cie10Codigo, cie10Descripcion, consultaPor], i) => ({
        patron,
        cie10Codigo,
        cie10Descripcion,
        consultaPor,
        prioridad: REGLAS_CIE10_INICIALES.length - i,
        activo: true,
      })),
    );
    logger.info({ reglas: REGLAS_CIE10_INICIALES.length }, "seed diagnósticos CIE-10: reglas iniciales cargadas");
  } catch (err) {
    logger.error({ err }, "seed diagnósticos CIE-10: falló (se reintenta en el próximo arranque)");
  }
}
